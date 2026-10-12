'use strict';
/**
 * src/store/stores.js —— 业务状态存储（黑名单 / 待下载清单 / 历史记录）
 *
 * 三个存储的语义（对齐旧实现，但去掉了「下载完就删文件」这类破坏性行为）：
 *   blacklist —— 黑名单：命中即跳过下载（只是本工具不下载，不是去 Pixiv 拉黑）
 *   taskList  —— 待下载清单：一份「要下载哪些画师」的队列，逐个推进（推进后写回，但保留文件）
 *   history   —— 历史记录：处理过的画师（只增不改、不删），用于「只处理新的」判断
 *
 * 底层读写见 ./json.js（原子写、损坏留档、绝不删除）。
 */

const { readJson, writeJsonAtomic, updateJson, asArray } = require('./json.js');

/**
 * 黑名单：`[{id, remarks}]`
 * @param {string} file 状态文件路径
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
        return arr.filter((x) => {
          const keep = String(x.id) !== String(uid);
          if (!keep) removed = true;
          return keep;
        });
      });
      return removed;
    },
    /** 切换：存在则移除、不存在则加入；返回 'added' | 'removed' */
    toggle: (uid, remarks = '') => {
      const exists = load().some((x) => String(x.id) === String(uid));
      if (exists) {
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
 * 待下载清单：`[{id, name}]`
 * @param {string} file 状态文件路径
 */
function createTaskListStore(file) {
  return {
    file,
    all: () => asArray(readJson(file, [])),
    set: (list) => writeJsonAtomic(file, asArray(list)),
    /** 取剩余任务（不修改文件） */
    remaining: () => asArray(readJson(file, [])),
    /** 弹出首个任务并写回剩余（旧的「边下边推进」用法；文件始终保留） */
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
 * 历史记录：`[{id, name, at}]`
 * @param {string} file 状态文件路径
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
  createBlacklistStore,
  createTaskListStore,
  createHistoryStore,
};
