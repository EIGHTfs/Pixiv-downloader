#!/usr/bin/env node
/**
 * test/pixiv-web-login.mjs —— Pixiv 网页会话登录（无头浏览器）
 *
 * 为什么需要它：
 *   Pixiv App API 已废除 password 授权（实测返回 invalid_grant），账号密码只能走
 *   「网页登录 → 拿会话 Cookie」。网页会话能访问需登录的接口（例如 R-18 作品的
 *   ajax 图片地址——未登录时 urls.original 为 null）。
 *
 * 凭据处理：只从环境变量读取，**不落盘、不回显**；产物只有 Cookie 文件（0600）。
 *
 * 用法：
 *   PXREPO_PIXIV_ID=<账号> PXREPO_PIXIV_PASSWORD=<密码> \
 *   PXREPO_PROXY=socks5h://ip:port node test/pixiv-web-login.mjs
 *
 * 可选环境变量：
 *   PXREPO_STATE_DIR   会话文件目录（默认与 CLI 一致）
 *   PXREPO_CHROME      指定 chromium 可执行文件（默认读 $DSH_HOME/browser-env.json）
 *   PXREPO_LOGIN_URL   登录页（默认 accounts.pixiv.net 的登录页）
 *
 * 退出码：0 成功（已写入会话文件）；1 失败（会留一张失败截图便于排查）；2 缺配置
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const configModule = require(join(ROOT, 'src', 'config.js'));

/** 读取本机浏览器环境记录（chrome/playwright/运行库/字体） */
function readBrowserEnv() {
  const file = process.env.DSH_BROWSER_ENV || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'browser-env.json') : '');
  if (file && existsSync(file)) {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { /* 回退到环境变量 */ }
  }
  return {};
}

