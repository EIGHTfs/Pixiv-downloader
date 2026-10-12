'use strict';
/**
 * src/util/progress.js —— 下载进度条（TTY 实时渲染，零依赖）
 *
 * 三个样式（`--progress` 参数 / `PXREPO_PROGRESS` 环境变量）：
 *   single —— 单行汇总（任务少时最简洁）
 *   multi  —— 每个下载任务一行 + 底部汇总行（默认）
 *   ipull  —— 模仿 ipull fancy：状态图标（↓下载 / →复用）+ 名称/大小/百分比/bar/速度 列对齐
 *
 * 渲染机制：用 ANSI 上移（`\x1b[nA`）回到进度条区域顶部重绘，避免多行互相覆盖；
 *           `finishLine()` 用 `\x1b[J` 清掉整块区域，保证进度条结束后不留残影。
 * 节流：200ms（终端每秒重绘 5 次足够顺滑，且避免高频 write 拖慢下载）
 * 非 TTY（管道/重定向/日志）不渲染进度条，由调用方输出逐行状态即可。
 */

/** 字节格式化（B/KB/MB/GB，保留合适小数位） */
const fmtBytes = (n) => (n == null ? '0B'
  : n < 1024 ? `${n}B`
    : n < 1048576 ? `${(n / 1024).toFixed(1)}KB`
      : n < 1073741824 ? `${(n / 1048576).toFixed(1)}MB`
        : `${(n / 1073741824).toFixed(2)}GB`);

/** 速度格式化（未知时显示 ?/s） */
const fmtSpeed = (n) => (n == null || Number.isNaN(n) ? '?/s' : `${fmtBytes(n)}/s`);

/** 图形进度条（绿=完成 灰=待下载，宽度 barW） */
function barOf(pct, barW) {
  const filled = Math.round((Math.min(100, pct || 0) / 100) * barW);
  return `\x1b[32m${'█'.repeat(filled)}\x1b[90m${'░'.repeat(Math.max(0, barW - filled))}\x1b[0m`;
}

