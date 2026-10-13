#!/usr/bin/env node
/**
 * test/pixiv-web-login.mjs —— Pixiv 网页会话登录（无头浏览器，自动写入会话文件）
 *
 * 为什么需要它：
 *   Pixiv App API 已废除 password 授权（实测 invalid_grant），账号密码只能走网页登录；
 *   且网页会话能访问需登录的接口（例如 R-18 作品的 ajax 图片地址——未登录时为 null）。
 *
 * 出网方式（关键）：
 *   实测 Chromium 直连 SOCKS5 报 ERR_SOCKS_CONNECTION_FAILED，而本项目自研 SOCKS5 能通；
 *   因此本脚本先起一个**本地 HTTP CONNECT 代理桥**（src/net/socks-bridge.js），
 *   让 Chromium 只面对「本地 HTTP 代理」，握手交给自研实现。
 *
 * 多代理轮试：
 *   公开代理极不稳定（探测通过后几秒就可能死）。可传 `--proxies <候选文件>`，
 *   脚本逐个尝试（每个代理独立起桥 + 独立浏览器），成功即写入会话并退出。
 *
 * 凭据处理：只从 .env / 环境变量读取，**不落盘、不回显**；产物只有 Cookie 文件（0600）。
 *
 * 用法：
 *   node test/pixiv-web-login.mjs                      # 用 .env 里的 PXREPO_PROXY
 *   node test/pixiv-web-login.mjs --proxies <文件>      # 逐个试候选代理（每行一个）
 *
 * 退出码：0 成功；1 全部失败（留失败截图）；2 缺配置
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const configModule = require(join(ROOT, 'src', 'config.js'));
const { parseProxy } = require(join(ROOT, 'src', 'net', 'proxy.js'));
const { startBridge } = require(join(ROOT, 'src', 'net', 'socks-bridge.js'));
const proxyState = require(join(ROOT, 'src', 'net', 'proxy-state.js'));

const DEFAULT_LOGIN_URL = 'https://accounts.pixiv.net/login?lang=zh&source=pc&view_type=page';
const PER_ATTEMPT_MS = Number(process.env.PXREPO_LOGIN_ATTEMPT_MS || 60000);

/** 读取本机浏览器环境记录（chrome/playwright/运行库/字体） */
function readBrowserEnv() {
  const file = process.env.DSH_BROWSER_ENV || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'browser-env.json') : '');
  if (file && existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* 回退环境变量 */ }
  }
  return {};
}

/** 挑一个可用的完整 chrome（headless-shell 风控更严，优先完整版） */
function pickChrome(env) {
  return [
    process.env.PXREPO_CHROME,
    env.fullChrome,
    env.pwroot ? join(env.pwroot, 'browsers', 'chromium-1243', 'chrome-linux64', 'chrome') : '',
    env.chrome,
  ].filter(Boolean).find((p) => existsSync(p)) || '';
}

/** 依次尝试多个选择器，返回第一个可见的 */
async function firstVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const locator = page.locator(sel).first();
      try {
        if (await locator.isVisible({ timeout: 500 })) return locator;
      } catch { /* 下一个 */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

/** 解析代理候选：--proxies 文件 > PXREPO_PROXY（支持逗号分隔） */
function resolveProxyList(cfg, argv) {
  const fileIndex = argv.indexOf('--proxies');
  if (fileIndex >= 0 && argv[fileIndex + 1]) {
    const file = resolve(argv[fileIndex + 1]);
    if (!existsSync(file)) return { list: [], error: `候选文件不存在：${file}` };
    const list = readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : `socks5h://${line}`));
    return { list, error: '' };
  }
  const raw = process.env.PXREPO_PROXY || cfg.proxy || '';
  return { list: raw.split(',').map((s) => s.trim()).filter(Boolean), error: '' };
}