/** 挑一个可用的完整 chrome（headless-shell 过不了部分风控，优先完整版） */
function pickChrome(env) {
  const candidates = [
    process.env.PXREPO_CHROME,
    env.fullChrome,
    env.chrome && env.chrome.includes('chrome-linux64') ? env.chrome : '',
    env.pwroot ? join(env.pwroot, 'browsers', 'chromium-1243', 'chrome-linux64', 'chrome') : '',
    env.chrome,
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || '';
}

/** 解析 stateDir（与 src/config.js 保持一致：PXREPO_STATE_DIR > 数据根/.pxrepo > 项目根/.pxrepo） */
function resolveStateDir(cfg) {
  if (process.env.PXREPO_STATE_DIR) return process.env.PXREPO_STATE_DIR;
  if (cfg && cfg.stateDir) return cfg.stateDir;
  const dataRoot = process.env.PXREPO_DATA_ROOT || (cfg && cfg.dataRoot) || '';
  return join(dataRoot || ROOT, '.pxrepo');
}

/** 依次尝试多个选择器，返回第一个可见的 */
async function firstVisible(page, selectors, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const locator = page.locator(sel).first();
      try {
        if (await locator.isVisible({ timeout: 500 })) return locator;
      } catch { /* 继续试下一个 */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function main() {
  const browserEnv = readBrowserEnv();
  // 凭据/代理优先取环境变量，其次取 .env（登录信息存 .env、不入库）
  const cfg = configModule.load();
  const proxy = process.env.PXREPO_PROXY || cfg.proxy || '';
  const userId = process.env.PXREPO_PIXIV_ID || cfg.pixivId || '';
  const password = process.env.PXREPO_PIXIV_PASSWORD || cfg.pixivPassword || '';
  const loginUrl = process.env.PXREPO_LOGIN_URL || 'https://accounts.pixiv.net/login?lang=zh&source=pc&view_type=page';

  if (!userId || !password) {
    console.error('[login] 缺少凭据：请在 .env 里配置 PXREPO_PIXIV_ID / PXREPO_PIXIV_PASSWORD（或用同名环境变量）');
    process.exit(2);
  }

  const pwRoot = process.env.PXREPO_PWROOT || browserEnv.pwroot || '';
  const pwEntry = pwRoot ? join(pwRoot, 'node_modules', 'playwright', 'index.mjs') : '';
  if (!pwEntry || !existsSync(pwEntry)) {
    console.error(`[login] 找不到 playwright：${pwEntry || '(未解析到 pwroot)'}（可用 PXREPO_PWROOT 指定）`);
    process.exit(2);
  }
  const chrome = pickChrome(browserEnv);
  if (!chrome) {
    console.error('[login] 找不到 chromium 可执行文件（可用 PXREPO_CHROME 指定）');
    process.exit(2);
  }

  // 运行库与字体（无头 chrome 在 NAS 上需要用户态库）
  if (browserEnv.libs) process.env.LD_LIBRARY_PATH = `${browserEnv.libs}:${process.env.LD_LIBRARY_PATH || ''}`;
  if (browserEnv.fontconf) process.env.FONTCONFIG_FILE = browserEnv.fontconf;
  process.env.XDG_DATA_HOME = process.env.XDG_DATA_HOME || join(tmpdir(), 'pxrepo-xdg-data');
  process.env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(tmpdir(), 'pxrepo-xdg-config');

  const { chromium } = await import(pathToFileURL(pwEntry).href);
  const launchOptions = { executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'] };
  if (proxy) {
    // Playwright 支持 socks5；socks5h 的 h（远端解析）由 Playwright 的 socks5 代理实现覆盖
    launchOptions.proxy = { server: proxy.replace(/^socks5h:/i, 'socks5:') };
  }

  const stateDir = resolveStateDir(cfg);
  mkdirSync(stateDir, { recursive: true });
  const sessionFile = join(stateDir, 'web-session.json');
  const shotFile = join(stateDir, 'login-failure.png');

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log(`[login] 打开登录页…${proxy ? `（代理 ${proxy}）` : '（无代理）'}`);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const userInput = await firstVisible(page, ['input[autocomplete="username"]', 'input[name="pixiv_id"]', '#login_id', 'input[type="text"]'], 30000);
    const passInput = await firstVisible(page, ['input[type="password"]', 'input[name="password"]'], 10000);
    if (!userInput || !passInput) {
      await page.screenshot({ path: shotFile }).catch(() => {});
      console.error(`[login] 找不到登录输入框（页面可能是验证码/风控页）；已截图：${shotFile}`);
      return 1;
    }

    await userInput.fill(userId);
    await passInput.fill(password);
    console.log('[login] 已填凭据，提交…');
    await passInput.press('Enter').catch(() => {});
    await page.waitForTimeout(2000);
    const submitBtn = await firstVisible(page, ['button[type="submit"]'], 1500);
    if (submitBtn) await submitBtn.click().catch(() => {});

    // 等跳转或会话 Cookie 出现
    const deadline = Date.now() + 45000;
    let cookies = [];
    while (Date.now() < deadline) {
      cookies = await context.cookies();
      if (cookies.some((c) => c.name === 'PHPSESSID' && c.value)) break;
      await page.waitForTimeout(1000);
    }
    const php = cookies.find((c) => c.name === 'PHPSESSID' && c.value);
    if (!php) {
      await page.screenshot({ path: shotFile }).catch(() => {});
      const title = await page.title().catch(() => '');
      console.error(`[login] 未拿到会话 Cookie（当前页：${page.url()}｜标题：${title}）`);
      console.error(`[login] 常见原因：需要人机验证 / 密码错误 / 账号异常。已截图：${shotFile}`);
      return 1;
    }

    writeFileSync(sessionFile, `${JSON.stringify({ savedAt: new Date().toISOString(), url: page.url(), cookies }, null, 2)}\n`, 'utf8');
    chmodSync(sessionFile, 0o600);
    console.log(`[login] ✓ 登录成功：PHPSESSID 已获取（长度 ${php.value.length}）`);
    console.log(`[login] 会话已保存（0600）：${sessionFile}`);
    console.log(`[login] 当前页面：${page.url()}`);
    console.log(`[login] Cookie 项：${cookies.map((c) => c.name).join(', ')}`);
    return 0;
  } catch (err) {
    await page.screenshot({ path: shotFile }).catch(() => {});
    console.error(`[login] 异常：${String(err && err.message || err).slice(0, 200)}`);
    console.error(`[login] 已截图：${shotFile}`);
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[login] 未捕获异常:', err && err.stack || err);
    process.exit(1);
  });
