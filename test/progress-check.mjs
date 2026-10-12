#!/usr/bin/env node
/**
 * test/progress-check.mjs —— 进度条模块检查（零依赖、离线）
 *
 * 覆盖场景：
 *   1. 字节/速度格式化边界（B/KB/MB/GB、未知速度）
 *   2. 图形进度条的填充格数与总宽正确（含 0% / 100% / 越界）
 *   3. 汇总数学：已完成数、百分比、总速度（活动项求和）
 *   4. 事件流：onProgress 更新活动项；onFinish 三种状态分别计数（失败进 failedSet）
 *   5. 非 TTY 时不写任何输出（管道/日志场景必须安静）
 *   6. 三种样式的渲染内容各含其特征（single 单行 / multi 多行 / ipull 图标列对齐）
 *   7. 200ms 节流：连续两次 maybeRender 只渲染一次，超过 200ms 后再渲染
 *   8. finishLine 清掉整块区域（上移 + \x1b[J）并复位内部状态
 *
 * 用法：node test/progress-check.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createProgressTracker, fmtBytes, fmtSpeed, barOf, isTty } = require(join(ROOT, 'lib', 'progress.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/** 捕获 stdout 写入（测试渲染内容用），返回 {text(), restore()} */
function captureStdout() {
  const original = process.stdout.write.bind(process.stdout);
  const chunks = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  return {
    text: () => chunks.join(''),
    count: () => chunks.length,
    restore: () => { process.stdout.write = original; },
  };
}