/** 用指定代理尝试一次登录 */
async function attemptLogin({ proxy, chromium, chrome, userId, password, loginUrl, shotFile }) {
  let bridge = null;
  let browser = null;
  try {
    if (proxy) {
      const upstream = parseProxy(proxy);
      if (!upstream) return { ok: false, reason: `无法解析代理：${proxy}`, shotFile };
      bridge = await startBridge({ upstream, timeoutMs: 15000 });
    }
    browser = await chromium.launch({
      executablePath: chrome,
      args: ['--no-sandbox', '--disable-gpu', ...(bridge ? [`--proxy-server=http://127.0.0.1:${bridge.port}`] : [])],
    });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const userInput = await firstVisible(page, ['input[autocomplete="username"]', 'input[name="pixiv_id"]', '#login_id', 'input[type="text"]'], 20000);
    const passInput = await firstVisible(page, ['input[type="password"]', 'input[name="password"]'], 10000);
    if (!userInput || !passInput) {
      await page.screenshot({ path: shotFile }).catch(() => {});
      return { ok: false, reason: `找不到登录输入框（当前页 ${page.url()}，可能被风控/需验证码）`, shotFile };
    }
    await userInput.fill(userId);
    await passInput.fill(password);
    await passInput.press('Enter').catch(() => {});
    await page.waitForTimeout(1500);
    const submitBtn = await firstVisible(page, ['button[type="submit"]'], 1200);
    if (submitBtn) await submitBtn.click().catch(() => {});

    const deadline = Date.now() + 30000;
    let cookies = [];
    while (Date.now() < deadline) {
      cookies = await context.cookies();
      if (cookies.some((c) => c.name === 'PHPSESSID' && c.value)) break;
      await page.waitForTimeout(800);
    }
    const sessionCookie = cookies.find((c) => c.name === 'PHPSESSID' && c.value);
    if (!sessionCookie) {
      await page.screenshot({ path: shotFile }).catch(() => {});
      return { ok: false, reason: `未拿到会话 Cookie（当前页 ${page.url()}）`, shotFile };
    }
    return { ok: true, reason: '', cookies, url: page.url(), shotFile };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err).slice(0, 140), shotFile };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (bridge) await bridge.close().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const browserEnv = readBrowserEnv();
  const cfg = configModule.load();
  const userId = process.env.PXREPO_PIXIV_ID || cfg.pixivId || '';
  const password = process.env.PXREPO_PIXIV_PASSWORD || cfg.pixivPassword || '';
  const loginUrl = process.env.PXREPO_LOGIN_URL || DEFAULT_LOGIN_URL;

  if (!userId || !password) {
    console.error('[login] 缺少凭据：请在 .env 配置 PXREPO_PIXIV_ID / PXREPO_PIXIV_PASSWORD');
    process.exit(2);
  }
  const pwRoot = process.env.PXREPO_PWROOT || browserEnv.pwroot || '';
  const pwEntry = pwRoot ? join(pwRoot, 'node_modules', 'playwright', 'index.mjs') : '';
  const chrome = pickChrome(browserEnv);
  if (!existsSync(pwEntry) || !chrome) {
    console.error(`[login] 浏览器环境不完整：playwright=${pwEntry || '(缺)'} chrome=${chrome || '(缺)'}（可用 PXREPO_PWROOT / PXREPO_CHROME 指定）`);
    process.exit(2);
  }
  if (browserEnv.libs) process.env.LD_LIBRARY_PATH = `${browserEnv.libs}:${process.env.LD_LIBRARY_PATH || ''}`;
  if (browserEnv.fontconf) process.env.FONTCONFIG_FILE = browserEnv.fontconf;
  process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || join(tmpdir(), 'pxrepo-xdg-data');
  process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(tmpdir(), 'pxrepo-xdg-config');

  const { list, error } = resolveProxyList(cfg, argv);
  if (error) { console.error(`[login] ${error}`); process.exit(2); }

  // 学习型轮换（借鉴 iwara 的候选轮换）：GOOD 优先 → 未失败过的 → 最近失败过的排最后
  const stateFile = proxyState.stateFileFor(cfg);
  const learned = proxyState.orderCandidates(list, proxyState.loadState(stateFile));
  const proxies = learned.ordered.length ? learned.ordered : [''];

  const stateDir = cfg.stateDir || join(cfg.dataRoot || ROOT, '.pxrepo');
  mkdirSync(stateDir, { recursive: true });
  const sessionFile = join(stateDir, 'web-session.json');
  const shotFile = join(stateDir, 'login-failure.png');

  const { chromium } = await import(pathToFileURL(pwEntry).href);
  console.log(`[login] 浏览器：${chrome}`);
  console.log(`[login] 代理候选：${proxies.length} 个（每个最多 ${Math.round(PER_ATTEMPT_MS / 1000)}s）`);
  console.log(`[login] 学习状态：GOOD ${learned.goodCount} 优先｜最近失败 ${learned.badCount} 排最后｜状态文件 ${stateFile}`);

  for (let i = 0; i < proxies.length; i++) {
    const proxy = proxies[i];
    const tag = `[${i + 1}/${proxies.length}]`;
    console.log(`\n[login] ${tag} 尝试：${proxy || '（直连）'}`);
    const started = Date.now();
    const result = await Promise.race([
      attemptLogin({ proxy, chromium, chrome, userId, password, loginUrl, shotFile }),
      new Promise((r) => setTimeout(() => r({ ok: false, reason: `本次尝试超时（${Math.round(PER_ATTEMPT_MS / 1000)}s）`, shotFile }), PER_ATTEMPT_MS)),
    ]);
    const cost = ((Date.now() - started) / 1000).toFixed(1);
    if (!result.ok) {
      console.log(`[login] ${tag} 失败（${cost}s）：${result.reason}`);
      proxyState.markBad(stateFile, proxy, result.reason);
      continue;
    }
    proxyState.markGood(stateFile, proxy);
    writeFileSync(sessionFile, `${JSON.stringify({ savedAt: new Date().toISOString(), via: proxy || 'direct', url: result.url, cookies: result.cookies }, null, 2)}\n`, 'utf8');
    chmodSync(sessionFile, 0o600);
    const sessionCookie = result.cookies.find((c) => c.name === 'PHPSESSID');
    console.log(`[login] ✓ 成功（${cost}s）：会话已写入 ${sessionFile}`);
    console.log(`[login]    Cookie 项：${result.cookies.map((c) => c.name).join(', ')}（PHPSESSID 长度 ${sessionCookie ? sessionCookie.value.length : 0}）`);
    console.log(`[login]    登录后页面：${result.url}`);
    console.log('[login] 下一步：node cli.js -p <PID>（自动走网页会话）或 node test/pixiv-web-download.mjs <PID>');
    return 0;
  }

  console.error(`\n[login] 全部 ${proxies.length} 个代理都没成功。最后失败截图：${shotFile}`);
  console.error('[login] 建议：换一个稳定代理（.env 的 PXREPO_PROXY），或用 --proxies 传更多候选');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[login] 未捕获异常:', err && err.stack || err);
    process.exit(1);
  });
