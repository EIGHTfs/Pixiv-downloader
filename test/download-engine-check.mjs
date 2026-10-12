#!/usr/bin/env node
/**
 * test/download-engine-check.mjs —— 下载引擎检查（本地 HTTP 服务器，零依赖、不访问外网）
 *
 * 覆盖场景（每条都对应旧实现的一个真实缺陷）：
 *   1. 正常下载：字节完整落盘，.tmp 不残留
 *   2. 已完成跳过：目标文件存在且大小匹配 → 不发请求
 *   3. 断点续传：预置半个 .tmp + 服务器支持 Range(206) → 最终文件完整、且确实带了 Range 头
 *   4. 服务器忽略 Range(200 全量) → 不会把新旧数据拼接成坏文件
 *   5. 416：.tmp 已是完整长度 → 直接落盘成功（不重复下载）
 *   6. 大小不符：expectSize 与实际不符 → 失败且**保留 .tmp**（续传基础）
 *   7. HTML 反爬页：识别为网页 → 失败、无最终文件、.tmp 改名 .bad 留档（不删）
 *   8. 404：失败并给出可读原因
 *   9. 并发池：并发上限被遵守
 *  10. dryrun：不发请求、不落盘，只产出计划
 *
 * 用法：node test/download-engine-check.mjs
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createHttp } = require(join(ROOT, 'src', 'net', 'http.js'));
const { downloadAll, downloadOne } = require(join(ROOT, 'src', 'download', 'engine.js'));
const { createProgressTracker } = require(join(ROOT, 'src', 'util', 'progress.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/** 造一段可校验的二进制内容（含非 ASCII 字节，避免「文本恰好相等」的假通过） */
function payload(size, seed = 7) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + seed) % 256;
  return buf;
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** 启动测试服务器：记录请求，支持 Range / 忽略 Range / HTML / 404 / 慢响应（观测并发） */
function startServer(bodies) {
  const seen = [];
  const stats = { inflight: 0, peakInflight: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    seen.push({ path: url.pathname, range: req.headers.range || null });

    if (url.pathname === '/slow.jpg') { // 慢响应：用于观测真实并发度
      stats.inflight += 1;
      stats.peakInflight = Math.max(stats.peakInflight, stats.inflight);
      setTimeout(() => {
        stats.inflight -= 1;
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bodies['/img.jpg'].length });
        res.end(bodies['/img.jpg']);
      }, 60);
      return;
    }

    const body = bodies[url.pathname];
    if (!body) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }

    if (url.pathname === '/html.jpg') { // 反爬页伪装成 jpg
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
      res.end(body);
      return;
    }
    if (url.pathname === '/norange.jpg') { // 声明支持但忽略 Range，始终 200 全量
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
      res.end(body);
      return;
    }
    const range = req.headers.range;
    if (range) {
      const matched = /bytes=(\d+)-/.exec(range);
      const start = matched ? Number(matched[1]) : 0;
      if (start >= body.length) { res.writeHead(416); res.end(); return; }
      res.writeHead(206, {
        'content-type': 'image/jpeg',
        'content-length': body.length - start,
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      res.end(body.subarray(start));
      return;
    }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': body.length });
    res.end(body);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port, seen, stats }));
  });
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pxrepo-engine-'));
  const IMG = payload(50000);
  const HTML = Buffer.from('<!DOCTYPE html><html><body>403 Forbidden</body></html>');
  const { server, port, seen, stats } = await startServer({
    '/img.jpg': IMG,
    '/html.jpg': HTML,
    '/norange.jpg': IMG,
  });
  const base = `http://127.0.0.1:${port}`;
  const httpc = createHttp({ tps: 0, retries: 0, timeoutMs: 10000 });

  try {
    // ── 1. 正常下载 ──────────────────────────────────────────────────
    const target1 = join(dir, 'a.jpg');
    const tracker1 = createProgressTracker(1, false);
    const r1 = await downloadOne({ url: `${base}/img.jpg`, savePath: target1, expectSize: IMG.length, label: 'a.jpg' }, { http: httpc, tracker: tracker1 });
    assert('① 正常下载成功且字节一致',
      r1.status === 'downloaded' && sha(readFileSync(target1)) === sha(IMG) && !existsSync(`${target1}.tmp`),
      `${r1.status} size=${existsSync(target1) ? statSync(target1).size : '-'}`);
    assert('② 进度计数为 downloaded', tracker1.counts.downloaded === 1 && tracker1.counts.failed === 0, JSON.stringify(tracker1.counts));

    // ── 2. 已完成跳过（不应再发请求） ────────────────────────────────
    const before = seen.length;
    const r2 = await downloadOne({ url: `${base}/img.jpg`, savePath: target1, expectSize: IMG.length, label: 'a.jpg' }, { http: httpc });
    assert('③ 已完成文件被跳过且不发请求', r2.status === 'existed' && seen.length === before, `${r2.status} 请求增量=${seen.length - before}`);

    // ── 3. 断点续传 ─────────────────────────────────────────────────
    const target3 = join(dir, 'b.jpg');
    const half = Math.floor(IMG.length / 2);
    writeFileSync(`${target3}.tmp`, IMG.subarray(0, half));
    const seenBefore3 = seen.length;
    const r3 = await downloadOne({ url: `${base}/img.jpg`, savePath: target3, expectSize: IMG.length, label: 'b.jpg' }, { http: httpc });
    const rangeHeader = seen[seenBefore3] ? seen[seenBefore3].range : null;
    assert('④ 断点续传结果字节完整', r3.status === 'downloaded' && sha(readFileSync(target3)) === sha(IMG), `${r3.status}`);
    assert('⑤ 续传确实带了 Range 头', rangeHeader === `bytes=${half}-`, String(rangeHeader));

    // ── 4. 服务器忽略 Range（200 全量）→ 不能拼坏 ────────────────────
    const target4 = join(dir, 'c.jpg');
    writeFileSync(`${target4}.tmp`, IMG.subarray(0, 1000));
    const r4 = await downloadOne({ url: `${base}/norange.jpg`, savePath: target4, expectSize: IMG.length, label: 'c.jpg' }, { http: httpc });
    assert('⑥ 服务器忽略 Range 时结果仍完整', r4.status === 'downloaded' && sha(readFileSync(target4)) === sha(IMG), `${r4.status} size=${existsSync(target4) ? statSync(target4).size : '-'}`);

    // ── 5. 416：.tmp 已完整 → 直接落盘 ───────────────────────────────
    const target5 = join(dir, 'd.jpg');
    writeFileSync(`${target5}.tmp`, IMG);
    const r5 = await downloadOne({ url: `${base}/img.jpg`, savePath: target5, expectSize: IMG.length, label: 'd.jpg' }, { http: httpc });
    assert('⑦ 416 且长度匹配时直接落盘', r5.status === 'downloaded' && sha(readFileSync(target5)) === sha(IMG), `${r5.status}`);

    // ── 6. 大小不符 → 失败且保留 .tmp ────────────────────────────────
    const target6 = join(dir, 'e.jpg');
    const r6 = await downloadOne({ url: `${base}/img.jpg`, savePath: target6, expectSize: IMG.length + 999, label: 'e.jpg' }, { http: httpc });
    assert('⑧ 大小不符时失败且保留 .tmp 供续传',
      r6.status === 'failed' && !existsSync(target6) && existsSync(`${target6}.tmp`) && /大小不符/.test(String(r6.reason)),
      `${r6.status} reason=${r6.reason}`);

    // ── 7. HTML 反爬页 → 留档 .bad、无最终文件 ───────────────────────
    const target7 = join(dir, 'f.jpg');
    const r7 = await downloadOne({ url: `${base}/html.jpg`, savePath: target7, expectSize: HTML.length, label: 'f.jpg' }, { http: httpc });
    const badFiles = readdirSync(dir).filter((f) => f.startsWith('f.jpg.tmp.bad'));
    assert('⑨ HTML 反爬页被识别并留档（不落最终文件）',
      r7.status === 'failed' && !existsSync(target7) && badFiles.length === 1 && /网页/.test(String(r7.reason)),
      `${r7.status} bad=${badFiles.length} reason=${r7.reason}`);

    // ── 8. 404 ──────────────────────────────────────────────────────
    const r8 = await downloadOne({ url: `${base}/missing.jpg`, savePath: join(dir, 'g.jpg'), label: 'g.jpg' }, { http: httpc });
    assert('⑩ 404 失败且原因可读', r8.status === 'failed' && /404/.test(String(r8.reason)), `${r8.status} reason=${r8.reason}`);

    // ── 9. 并发池上限（由服务器侧统计在途请求峰值，硬证据） ──────────
    const jobs = Array.from({ length: 9 }, (_v, i) => ({
      url: `${base}/slow.jpg`,
      savePath: join(dir, `conc-${i}.jpg`),
      expectSize: IMG.length,
      label: `conc-${i}.jpg`,
    }));
    const trackerConc = createProgressTracker(jobs.length, false);
    const res9 = await downloadAll(jobs, { http: httpc, concurrency: 3, tracker: trackerConc });
    assert('⑪ 批量下载全部成功', res9.downloaded === jobs.length, JSON.stringify({ downloaded: res9.downloaded, failed: res9.failed }));
    assert('⑫ 并发上限被遵守（服务器在途峰值 ≤ 3）', stats.peakInflight > 1 && stats.peakInflight <= 3, `peak=${stats.peakInflight}`);

    // ── 10. dryrun ──────────────────────────────────────────────────
    const before10 = seen.length;
    const r10 = await downloadAll([{ url: `${base}/img.jpg`, savePath: join(dir, 'h.jpg'), expectSize: IMG.length, label: 'h.jpg' }], { http: httpc, dryrun: true });
    assert('⑬ dryrun 不发请求不落盘', r10.planned === 1 && seen.length === before10 && !existsSync(join(dir, 'h.jpg')),
      JSON.stringify({ planned: r10.planned, 请求增量: seen.length - before10 }));
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[engine-check] 异常:', err && err.stack || err);
  process.exit(1);
});
