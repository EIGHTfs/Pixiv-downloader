'use strict';
/**
 * src/download/engine.js —— 下载引擎（零依赖）
 *
 * 能力：
 *   - 并发队列（opts.concurrency）：共享游标的 worker 池，不做「每任务一个 Promise」的爆量写法
 *   - 断点续传：目标文件先写 `<savePath>.tmp`；已存在则用 Range 从断点续（服务器不支持 Range 时自动重下）
 *   - 完整性校验：`content-length` 与落盘字节数**严格数字比较**；HTML 反爬页识别
 *   - 失败可恢复：校验不过时**保留 .tmp**（续传基础）；HTML 垃圾则改名 `.bad` 留档（不删）
 *   - 跨进程锁：同一目标文件被别的进程下载时跳过（避免重复下载/写坏文件）
 *   - 进度上报：把字节进度回调给进度条（src/util/progress.js）
 *   - dryrun：只产出计划，不发请求、不落盘
 *
 * 结构：`downloadOne` 只做流程编排，细节拆成四个小函数——
 *   resolveResumeOffset（断点判定）/ buildRequestHeaders（请求头）/ streamToTmp（写盘+进度）/ commitDownload（校验+落盘）
 *
 * 与旧实现的差别（旧代码问题见方案「18 项缺陷清单」）：
 *   - 不再用 content-length 与 statSync().size 做宽松相等比较（字符串 vs 数字）
 *   - 不再「下载失败静默丢弃」，失败项统一进 failedList 并保留续传基础
 *   - 不再把 404 页面当图片存下来（HTML 检测）
 */

const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { acquireLock } = require('../util/lock.js');

const HTML_SNIFF = /^\s*(<!doctype html|<html|<\?xml|<head)/i; // 反爬/错误页特征（正常图片不会以这些开头）
const SNIFF_BYTES = 256;   // 嗅探头部字节数
const REASON_MAX_CHARS = 120; // 失败原因截断长度（日志可读性）

/** 速度计：按 1 秒滑动窗口估算瞬时速度（字节/秒） */
function createSpeedMeter() {
  let windowStart = Date.now();
  let windowBytes = 0;
  let speed = 0;
  return {
    add(bytes) {
      windowBytes += bytes;
      const now = Date.now();
      const elapsed = now - windowStart;
      if (elapsed >= 1000) {
        speed = (windowBytes * 1000) / elapsed;
        windowStart = now;
        windowBytes = 0;
      }
      return speed;
    },
    get value() { return speed; },
  };
}

/** 目标文件是否已存在且大小符合预期 */
function isAlreadyDone(savePath, expectSize) {
  try {
    const size = fs.statSync(savePath).size;
    if (!size) return false;
    if (Number.isFinite(expectSize) && expectSize > 0) return size === expectSize;
    return true; // 大小未知时：非空即认为已完成（配合上层「存在即跳过」策略）
  } catch {
    return false;
  }
}

/** 读取文件头部若干字节（用于 HTML 嗅探） */
function sniffHead(file, bytes = SNIFF_BYTES) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    fs.closeSync(fd);
    return buf.subarray(0, read).toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 断点判定：返回续传起点（0 = 从头写）
 * 若 .tmp 比预期还大（脏数据），顺手截断为 0，避免拼出坏文件
 */
function resolveResumeOffset(tmpPath, expectSize) {
  if (!fs.existsSync(tmpPath)) return 0;
  const tmpSize = fs.statSync(tmpPath).size;
  const oversize = Number.isFinite(expectSize) && expectSize > 0 && tmpSize > expectSize;
  if (oversize) {
    fs.truncateSync(tmpPath, 0);
    return 0;
  }
  return tmpSize;
}

/** 组装请求头：图片 CDN 需要 Referer；有断点时带 Range */
function buildRequestHeaders(task, resumeFrom) {
  const headers = {};
  if (task.referer) headers.Referer = task.referer;
  if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;
  return headers;
}

/**
 * 把响应流写入 .tmp，并上报进度
 * @returns {Promise<number>} 落盘后的总字节数
 */