/** 判断是否该渲染进度条：TTY 且未禁用颜色（NO_COLOR 遵循社区约定） */
function isTty() {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

/**
 * 输出多行/单行（先上移回区域顶部再写，最后补空格清掉上一帧更长的残留）
 * 更新 state.prevLen / state.prevLines
 */
function emitLines(state, lines, single = false) {
  const out = `${lines.join('\r\n')}\r`;
  const pad = ' '.repeat(Math.max(0, state.prevLen - out.length));
  if (state.prevLines > 0) process.stdout.write(`\x1b[${state.prevLines}A${single ? '\x1b[K' : ''}`);
  process.stdout.write(out + pad);
  state.prevLen = out.length;
  state.prevLines = lines.length;
}

/** 汇总行（三个样式共用） */
function summaryLine(state) {
  const { done, pct, totalSpeed } = state.overall();
  return `[下载] ${barOf(pct, 18)} ${done}/${state.totalFiles} ${pct.toFixed(1)}% `
    + `新${state.counts.downloaded} 跳${state.counts.existed} 败${state.counts.failed} 总速 ${fmtSpeed(totalSpeed)}`;
}

/** 样式 single：单行汇总（活动文件挤在同一行，最多 2 个） */
function renderSingle(state) {
  const activeLines = [...state.active.values()].slice(0, 2)
    .map((a) => `${String(a.filename || '').slice(0, 26)} ${(a.percent || 0).toFixed(0)}% ${fmtSpeed(a.speed)}`)
    .join(' | ');
  emitLines(state, [`\r${summaryLine(state)}  ${activeLines}`], true);
}

/** 样式 multi：每个任务一行 + 汇总行（活跃最多 8 行，超出省略） */
function renderMulti(state) {
  const actives = [...state.active.values()];
  const maxRows = 8;
  const barW = 14;
  const lines = actives.slice(0, maxRows).map((a) => {
    const p = Math.min(100, a.percent || 0);
    return ` ${String(a.filename || '').slice(0, 34).padEnd(34)} ${barOf(p, barW)} ${String(p.toFixed(0)).padStart(3)}% ${fmtSpeed(a.speed).padStart(10)}`;
  });
  if (actives.length > maxRows) lines.push(` … 另 ${actives.length - maxRows} 个下载中`);
  lines.push(summaryLine(state));
  emitLines(state, lines);
}

/** 样式 ipull：图标 + 名称/大小/百分比/bar/速度 列对齐 */
function renderIpull(state) {
  const actives = [...state.active.values()];
  const maxRows = 8;
  const barW = 12;
  const iconOf = (a) => (a.state === 'copy' || a.state === 'linked' ? '→' : '↓');
  const lines = actives.slice(0, maxRows).map((a) => {
    const p = Math.min(100, a.percent || 0);
    const size = a.total ? fmtBytes(a.total) : (a.doneBytes ? fmtBytes(a.doneBytes) : '');
    return ` ${iconOf(a)} ${String(a.filename || '').slice(0, 30).padEnd(30)} ${size.padStart(10)} ${String(p.toFixed(0)).padStart(4)}% ${barOf(p, barW)} ${fmtSpeed(a.speed).padStart(10)}`;
  });
  if (actives.length > maxRows) lines.push(` … 另 ${actives.length - maxRows} 个下载中`);
  lines.push(summaryLine(state));
  emitLines(state, lines);
}

/**
 * 创建进度跟踪器
 * @param {number} totalFiles 本次任务预计总文件数（百分比分母）
 * @param {boolean} [tty] 是否渲染进度条（默认按 isTty() 判断）
 * @param {string} [style] 样式覆盖（默认读 PXREPO_PROGRESS，再默认 multi）
 * @returns {object} { counts, failedSet, overall, onProgress, onFinish, maybeRender, render, finishLine, style }
 */
function createProgressTracker(totalFiles, tty = isTty(), style = null) {
  const chosen = String(style || process.env.PXREPO_PROGRESS || 'multi').toLowerCase();
  const state = {
    style: ['single', 'multi', 'ipull'].includes(chosen) ? chosen : 'multi',
    totalFiles: Number(totalFiles) || 0,
    counts: { downloaded: 0, existed: 0, failed: 0 },
    active: new Map(), // key（savePath 或文件名）→ { filename, doneBytes, total, percent, speed, state }
    failedSet: new Set(),
    lastRender: 0,
    prevLen: 0,
    prevLines: 0,
  };

  /** 汇总：已完成数 / 百分比 / 总速度（活动项速度求和） */
  state.overall = () => {
    const done = state.counts.downloaded + state.counts.existed;
    const pct = state.totalFiles ? Math.min(100, (done / state.totalFiles) * 100) : 0;
    const totalSpeed = [...state.active.values()].reduce((sum, a) => sum + (a.speed || 0), 0);
    return { done, pct, totalSpeed };
  };

  return {
    counts: state.counts,
    failedSet: state.failedSet,
    overall: state.overall,
    style: state.style,

    /** 文件级进度事件（下载层 onProgress 转发过来） */
    onProgress(p) {
      const key = p.savePath || p.filename;
      state.active.set(key, { ...(state.active.get(key) || {}), ...p });
      if (tty) this.maybeRender();
    },

    /** 文件结束：status = downloaded | existed | failed */
    onFinish(filename, status) {
      state.active.delete(filename);
      if (status === 'downloaded') state.counts.downloaded++;
      else if (status === 'existed') state.counts.existed++;
      else { state.counts.failed++; state.failedSet.add(filename); }
      if (tty) this.render();
    },

    /** 节流渲染（200ms；非 TTY 直接跳过，避免管道/日志里混入 ANSI） */
    maybeRender() {
      if (!tty) return;
      const now = Date.now();
      if (now - state.lastRender >= 200) {
        state.lastRender = now;
        this.render();
      }
    },

    /**
     * 立即渲染（按样式派发）
     * @param {boolean} [force] true 时即使非 TTY 也渲染（仅供测试/调试，业务代码不要用）
     */
    render(force = false) {
      if (!tty && !force) return;
      if (state.style === 'single') renderSingle(state);
      else if (state.style === 'ipull') renderIpull(state);
      else renderMulti(state);
    },

    /** 结束进度条：清掉整块区域并换行，避免残留 */
    finishLine() {
      if (state.prevLines > 0) process.stdout.write(`\x1b[${state.prevLines}A\x1b[J`);
      state.prevLines = 0;
      state.prevLen = 0;
      process.stdout.write('\n');
    },
  };
}

module.exports = { createProgressTracker, fmtBytes, fmtSpeed, barOf, isTty };
