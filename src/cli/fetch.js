'use strict';
/**
 * src/cli/fetch.js —— 分页拉取与「拉取 → 规划 → 下载」的公共编排（零依赖）
 *
 * 为什么抽出来：`-G 获取关注`、`-B 收藏`、`-u UID`、`-U 清单更新` 四条命令的下载动作完全同构
 * （黑名单过滤 → 建目录 → 拉作品 → 取动图延时 → 规划任务 → 并发下载 → 记历史），
 * 旧实现把这段在 index.js / pxrepo.js 里各写了一遍且互有差异。这里只写一遍。
 */

const path = require('node:path');
const { illustsToTasks } = require('../download/plan.js');
const { downloadAll } = require('../download/engine.js');
const { fetchUgoiraDelay, isUgoira } = require('../download/ugoira.js');
const { PixivError } = require('../pixiv/client.js');
const names = require('../util/names.js');

/** 图片 CDN 必须带 Referer，否则 403（实测：无 Referer=403 / 带 Referer=正常） */
const PIXIV_REFERER = 'https://www.pixiv.net/';

/** 分页拉关注列表 → [{id, name}] */
async function fetchFollows(pixiv, { restrict = 'public', limit = 0, onPage } = {}) {
  if (!pixiv.user || !pixiv.user.id) {
    throw new Error('无法确定自己的 UID（token 响应里没有 user），请重新登录');
  }
  const users = [];
  let nextUrl = null;
  for (;;) {
    const page = nextUrl
      ? await pixiv.requestNext(nextUrl)
      : await pixiv.userFollowing(pixiv.user.id, { restrict });
    for (const preview of page.user_previews || []) {
      if (preview && preview.user && preview.user.id) {
        users.push({ id: preview.user.id, name: preview.user.name || String(preview.user.id) });
      }
    }
    if (onPage) onPage(users.length);
    nextUrl = page.next_url || null;
    if (!nextUrl) break;
    if (limit && users.length >= limit) break;
  }
  return limit ? users.slice(0, limit) : users;
}

/** 分页拉某画师的全部插画 */
async function fetchIllusts(pixiv, uid, { limit = 0, onPage } = {}) {
  const illusts = [];
  let nextUrl = null;
  for (;;) {
    const page = nextUrl
      ? await pixiv.requestNext(nextUrl)
      : await pixiv.userIllusts(uid, { type: 'illust' });
    illusts.push(...(page.illusts || []));
    if (onPage) onPage(illusts.length);
    nextUrl = page.next_url || null;
    if (!nextUrl) break;
    if (limit && illusts.length >= limit) break;
  }
  return limit ? illusts.slice(0, limit) : illusts;
}

/** 分页拉收藏的插画 */
async function fetchBookmarks(pixiv, uid, { restrict = 'public', limit = 0, onPage } = {}) {
  const illusts = [];
  let nextUrl = null;
  for (;;) {
    const page = nextUrl
      ? await pixiv.requestNext(nextUrl)
      : await pixiv.userBookmarksIllust(uid, { restrict });
    illusts.push(...(page.illusts || []));
    if (onPage) onPage(illusts.length);
    nextUrl = page.next_url || null;
    if (!nextUrl) break;
    if (limit && illusts.length >= limit) break;
  }
  return limit ? illusts.slice(0, limit) : illusts;
}

/**
 * 预取动图延时（map: id → delay）
 * 为什么要预取：任务规划是同步纯函数（便于测试），延时来自网络，所以先批量取好再传入。
 */
async function collectUgoiraDelays(pixiv, illusts) {
  const delays = new Map();
  for (const illust of illusts || []) {
    if (!isUgoira(illust)) continue;
    const delay = await fetchUgoiraDelay(pixiv, illust.id);
    if (delay) delays.set(String(illust.id), delay);
  }
  return delays;
}