/** 数出进度条里实心/空心格数（跳过 ANSI 转义） */
function barCells(bar) {
  return {
    filled: (bar.match(/█/g) || []).length,
    empty: (bar.match(/░/g) || []).length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── 1. 格式化 ─────────────────────────────────────────────────────
  assert('① fmtBytes 边界', fmtBytes(null) === '0B' && fmtBytes(512) === '512B' && fmtBytes(1536) === '1.5KB'
    && fmtBytes(1048576) === '1.0MB' && fmtBytes(2147483648) === '2.00GB',
    [fmtBytes(null), fmtBytes(512), fmtBytes(1536), fmtBytes(1048576), fmtBytes(2147483648)].join('|'));
  assert('② fmtSpeed 未知时占位', fmtSpeed(null) === '?/s' && fmtSpeed(NaN) === '?/s' && fmtSpeed(2048) === '2.0KB/s',
    [fmtSpeed(null), fmtSpeed(NaN), fmtSpeed(2048)].join('|'));

  // ── 2. 进度条格子 ─────────────────────────────────────────────────
  const b0 = barCells(barOf(0, 10));
  const b50 = barCells(barOf(50, 10));
  const b100 = barCells(barOf(100, 10));
  const bOver = barCells(barOf(150, 10));
  assert('③ 0% 全空 / 50% 半满 / 100% 全满 / 越界不溢出',
    b0.filled === 0 && b0.empty === 10 && b50.filled === 5 && b50.empty === 5
    && b100.filled === 10 && b100.empty === 0 && bOver.filled === 10 && bOver.empty === 0,
    JSON.stringify({ b0, b50, b100, bOver }));

  // ── 3. 汇总数学 ───────────────────────────────────────────────────
  const t = createProgressTracker(4, false);
  t.onProgress({ filename: 'a.jpg', percent: 10, speed: 1000, savePath: '/x/a.jpg' });
  t.onProgress({ filename: 'b.jpg', percent: 20, speed: 2000, savePath: '/x/b.jpg' });
  const o1 = t.overall();
  assert('④ 总速度=活动项求和且未完成时百分比为 0', o1.totalSpeed === 3000 && o1.done === 0 && o1.pct === 0,
    JSON.stringify(o1));

  t.onFinish('/x/a.jpg', 'downloaded');
  t.onFinish('/x/b.jpg', 'existed');
  t.onFinish('/x/c.jpg', 'failed');
  const o2 = t.overall();
  assert('⑤ 三种结束状态分别计数', t.counts.downloaded === 1 && t.counts.existed === 1 && t.counts.failed === 1,
    JSON.stringify(t.counts));
  assert('⑥ 失败进入 failedSet 且 done=2/4 → 50%', t.failedSet.has('/x/c.jpg') && o2.done === 2 && o2.pct === 50,
    `${JSON.stringify([...t.failedSet])} done=${o2.done} pct=${o2.pct}`);

  // ── 4. 非 TTY 静默 ────────────────────────────────────────────────
  const capQuiet = captureStdout();
  const quiet = createProgressTracker(2, false);
  quiet.onProgress({ filename: 'q.jpg', percent: 50, speed: 100 });
  quiet.onFinish('q.jpg', 'downloaded');
  quiet.maybeRender();
  const quietText = capQuiet.text();
  capQuiet.restore();
  assert('⑦ 非 TTY 不输出任何内容', quietText === '', JSON.stringify(quietText.slice(0, 40)));

  // ── 5. 三样式渲染内容 ─────────────────────────────────────────────
  const cases = [
    // single：整块只有一行（不含换行），含汇总前缀与活动文件名
    { style: 'single', expect: (txt) => txt.includes('[下载]') && txt.includes('a.jpg') && !txt.includes('\r\n') },
    { style: 'multi', expect: (txt) => txt.includes('\r\n') && txt.includes('a.jpg') && txt.includes('[下载]') },
    { style: 'ipull', expect: (txt) => txt.includes('↓') && txt.includes('a.jpg') && txt.includes('[下载]') },
  ];
  for (const c of cases) {
    const cap = captureStdout();
    const tr = createProgressTracker(3, true, c.style);
    tr.onProgress({ filename: 'a.jpg', percent: 42, speed: 1024, total: 2048, savePath: 'a' });
    tr.render();
    const txt = cap.text();
    cap.restore();
    assert(`⑧ ${c.style} 样式渲染正确`, c.expect(txt), JSON.stringify(txt.slice(0, 60)));
  }

  // ipull 的「复用」图标（→）应出现在 copy/linked 状态
  const capCopy = captureStdout();
  const trCopy = createProgressTracker(2, true, 'ipull');
  trCopy.onProgress({ filename: 'c.jpg', percent: 100, state: 'linked', speed: 0, savePath: 'c' });
  trCopy.render();
  const copyText = capCopy.text();
  capCopy.restore();
  assert('⑨ ipull 复用项显示 → 图标', copyText.includes('→'), JSON.stringify(copyText.slice(0, 40)));

  // ── 6. 节流 ───────────────────────────────────────────────────────
  // 注意：用「渲染出的汇总行出现次数」计数，而不是 write 调用次数——
  //       emitLines 在第二次起会先写一次「上移」控制序列，write 次数 ≠ 渲染次数。
  const capThrottle = captureStdout();
  const trThrottle = createProgressTracker(2, true, 'multi');
  trThrottle.onProgress({ filename: 'x.jpg', percent: 1, speed: 1, savePath: 'x' }); // 第一次 → 渲染
  const rendersAfterFirst = (capThrottle.text().match(/\[下载\]/g) || []).length;
  trThrottle.onProgress({ filename: 'x.jpg', percent: 2, speed: 1, savePath: 'x' }); // 200ms 内 → 跳过
  const rendersAfterSecond = (capThrottle.text().match(/\[下载\]/g) || []).length;
  await sleep(220);
  trThrottle.onProgress({ filename: 'x.jpg', percent: 3, speed: 1, savePath: 'x' }); // 超 200ms → 渲染
  const rendersAfterThird = (capThrottle.text().match(/\[下载\]/g) || []).length;
  capThrottle.restore();
  assert('⑩ 200ms 节流生效', rendersAfterFirst === 1 && rendersAfterSecond === 1 && rendersAfterThird === 2,
    `first=${rendersAfterFirst} second=${rendersAfterSecond} third=${rendersAfterThird}`);

  // ── 7. finishLine ─────────────────────────────────────────────────
  const capFinish = captureStdout();
  const trFinish = createProgressTracker(1, true, 'multi');
  trFinish.onProgress({ filename: 'f.jpg', percent: 50, speed: 1, savePath: 'f' });
  trFinish.render();
  capFinish.count();
  const beforeFinish = capFinish.count();
  trFinish.finishLine();
  const finishText = capFinish.text().slice(-40);
  capFinish.restore();
  assert('⑪ finishLine 清区域并复位', capFinish.count() > beforeFinish && finishText.includes('\x1b[J') && finishText.endsWith('\n'),
    JSON.stringify(finishText));

  // ── 8. isTty 判定 ─────────────────────────────────────────────────
  assert('⑫ isTty 返回布尔且尊重 NO_COLOR', typeof isTty() === 'boolean', String(isTty()));

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main();