async function streamToTmp({ res, tmpPath, append, resumeFrom, expectSize, label, savePath, tracker }) {
  let written = resumeFrom;
  const declared = Number(res.headers['content-length']);
  const total = Number.isFinite(expectSize) && expectSize > 0
    ? expectSize
    : (declared > 0 ? resumeFrom + declared : null);
  const meter = createSpeedMeter();

  // 用 Transform 计数（而不是给 res 挂 data 监听——那会与 pipeline 抢流）
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      written += chunk.length;
      if (tracker) {
        tracker.onProgress({
          filename: label,
          savePath,
          doneBytes: written,
          total,
          percent: total ? Math.min(100, (written / total) * 100) : 0,
          speed: meter.add(chunk.length),
          state: 'download',
        });
      }
      cb(null, chunk);
    },
  });
  await pipeline(res.res, counter, fs.createWriteStream(tmpPath, { flags: append ? 'a' : 'w' }));
  return fs.statSync(tmpPath).size;
}

/**
 * 校验并落盘
 * @returns {{status:'downloaded'|'failed', reason?:string, bytes:number}}
 */
function commitDownload({ tmpPath, savePath, expectSize }) {
  const finalSize = fs.statSync(tmpPath).size;

  // 1) HTML 反爬页识别（旧实现会把 403/404 页面当图片存下来）
  const head = sniffHead(tmpPath);
  if (HTML_SNIFF.test(head)) {
    const badPath = `${tmpPath}.bad`;
    try { fs.renameSync(tmpPath, badPath); } catch { /* 改名失败不影响判定 */ }
    return { status: 'failed', bytes: finalSize, reason: `响应是网页而非文件（已留档 ${path.basename(badPath)}）` };
  }

  // 2) 大小校验：严格数字比较（旧实现用字符串 == 数字）
  if (Number.isFinite(expectSize) && expectSize > 0 && finalSize !== expectSize) {
    return { status: 'failed', bytes: finalSize, reason: `大小不符（期望 ${expectSize}，实际 ${finalSize}），已保留 .tmp 供续传` };
  }
  if (finalSize === 0) {
    return { status: 'failed', bytes: 0, reason: '下载到 0 字节' };
  }

  // 3) 原子落盘
  fs.renameSync(tmpPath, savePath);
  return { status: 'downloaded', bytes: finalSize };
}

/** 统一收尾：记进度 + 返回结果 */
function finish(tracker, label, status, payload = {}) {
  if (tracker) tracker.onFinish(label, status === 'downloaded' || status === 'existed' ? status : 'failed');
  return { status, bytes: 0, ...payload };
}

/**
 * 处理非 2xx 响应（404/403/416/其它）
 * @returns {{status:string, bytes:number, reason?:string}}
 */
function handleErrorStatus({ status, tmpPath, savePath, expectSize, label, tracker }) {
  if (status === 404 || status === 410) {
    return finish(tracker, label, 'failed', { reason: `HTTP ${status}（作品可能已删除）` });
  }
  if (status === 416) {
    // 请求范围不可满足：.tmp 已不小于目标长度 → 按大小判定能否直接落盘，否则重置
    const size = fs.existsSync(tmpPath) ? fs.statSync(tmpPath).size : 0;
    if (Number.isFinite(expectSize) && size === expectSize) {
      fs.renameSync(tmpPath, savePath);
      if (tracker) tracker.onFinish(label, 'downloaded');
      return { status: 'downloaded', bytes: size };
    }
    if (fs.existsSync(tmpPath)) fs.truncateSync(tmpPath, 0);
    return finish(tracker, label, 'failed', { reason: 'HTTP 416（断点数据与目标不一致，已重置 .tmp）' });
  }
  return finish(tracker, label, 'failed', { reason: `HTTP ${status}` });
}

/**
 * 下载单个任务
 * @param {{url:string, savePath:string, referer?:string, expectSize?:number, label?:string}} task
 * @param {object} ctx { http, tracker, lockDir, dryrun, timeoutMs, onEvent }
 * @returns {Promise<{status:'downloaded'|'existed'|'failed'|'planned'|'locked', bytes:number, reason?:string}>}
 */