/**
 * 下载一批作品（公共编排）
 * @param {object} ctx createContext 的结果
 * @param {Array<object>} illusts 作品 JSON 列表
 * @param {string} dir 目标目录（画师目录 / Bookmark 目录）
 * @returns {Promise<{taskCount:number, result:object}>}
 */
async function downloadIllusts(ctx, illusts, dir) {
  const list = Array.isArray(illusts) ? illusts : [];
  const delays = await collectUgoiraDelays(ctx.pixiv, list);
  const tasks = illustsToTasks(list, {
    dir,
    referer: PIXIV_REFERER,
    limit: ctx.cfg.limit || 0,
    delayOf: (id) => delays.get(String(id)) || null,
  });
  const tracker = ctx.makeTracker(tasks.length);
  try {
    const result = await downloadAll(tasks, {
      http: ctx.http,
      concurrency: ctx.cfg.concurrency,
      dryrun: ctx.dryrun,
      tracker,
      lockDir: path.join(ctx.cfg.stateDir, 'locks'),
      timeoutMs: ctx.cfg.timeoutMs,
    });
    return { taskCount: tasks.length, result };
  } finally {
    tracker.finishLine(); // TTY 下清掉进度条区域；非 TTY 只输出一个换行
  }
}

/**
 * 对一批画师执行「过滤黑名单 → 建目录 → 拉作品 → 下载 → 记历史」
 * @param {object} ctx
 * @param {Array<{id:string|number,name?:string}>} creators
 * @returns {Promise<{processed:number,skipped:number,downloads:number,failed:number}>}
 */
async function downloadForCreators(ctx, creators) {
  const summary = { processed: 0, skipped: 0, downloads: 0, failed: 0 };
  const list = Array.isArray(creators) ? creators : [];
  const total = list.length;

  for (let i = 0; i < list.length; i++) {
    const creator = list[i];
    const uid = String(creator.id);
    const position = `[${i + 1}/${total}]`;

    if (ctx.stores.blacklist.has(uid)) {
      console.log(`${position} 黑名单跳过 uid=${uid}`);
      summary.skipped++;
      continue;
    }

    try {
      const detail = creator.name ? { id: uid, name: creator.name } : await ctx.pixiv.userDetail(uid).then((r) => r.user);
      const dirName = names.illustratorDirName(uid, (detail && detail.name) || uid);
      const dir = path.join(ctx.cfg.dataRoot, dirName);
      console.log(`${position} 画师 ${dirName}`);

      const illusts = await fetchIllusts(ctx.pixiv, uid, { limit: ctx.cfg.limit || 0 });
      console.log(`${position} 作品 ${illusts.length} 个`);

      const { taskCount, result } = await downloadIllusts(ctx, illusts, dir);
      summary.downloads += result.downloaded;
      summary.failed += result.failed;
      summary.processed++;

      ctx.stores.history.record(uid, (detail && detail.name) || '');
      console.log(`${position} 完成：任务 ${taskCount}｜新 ${result.downloaded} 跳过 ${result.existed} 失败 ${result.failed}`);
    } catch (err) {
      summary.failed++;
      const message = String(err && err.message || err).slice(0, 140);
      console.error(`${position} 失败 uid=${uid}：${message}`);
      // 旧版行为：接口明确拒绝该用户（PixivError，如账号已注销/被限制）时自动拉黑，
      // 避免每次更新都在同一个人身上反复撞墙。可用 `-l <uid>` 随时移出。
      if (err instanceof PixivError && ctx.stores.blacklist.add(uid, `自动：${message.slice(0, 60)}`)) {
        console.error(`${position} 已自动加入黑名单（uid=${uid}；用 node cli.js -l ${uid} 可移出）`);
      }
    }
  }
  return summary;
}

module.exports = {
  PIXIV_REFERER,
  fetchFollows,
  fetchIllusts,
  fetchBookmarks,
  collectUgoiraDelays,
  downloadIllusts,
  downloadForCreators,
};
