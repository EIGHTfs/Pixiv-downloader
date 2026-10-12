#!/usr/bin/env node
/**
 * test/live-pixiv-check.mjs —— 真实网络链路检查（经代理访问 Pixiv，不涉及登录）
 *
 * 覆盖场景：
 *   1. 经代理请求公开接口 www.pixiv.net/ajax/illust/<pid> 取作品元数据（无需登录）
 *   2. 用元数据里的 original 地址经代理下载原图（带 Referer），校验 JPEG 魔数/结束标记
 *   3. 可选：与 --reference <file> 逐字节比对（SHA256），验证下载产物完全一致
 *
 * 为什么需要它：本机 Pixiv 域名被污染/封锁，必须经代理才能验证网络层；本脚本同时
 * 是「代理是否真的能用于下载」的判据——只用公开接口，不带任何账号凭据。
 *
 * 用法：
 *   PXREPO_PROXY=socks5h://ip:port node test/live-pixiv-check.mjs [--pid 87727821] [--reference .pxrepo/test-image.jpg]
 *   （代理也可写在 .env 的 PXREPO_PROXY；命令行 --proxy 优先级最高）
 *
 * 退出码：0=全部通过；1=断言失败；2=环境不具备（无代理/无网络）
 */

import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const config = require(join(ROOT, 'src', 'config.js'));
const { createHttp } = require(join(ROOT, 'src', 'net', 'http.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/** 解析命令行参数 */
function parseArgv(argv) {
  const out = { pid: '87727821', reference: null, proxy: null, out: join(ROOT, '.pxrepo', 'live-download.jpg') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pid') out.pid = argv[++i];
    else if (a === '--reference') out.reference = argv[++i];
    else if (a === '--proxy') out.proxy = argv[++i];
    else if (a === '--out') out.out = resolve(argv[++i]);
  }
  return out;
}

/** 文件 SHA256（用于逐字节一致性比对） */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));
  const cfg = config.load();
  const proxy = opts.proxy || cfg.proxy || process.env.PXREPO_PROXY || '';
  if (!proxy) {
    console.error('[live] 未配置代理：请设置 PXREPO_PROXY（如 socks5h://ip:port）或用 --proxy 传入');
    process.exit(2);
  }
  console.log(`[live] 代理=${proxy} | pid=${opts.pid} | 目标文件=${opts.out}\n`);

  const http = createHttp({ ...cfg, proxy, tps: 0, timeoutMs: 30000, retries: 1 });
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

  // ── 1. 公开接口取元数据 ────────────────────────────────────────────
  let original = null;
  try {
    const res = await http.getJson(`https://www.pixiv.net/ajax/illust/${opts.pid}`, {
      'User-Agent': UA,
      Referer: 'https://www.pixiv.net/',
    });
    assert('① ajax 接口返回 200', res.status === 200, `status=${res.status}`);
    assert('② 响应可解析为 JSON', Boolean(res.json), 'JSON 解析失败');
    original = res.json && res.json.body && res.json.body.urls && res.json.body.urls.original;
    assert('③ 取到 original 原图地址', /^https:\/\/i\.pximg\.net\//.test(String(original)), String(original).slice(0, 60));
  } catch (err) {
    assert('① ajax 接口返回 200', false, String(err.message).slice(0, 70));
    assert('② 响应可解析为 JSON', false, '未执行');
    assert('③ 取到 original 原图地址', false, '未执行');
  }

  // ── 2. 经代理下载原图并校验文件完整性 ──────────────────────────────
  if (original) {
    try {
      mkdirSync(dirname(opts.out), { recursive: true });
      const res = await http.stream(original, { headers: { Referer: 'https://www.pixiv.net/', 'User-Agent': UA } });
      assert('④ 图片响应 200', res.status === 200, `status=${res.status}`);
      await pipeline(res.res, createWriteStream(opts.out));
      const size = statSync(opts.out).size;
      const head = readFileSync(opts.out).subarray(0, 3).toString('hex').toUpperCase();
      const tail = readFileSync(opts.out).subarray(-2).toString('hex').toUpperCase();
      assert('⑤ 落盘字节数 > 0', size > 0, `size=${size}`);
      assert('⑥ JPEG 魔数正确（FFD8FF）', head === 'FFD8FF', head);
      assert('⑦ JPEG 结束标记完整（FFD9）', tail === 'FFD9', tail);
      console.log(`      → ${opts.out}（${size} 字节，SHA256 ${sha256(opts.out).slice(0, 16)}…）`);
    } catch (err) {
      assert('④ 图片响应 200', false, String(err.message).slice(0, 70));
      assert('⑤ 落盘字节数 > 0', false, '未执行');
      assert('⑥ JPEG 魔数正确（FFD8FF）', false, '未执行');
      assert('⑦ JPEG 结束标记完整（FFD9）', false, '未执行');
    }
  }

  // ── 3. 与参考文件逐字节比对（可选） ────────────────────────────────
  if (opts.reference) {
    if (!existsSync(opts.reference)) {
      assert('⑧ 与参考文件逐字节一致', false, `参考文件不存在: ${opts.reference}`);
    } else {
      const a = sha256(opts.reference);
      const b = existsSync(opts.out) ? sha256(opts.out) : '';
      assert('⑧ 与参考文件逐字节一致（SHA256）', a === b, `ref=${a.slice(0, 12)} got=${b.slice(0, 12)}`);
    }
  }

  // ── 4. 用下载引擎再走一遍（真实 CDN + 代理 + 断点/校验/落盘逻辑） ────
  // 这一段与第 2 段的区别：第 2 段只验证 http 流式层，这里验证 engine 的完整行为
  // （.tmp 写入 → 校验 → rename → 不留残渣），是最接近真实下载的端到端检查。
  if (original) {
    const engineOut = join(ROOT, '.pxrepo', 'engine-download.jpg');
    const { downloadOne } = require(join(ROOT, 'src', 'download', 'engine.js'));
    try {
      if (existsSync(engineOut)) rmSync(engineOut, { force: true });
      const res = await downloadOne(
        // 注意：i.pximg.net 缺 Referer 会 403，真实任务由 src/download/plan.js 统一带上
        { url: original, savePath: engineOut, label: 'engine-download.jpg', referer: 'https://www.pixiv.net/' },
        { http, timeoutMs: 60000 }
      );
      assert('⑨ 下载引擎经代理下载成功', res.status === 'downloaded', `${res.status}${res.reason ? ' / ' + res.reason : ''}`);
      assert('⑩ 引擎产物无 .tmp 残留', !existsSync(`${engineOut}.tmp`), '残留 .tmp');
      if (existsSync(engineOut) && existsSync(opts.out)) {
        assert('⑪ 引擎产物与流式下载结果逐字节一致', sha256(engineOut) === sha256(opts.out),
          `engine=${sha256(engineOut).slice(0, 12)} stream=${sha256(opts.out).slice(0, 12)}`);
      }
      // 再下一次：应命中「已存在即跳过」，不再发请求
      const again = await downloadOne({ url: original, savePath: engineOut, label: 'engine-download.jpg' }, { http, timeoutMs: 60000 });
      assert('⑫ 重复下载被跳过（存在即跳过）', again.status === 'existed', again.status);
    } catch (err) {
      assert('⑨ 下载引擎经代理下载成功', false, String(err.message).slice(0, 70));
      assert('⑩ 引擎产物无 .tmp 残留', false, '未执行');
      assert('⑪ 引擎产物与流式下载结果逐字节一致', false, '未执行');
      assert('⑫ 重复下载被跳过（存在即跳过）', false, '未执行');
    }
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[live] 异常:', err && err.stack || err);
  process.exit(1);
});
