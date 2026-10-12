'use strict';
/**
 * src/util/lock.js —— 跨进程文件锁（零依赖）
 *
 * 用途：防止「同一个文件被两个 CLI 进程同时下载」（多开/脚本重入时的经典问题）。
 * 做法：`<lockDir>/<sha1(key)>.lock`，内容写 pid；用 `open(..., 'wx')` 保证创建原子性。
 *
 * 死锁处理（旧实现踩过的坑）：
 *   - 持锁进程已退出 → 锁是陈旧的，直接接管（用 process.kill(pid, 0) 探测存活，跨平台）
 *   - 锁文件超过 staleMs（默认 24h）→ 视为陈旧，接管
 *   - 拿不到锁时返回 null，调用方自行决定「跳过」还是「等待」
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 键 → 锁文件名（sha1 避免路径里的特殊字符与超长） */
function lockPathFor(lockDir, key) {
  const digest = crypto.createHash('sha1').update(String(key)).digest('hex');
  return path.join(lockDir, `${digest}.lock`);
}

/** 判断 pid 是否存活：ESRCH=不存在；EPERM=存在但无权限（视为存活） */
function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * 尝试获取锁
 * @param {string} key 锁键（通常用目标文件绝对路径）
 * @param {string} lockDir 锁目录（通常 `<stateDir>/locks`）
 * @param {{staleMs?:number}} [opts]
 * @returns {{release:()=>void, path:string}|null} 拿不到返回 null
 */
function acquireLock(key, lockDir, opts = {}) {
  const staleMs = opts.staleMs === undefined ? 24 * 60 * 60 * 1000 : opts.staleMs;
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = lockPathFor(lockDir, key);

  const writeLock = () => {
    const fd = fs.openSync(lockPath, 'wx'); // 独占创建：已存在则抛 EEXIST
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return {
      path: lockPath,
      release: () => { try { fs.unlinkSync(lockPath); } catch { /* 已被清理 */ } },
    };
  };

  try {
    return writeLock();
  } catch (err) {
    if (!err || err.code !== 'EEXIST') return null;
  }

  // 已有锁：判断是否陈旧（持锁进程已死 或 超过 staleMs）
  let stale = false;
  try {
    const info = fs.statSync(lockPath);
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
    const tooOld = Date.now() - info.mtimeMs > staleMs;
    stale = tooOld || !isProcessAlive(pid);
  } catch {
    stale = true; // 读不到锁文件内容（可能刚被删）→ 当陈旧处理
  }
  if (!stale) return null;

  try { fs.unlinkSync(lockPath); } catch { /* 竞争失败也无妨，下面重试创建 */ }
  try {
    return writeLock();
  } catch {
    return null; // 与别的进程抢失败 → 交给调用方跳过
  }
}

module.exports = { acquireLock, lockPathFor, isProcessAlive };
