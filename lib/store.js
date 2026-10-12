'use strict';
/**
 * lib/store.js —— JSON 状态文件读写（零依赖，原子写）
 *
 * 设计原则（针对旧实现的三个真实缺陷）：
 *   1. **绝不用 require() 读可变 JSON** —— 旧代码 `require(blacklistJson)` 会被 Node 模块缓存，
 *      同一进程内改了文件再读还是旧值。这里统一用 fs.readFileSync + JSON.parse。
 *   2. **绝不删除用户文件** —— 旧代码在下载结束后 `unlinkSync(download.json)`，用户数据直接没了。
 *      本模块只做「读 → 改 → 原子写」，不提供 delete；损坏文件改名留档而不是删掉。
 *   3. **原子写** —— 先写 `<file>.tmp` 再 rename，避免写一半崩溃留下半个 JSON（rename 同卷原子）。
 *
 * 状态文件位置：`config.stateDir`（默认 `<数据根>/.pxrepo/`，可用 PXREPO_STATE_DIR 覆盖）
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
  } catch (err) {
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

/** 确保状态目录存在 */
function ensureStateDir(config) {
  const dir = (config && config.stateDir) || path.join(process.cwd(), '.pxrepo');
  ensureDir(dir);
  return dir;
}

/** 把任意输入规整成数组（旧数据可能是 null / 对象，不能让后续 .some() 崩） */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * 黑名单：`[{id, remarks}]`
 * 语义：只影响本工具的下载（命中即跳过），不是真的去 Pixiv 拉黑
 */
function createBlacklistStore(file) {
  const load = () => asArray(readJson(file, []));
  return {
    file,
    all: load,
    has: (uid) => load().some((x) => String(x.id) === String(uid)),
    /** 加入黑名单（已存在则不动）；返回 true=新加入 */
    add: (uid, remarks = '') => {
      let added = false;
      updateJson(file, (cur) => {
        const arr = asArray(cur);
        if (!arr.some((x) => String(x.id) === String(uid))) {
          arr.push({ id: Number(uid), remarks });
          added = true;
        }
        return arr;
      });
      return added;
    },
    /** 移出黑名单；返回 true=确实移除了 */
    remove: (uid) => {
      let removed = false;
      updateJson(file, (cur) => {
        const arr = asArray(cur);
        const next = arr.filter((x) => {
          const keep = String(x.id) !== String(uid);
          if (!keep) removed = true;
          return keep;
        });
        return next;
      });
      return removed;
    },
    /** 切换：存在则移除、不存在则加入；返回 'added' | 'removed' */
    toggle: (uid, remarks = '') => {
      const has = load().some((x) => String(x.id) === String(uid));
      if (has) {
        updateJson(file, (cur) => asArray(cur).filter((x) => String(x.id) !== String(uid)));
        return 'removed';
      }
      updateJson(file, (cur) => {
        const arr = asArray(cur);
        arr.push({ id: Number(uid), remarks });
        return arr;
      });
      return 'added';
    },
  };
}

/**
 * 待下载清单：`[{id, name}]`（对应旧的 download.json）
 * 语义：一份「要下载哪些画师」的队列；下载过程会逐个推进（推进后写回，但不删除文件）
 */
function createTaskListStore(file) {
  return {
    file,
    all: () => asArray(readJson(file, [])),
    set: (list) => writeJsonAtomic(file, asArray(list)),
    /** 取剩余任务（不修改文件） */
    remaining: () => asArray(readJson(file, [])),
    /** 把首个任务弹出并写回剩余（旧实现就是这种「边下边推进」的用法） */
    shift: () => {
      let shifted = null;
      updateJson(file, (cur) => {
        const arr = asArray(cur);
        shifted = arr.shift() || null;
        return arr;
      });
      return shifted;
    },
  };
}

/**
 * 历史记录：`[{id, name, ...}]`（对应旧的 history.json）
 * 语义：曾经处理过的画师，用于「只处理新的」判断；只增不改，不做删除
 */
function createHistoryStore(file) {
  const load = () => asArray(readJson(file, []));
  return {
    file,
    all: load,
    has: (uid) => load().some((x) => String(x.id) === String(uid)),
    /** 追加记录（已存在则更新 name）；返回 true=新增 */
    record: (uid, name = '') => {
      let added = false;
      updateJson(file, (cur) => {
        const arr = asArray(cur);
        const hit = arr.find((x) => String(x.id) === String(uid));
        if (hit) {
          if (name) hit.name = name;
        } else {
          arr.push({ id: Number(uid), name, at: new Date().toISOString() });
          added = true;
        }
        return arr;
      });
      return added;
    },
  };
}

module.exports = {
  ensureDir,
  ensureStateDir,
  stateFile,
  readJson,
  writeJsonAtomic,
  updateJson,
  asArray,
  createBlacklistStore,
  createTaskListStore,
  createHistoryStore,
};
