#!/usr/bin/env node
/**
 * test/proxy-state-check.mjs —— 代理学习状态检查（零依赖、离线）
 *
 * 覆盖场景：
 *   1. 无历史时保持调用方给定顺序
 *   2. 成功过的代理（GOOD）优先，且越新越靠前
 *   3. 失败的代理排到最后，并从 GOOD 移除
 *   4. BAD 过期（超过 TTL）后回到正常位置，允许再试
 *   5. 状态持久化：写文件 → 重新读取一致
 *   6. 脏数据容错：坏 JSON / 结构异常不抛错
 *
 * 用法：node test/proxy-state-check.mjs
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const state = require(join(ROOT, 'src', 'net', 'proxy-state.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pxrepo-pstate-'));
  const file = join(dir, 'proxy-state.json');
  const list = ['p1', 'p2', 'p3', 'p4'];
  try {
    // 1. 无历史 → 原顺序
    const base = state.orderCandidates(list, state.loadState(file));
    assert('① 无历史时保持原顺序', base.ordered.join(',') === 'p1,p2,p3,p4', base.ordered.join(','));

    // 2. GOOD 优先（新→旧）
    state.markGood(file, 'p3');
    state.markGood(file, 'p2');
    const withGood = state.orderCandidates(list, state.loadState(file));
    assert('② GOOD 优先且新→旧', withGood.ordered.slice(0, 2).join(',') === 'p2,p3', withGood.ordered.join(','));
    assert('③ 统计 GOOD 数量', withGood.goodCount === 2, String(withGood.goodCount));

    // 3. BAD 排最后且从 GOOD 移除
    state.markBad(file, 'p2', '握手超时');
    const withBad = state.orderCandidates(list, state.loadState(file));
    assert('④ 失败项排到最后', withBad.ordered[withBad.ordered.length - 1] === 'p2', withBad.ordered.join(','));
    assert('⑤ 失败项已从 GOOD 移除', withBad.goodCount === 1 && withBad.ordered[0] === 'p3', withBad.ordered.join(','));

    // 4. BAD 过期后允许再试（用未来时间点模拟过期）
    const later = Date.now() + state.BAD_TTL_MS + 1000;
    const expired = state.orderCandidates(list, state.loadState(file), later);
    assert('⑥ BAD 过期后回到正常位置', expired.ordered.indexOf('p2') < expired.ordered.length - 1, expired.ordered.join(','));

    // 5. 持久化
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    assert('⑦ 状态已持久化（含 good/bad 与时间戳）',
      Array.isArray(onDisk.good) && onDisk.bad && onDisk.bad.p2 && Number(onDisk.bad.p2.at) > 0,
      JSON.stringify(onDisk).slice(0, 120));

    // 6. 脏数据容错
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ 不是 JSON', 'utf8');
    const weird = join(dir, 'weird.json');
    writeFileSync(weird, JSON.stringify({ good: 'not-array', bad: 42 }), 'utf8');
    assert('⑧ 坏 JSON / 结构异常不抛错',
      state.loadState(broken).good.length === 0 && state.loadState(weird).good.length === 0
      && Object.keys(state.loadState(weird).bad).length === 0, '脏数据未兜底');
    assert('⑨ 候选为空时不崩', state.orderCandidates([], state.loadState(file)).ordered.length === 0, '空输入异常');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main();