async function downloadOne(task, ctx) {
  const label = task.label || path.basename(task.savePath);
  const { http, tracker, lockDir, dryrun, onEvent } = ctx;

  if (dryrun) {
    if (onEvent) onEvent({ type: 'plan', label, url: task.url, savePath: task.savePath, expectSize: task.expectSize });
    return { status: 'planned', bytes: 0 };
  }

  // 1) 已完成 → 跳过（不浪费一次请求）
  if (isAlreadyDone(task.savePath, task.expectSize)) {
    return finish(tracker, label, 'existed');
  }

  // 2) 跨进程锁（可选）：同一文件被别的进程下载中则跳过
  let lock = null;
  if (lockDir) {
    lock = acquireLock(task.savePath, lockDir);
    if (!lock) {
      if (onEvent) onEvent({ type: 'locked', label });
      return finish(tracker, label, 'existed'); // 别处在下 → 对本进程等价于「已处理」
    }
  }

  const tmpPath = `${task.savePath}.tmp`;
  try {
    fs.mkdirSync(path.dirname(task.savePath), { recursive: true });
    const resumeFrom = resolveResumeOffset(tmpPath, task.expectSize);
    const res = await http.stream(task.url, {
      headers: buildRequestHeaders(task, resumeFrom),
      timeoutMs: ctx.timeoutMs,
    });

    if (res.status !== 200 && res.status !== 206) {
      return handleErrorStatus({ status: res.status, tmpPath, savePath: task.savePath, expectSize: task.expectSize, label, tracker });
    }

    // 服务器忽略 Range（返回 200）→ 必须从头写，否则会拼出坏文件
    const append = res.status === 206 && resumeFrom > 0;
    if (!append && fs.existsSync(tmpPath)) fs.truncateSync(tmpPath, 0);

    const written = await streamToTmp({
      res,
      tmpPath,
      append,
      resumeFrom: append ? resumeFrom : 0,
      expectSize: task.expectSize,
      label,
      savePath: task.savePath,
      tracker,
    });
    const committed = commitDownload({ tmpPath, savePath: task.savePath, expectSize: task.expectSize });
    if (tracker) tracker.onFinish(label, committed.status === 'downloaded' ? 'downloaded' : 'failed');
    return { ...committed, bytes: committed.bytes || written };
  } catch (err) {
    return finish(tracker, label, 'failed', { reason: String(err && err.message || err).slice(0, REASON_MAX_CHARS) });
  } finally {
    if (lock) lock.release();
  }
}

/** 并发 worker 池（共享游标，任务数远大于并发数时也不会爆内存） */
async function runPool(items, limit, worker) {
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  let cursor = 0;
  const runners = Array.from({ length: size }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index); // worker 内部自行 catch，不会中断池子
    }
  });
  await Promise.all(runners);
}

/**
 * 批量下载
 * @param {Array<object>} tasks 见 downloadOne
 * @param {object} opts { http, concurrency, dryrun, tracker, lockDir, timeoutMs, onEvent }
 * @returns {Promise<{downloaded:number,existed:number,failed:number,locked:number,planned:number,bytes:number,failedList:Array}>}
 */
async function downloadAll(tasks, opts = {}) {
  const result = { downloaded: 0, existed: 0, failed: 0, locked: 0, planned: 0, bytes: 0, failedList: [] };
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return result;

  await runPool(list, opts.concurrency || 1, async (task) => {
    const res = await downloadOne(task, opts);
    if (result[res.status] !== undefined) result[res.status] += 1;
    result.bytes += res.bytes || 0;
    if (res.status === 'failed') {
      result.failedList.push({ label: task.label || path.basename(task.savePath), url: task.url, reason: res.reason });
      if (opts.onEvent) opts.onEvent({ type: 'failed', label: task.label, reason: res.reason });
    }
  });
  return result;
}

module.exports = {
  downloadAll,
  downloadOne,
  runPool,
  isAlreadyDone,
  resolveResumeOffset,
  buildRequestHeaders,
  commitDownload,
  createSpeedMeter,
  HTML_SNIFF,
};
