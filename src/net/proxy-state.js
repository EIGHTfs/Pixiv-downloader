'use strict';
/**
 * src/net/proxy-state.js —— 代理候选的「学习型轮换」状态（零依赖）
 *
 * 设计借鉴 iwara-downloader 的 CDN 子域轮换：
 *   - 候选顺序 = GOOD 成功列表（新→旧）→ 其余未失败过的 → 最近失败过的（排最后）
 *   - 成功 → 记 GOOD（并清掉它的 BAD 记录）；失败 → 记 BAD（并从 GOOD 移除）
 *   - BAD 有有效期（默认 30 分钟）：过期后仍允许再试，避免一次网络抖动就永久弃用
 *   - 状态持久化到 `<stateDir>/proxy-state.json`，跨次运行累积经验
 *
 * 为什么需要：公开代理探测通过后可能几秒就死；把「谁曾经能用」记住，
 * 下次优先试它，能显著提高一次成功的概率。
 */

const path = require('node:path');
const { readJson, writeJsonAtomic } = require('../store/json.js');

/** BAD 标记有效期：过期后允许重试（默认 30 分钟） */
const BAD_TTL_MS = 30 * 60 * 1000;
/** GOOD 列表上限（避免无限增长） */
const GOOD_LIMIT = 50;

/** 状态文件路径 */
function stateFileFor(config = {}) {
  const dir = config.stateDir || path.join(process.cwd(), '.pxrepo');
  return path.join(dir, 'proxy-state.json');
}

/** 读取状态（做结构规整，容忍脏数据） */
function loadState(file) {
  const raw = readJson(file, null);
  const good = Array.isArray(raw && raw.good) ? raw.good.filter((x) => typeof x === 'string') : [];
  const badRaw = raw && raw.bad && typeof raw.bad === 'object' ? raw.bad : {};
  const bad = {};
  for (const [key, value] of Object.entries(badRaw)) {
    if (!value) continue;
    bad[key] = { at: Number(value.at) || 0, reason: String(value.reason || '').slice(0, 120) };
  }
  return { good, bad };
}

/** 写状态 */
function saveState(file, state) {
  writeJsonAtomic(file, {
    updatedAt: new Date().toISOString(),
    good: state.good.slice(0, GOOD_LIMIT),
    bad: state.bad,
  });
}

/** 记一次成功：置顶 GOOD 并清掉 BAD */
function markGood(file, proxy) {
  const state = loadState(file);
  state.good = [proxy, ...state.good.filter((x) => x !== proxy)].slice(0, GOOD_LIMIT);
  delete state.bad[proxy];
  saveState(file, state);
  return state;
}

/** 记一次失败：写 BAD（带时间与原因）并从 GOOD 移除 */
function markBad(file, proxy, reason = '') {
  const state = loadState(file);
  state.good = state.good.filter((x) => x !== proxy);
  state.bad[proxy] = { at: Date.now(), reason: String(reason).slice(0, 120) };
  saveState(file, state);
  return state;
}

/**
 * 按学习结果给候选排序
 * @param {string[]} candidates 候选代理（保持调用方给定顺序作为「其余」的基准）
 * @param {{good:string[],bad:Record<string,{at:number}>}} state
 * @param {number} [now]
 * @returns {{ordered:string[], goodCount:number, badCount:number}}
 */
function orderCandidates(candidates, state, now = Date.now()) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  const good = (state && state.good) || [];
  const bad = (state && state.bad) || {};
  const known = new Set(list);

  const goodFirst = good.filter((p) => known.has(p));                                  // GOOD 且仍在候选里（新→旧）
  const rest = list.filter((p) => !goodFirst.includes(p) && !(bad[p] && now - bad[p].at < BAD_TTL_MS)); // 未失败/已过期
  const staleBad = list.filter((p) => bad[p] && now - bad[p].at < BAD_TTL_MS && !goodFirst.includes(p)); // 最近失败 → 最后

  return {
    ordered: [...goodFirst, ...rest, ...staleBad],
    goodCount: goodFirst.length,
    badCount: staleBad.length,
  };
}

module.exports = {
  BAD_TTL_MS,
  stateFileFor,
  loadState,
  markGood,
  markBad,
  orderCandidates,
};
