'use strict';
/**
 * src/store/json.js —— JSON 文件原子读写基础（零依赖）
 *
 * 设计原则（针对旧实现的三个真实缺陷）：
 *   1. **绝不用 require() 读可变 JSON** —— 旧代码 `require(blacklistJson)` 会被 Node 模块缓存，
 *      同一进程内改了文件再读还是旧值。这里统一用 fs.readFileSync + JSON.parse。
 *   2. **绝不删除用户文件** —— 旧代码在下载结束后 `unlinkSync(download.json)`，用户数据直接没了。
 *      本模块只做「读 → 改 → 原子写」，不提供 delete；损坏文件改名留档而不是删掉。
 *   3. **原子写** —— 先写 `<file>.tmp` 再 rename，避免写一半崩溃留下半个 JSON（rename 同卷原子）。
 *
 * 具体业务存储（黑名单/任务清单/历史）见 ./stores.js
 */

const fs = require('node:fs');
const path = require('node:path');

/** 递归建目录（幂等） */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 读取 JSON；文件不存在返回 fallback；解析失败把坏文件改名留档后返回 fallback
 * @param {string} file
 * @param {*} fallback
 */
function readJson(file, fallback = null) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return fallback; // ENOENT 等一律当「还没有数据」，不抛错
  }
  try {
    return JSON.parse(text);
  } catch {
    // 损坏文件：改名留档（可人工恢复），绝不直接删
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 改名失败也不阻塞 */ }
    return fallback;
  }
}

/**
 * 原子写 JSON
 * @param {string} file
 * @param {*} data
 * @param {{backup?:boolean}} [opts] backup=true 时先把旧文件复制成 `<file>.bak`
 */
function writeJsonAtomic(file, data, opts = {}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  if (opts.backup && fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* 备份失败不阻塞主流程 */ }
  }
  fs.renameSync(tmp, file); // 同卷 rename 是原子操作
}

/**
 * 读-改-写（updater 收到当前值，返回新值）
 * @returns {*} 写入后的新值
 */
function updateJson(file, updater, opts = {}) {
  const current = readJson(file, null);
  const next = updater(current);
  writeJsonAtomic(file, next, opts);
  return next;
}

/** 状态文件路径：`<stateDir>/<name>` */
function stateFile(config, name) {
  const dir = (config && config.stateDir) || path.join(process.cwd(), '.pxrepo');
  return path.join(dir, name);
}

/** 确保状态目录存在并返回它 */
function ensureStateDir(config) {
  const dir = (config && config.stateDir) || path.join(process.cwd(), '.pxrepo');
  ensureDir(dir);
  return dir;
}

/** 把任意输入规整成数组（旧数据可能是 null / 对象，不能让后续 .some() 崩） */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

module.exports = {
  ensureDir,
  ensureStateDir,
  stateFile,
  readJson,
  writeJsonAtomic,
  updateJson,
  asArray,
};
