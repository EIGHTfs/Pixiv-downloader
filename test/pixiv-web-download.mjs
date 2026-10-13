#!/usr/bin/env node
/**
 * test/pixiv-web-download.mjs —— 用网页会话按 PID 下载（支持 R-18 等需登录作品）
 *
 * 为什么需要它：Pixiv 对未登录请求隐藏 R-18 作品的图片地址（`urls.original` 为 null）。
 * 先用 `node test/pixiv-web-login.mjs` 拿到网页会话（`<状态目录>/web-session.json`），
 * 本脚本用该会话 Cookie 调 ajax 取原图地址，再交给项目的下载引擎落盘。
 *
 * 用法：
 *   node test/pixiv-web-download.mjs <pid> [<pid>...] [--out <目录>] [--dryrun]
 *
 * 说明：
 *   - 目录/命名与 CLI 一致：`<数据根>/(UID)画师名/(PID)标题_pN.ext`
 *   - 图片 CDN 只需 Referer（不需要 Cookie）；Cookie 仅用于 ajax 接口
 *   - 不打印任何凭据；会话文件权限 0600
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const configModule = require(join(ROOT, 'src', 'config.js'));
const { createHttp } = require(join(ROOT, 'src', 'net', 'http.js'));
const { downloadAll } = require(join(ROOT, 'src', 'download', 'engine.js'));
const names = require(join(ROOT, 'src', 'util', 'names.js'));

const REFERER = 'https://www.pixiv.net/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 解析命令行 */
function parseArgv(argv) {
  const out = { pids: [], out: null, dryrun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--dryrun') out.dryrun = true;
    else if (!a.startsWith('-')) out.pids.push(a);
  }
  return out;
}

/** 读取网页会话 Cookie（不存在返回空） */
function readSessionCookies(stateDir) {
  const file = join(stateDir, 'web-session.json');
  if (!existsSync(file)) return { file, header: '', count: 0 };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    const header = cookies.filter((c) => c && c.name).map((c) => `${c.name}=${c.value}`).join('; ');
    return { file, header, count: cookies.length };
  } catch {
    return { file, header: '', count: 0 };
  }
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (!opts.pids.length) {
    console.error('用法: node test/pixiv-web-download.mjs <pid> [<pid>...] [--out <目录>] [--dryrun]');
    process.exit(2);
  }
  const cfg = configModule.load();
  const dataRoot = opts.out ? resolve(opts.out) : cfg.dataRoot;
  if (!dataRoot) {
    console.error('缺少下载目录：用 --out 指定，或在 .env 配置 PXREPO_DATA_ROOT');
    process.exit(2);
  }

  const session = readSessionCookies(cfg.stateDir);
  if (!session.header) {
    console.error(`没有可用的网页会话：${session.file}`);
    console.error('请先执行：node test/pixiv-web-login.mjs');
    process.exit(2);
  }
  console.log(`[web] 会话：${session.count} 个 Cookie（${session.file}）`);
  console.log(`[web] 代理：${cfg.proxy || '（直连）'}｜输出根目录：${dataRoot}`);

  const http = createHttp(cfg);
  const cookieHeaders = { 'User-Agent': UA, Referer: REFERER, Cookie: session.header };

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (const pid of opts.pids) {
    console.log(`\n[web] === PID ${pid} ===`);
    let meta;
    try {
      const res = await http.getJson(`https://www.pixiv.net/ajax/illust/${pid}`, cookieHeaders);
      meta = res.json && res.json.body;
      if (!meta) throw new Error('接口未返回 body');
    } catch (err) {
      console.error(`[web] 取作品信息失败：${String(err && err.message || err).slice(0, 120)}`);
      totalFailed++;
      continue;
    }
    console.log(`[web] ${meta.title}｜画师 ${meta.userName}（uid ${meta.userId}）｜${meta.pageCount} 页｜xRestrict=${meta.xRestrict}`);

    let urls = [];
    try {
      const res = await http.getJson(`https://www.pixiv.net/ajax/illust/${pid}/pages`, cookieHeaders);
      urls = ((res.json && res.json.body) || []).map((p) => p.urls && p.urls.original).filter(Boolean);
    } catch (err) {
      console.error(`[web] 取图片地址失败：${String(err && err.message || err).slice(0, 120)}`);
      totalFailed++;
      continue;
    }
    if (!urls.length) {
      console.error('[web] 仍未拿到图片地址（会话可能已失效，请重新登录）');
      totalFailed++;
      continue;
    }

    const dir = join(dataRoot, names.illustratorDirName(meta.userId, meta.userName));
    const tasks = urls.map((url, index) => {
      const fileName = names.illustFileName({ id: pid, title: meta.title, page: index, ext: names.extFromUrl(url) });
      return { url, savePath: join(dir, fileName), label: fileName, referer: REFERER };
    });
    console.log(`[web] 目录：${dir}`);
    tasks.forEach((t) => console.log(`[web]   → ${t.label}`));

    if (opts.dryrun) continue;
    const result = await downloadAll(tasks, { http, concurrency: cfg.concurrency, timeoutMs: cfg.timeoutMs });
    totalDownloaded += result.downloaded;
    totalFailed += result.failed;
    console.log(`[web] 完成：新 ${result.downloaded}｜跳过 ${result.existed}｜失败 ${result.failed}｜${(result.bytes / 1048576).toFixed(2)} MB`);
    for (const f of result.failedList) console.error(`[web] 失败项 ${f.label}：${f.reason}`);
  }

  console.log(`\n[web] 汇总：新下载 ${totalDownloaded}｜失败 ${totalFailed}`);
  process.exit(totalFailed ? 1 : 0);
}

main().catch((err) => {
  console.error('[web] 异常:', err && err.stack || err);
  process.exit(1);
});
