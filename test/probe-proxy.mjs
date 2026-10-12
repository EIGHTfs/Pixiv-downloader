#!/usr/bin/env node
/**
 * test/probe-proxy.mjs —— 代理连通性探测（找出哪个代理能访问 Pixiv）
 *
 * 覆盖场景：
 *   1. 逐个代理做一次 HTTPS(CONNECT) 请求，判断「能否连通目标域名」
 *   2. 汇总可用代理（状态码 + 耗时），供写进 .env 的 PXREPO_PROXY
 *
 * 安全说明：
 *   - 本脚本**只发一个无凭据的探测请求**（不带 token / 不带 Cookie），因此可以安全地
 *     批量试公开代理；真正登录/下载时才会带 refresh_token，那时代理会看到流量，
 *     公开代理存在凭据被窃风险，仅建议测试用。
 *
 * 用法：
 *   node test/probe-proxy.mjs <候选文件> [--parallel 20] [--timeout 8000] [--target <url>]
 *   候选文件：每行一个代理（http://ip:port 或 ip:port），# 开头为注释
 *   默认目标：https://app-api.pixiv.net/v1/user/me/state（未鉴权应返回 401，能返回状态码即「通」）
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createHttp } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'http.js'));

/** 解析命令行参数 */
function parseArgv(argv) {
  const out = { file: null, parallel: 20, timeout: 8000, target: 'https://app-api.pixiv.net/v1/user/me/state' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--parallel') out.parallel = Number.parseInt(argv[++i], 10) || 20;
    else if (a === '--timeout') out.timeout = Number.parseInt(argv[++i], 10) || 8000;
    else if (a === '--target') out.target = argv[++i];
    else if (!a.startsWith('-')) out.file = a;
  }
  return out;
}

/** 读取候选代理（跳过注释与空行，自动补 http:// 前缀） */
function readCandidates(file) {
  const text = readFileSync(resolve(file), 'utf8');
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(l) ? l : `http://${l}`));
}

/** 探测单个代理：返回 {proxy, ok, status?, ms, error?} */
async function probe(proxy, opts) {
  const started = Date.now();
  const client = createHttp({ proxy, timeoutMs: opts.timeout, retries: 0, tps: 0 });
  try {
    const res = await client.request(opts.target, { headers: { 'User-Agent': 'pxrepo-probe' }, retries: 0 });
    return { proxy, ok: true, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { proxy, ok: false, ms: Date.now() - started, error: String(err.code || err.message).slice(0, 60) };
  }
}

/** 分批并发执行 */
async function runBatch(items, size, worker) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const slice = items.slice(i, i + size);
    results.push(...(await Promise.all(slice.map(worker))));
    process.stderr.write(`\r探测进度 ${Math.min(i + size, items.length)}/${items.length}`);
  }
  process.stderr.write('\n');
  return results;
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  if (!opts.file) {
    console.error('用法: node test/probe-proxy.mjs <候选文件> [--parallel 20] [--timeout 8000] [--target <url>]');
    process.exit(2);
  }
  const candidates = readCandidates(opts.file);
  console.log(`候选代理 ${candidates.length} 个 | 目标 ${opts.target} | 并发 ${opts.parallel} | 超时 ${opts.timeout}ms\n`);

  const results = await runBatch(candidates, opts.parallel, (p) => probe(p, opts));
  const ok = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  const failed = results.length - ok.length;

  console.log('=== 可用代理（按耗时升序） ===');
  if (!ok.length) console.log('（无）');
  for (const r of ok) console.log(`${String(r.status).padEnd(4)} ${String(r.ms + 'ms').padEnd(8)} ${r.proxy}`);

  console.log(`\n结果: ${ok.length} 可用 / ${failed} 不可用（共 ${results.length}）`);
  console.log('\n写入 .env 示例：');
  console.log(`PXREPO_PROXY=${ok.length ? ok[0].proxy : 'http://<ip>:<port>'}`);

  process.exit(ok.length ? 0 : 1);
}

main().catch((err) => {
  console.error('[probe] 异常:', err && err.stack || err);
  process.exit(1);
});
