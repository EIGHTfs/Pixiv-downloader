'use strict';
/**
 * src/download/plan.js —— 把 Pixiv 作品 JSON 转成下载任务（纯函数，零依赖）
 *
 * 为什么单独成模块：这段逻辑在旧实现里散落在 illust.js / downloader.js 中，还混着网络与落盘；
 * 抽成纯函数后可以离线断言（见 test/download-plan-check.mjs），CLI 只负责编排 API 调用。
 *
 * 产出任务结构：{ url, savePath, expectSize?, label, referer }
 */

const path = require('node:path');
const names = require('../util/names.js');
const ugoira = require('./ugoira.js');

/** 单张图的扩展名：优先用 URL 后缀，URL 里没有就用接口给的 ext */
function extOf(url, fallbackExt) {
  const fromUrl = names.extFromUrl(url);
  if (fromUrl && fromUrl !== '.jpg') return fromUrl;
  return fallbackExt ? `.${String(fallbackExt).replace(/^\./, '')}` : fromUrl;
}

/**
 * 一个作品 → 若干下载任务
 * @param {object} illust 作品 JSON（App API 的 illust 对象）
 * @param {{dir:string, referer:string, ugoiraDelay?:number}} opts dir 为该作品所在目录（画师目录）
 * @returns {Array<{url:string,savePath:string,label:string,referer:string,expectSize?:number}>}
 */
function illustToTasks(illust, opts) {
  // 空值/异常输入守卫：接口偶尔会返回 null 元素或字段缺失的条目，不能让它把整批下载带崩
  if (!illust || typeof illust !== 'object') return [];
  const dir = opts.dir;
  const referer = opts.referer;
  const id = illust.id;
  if (id === undefined || id === null) return [];
  const title = illust.title || String(id);
  const tasks = [];

  // 动图：一个 zip 任务
  if (ugoira.isUgoira(illust)) {
    const url = ugoira.ugoiraZipUrl(illust);
    if (url) {
      const fileName = ugoira.ugoiraFileName(id, title, opts.ugoiraDelay);
      tasks.push({ url, savePath: path.join(dir, fileName), label: fileName, referer });
    }
    return tasks;
  }

  // 多图：meta_pages 每页一张
  const pages = Array.isArray(illust.meta_pages) ? illust.meta_pages : [];
  if (pages.length > 0) {
    pages.forEach((page, index) => {
      const url = page && page.image_urls && page.image_urls.original;
      if (!url) return;
      const ext = extOf(url, page.image_urls && page.image_urls.original_ext);
      const fileName = names.illustFileName({ id, title, page: index, ext });
      tasks.push({ url, savePath: path.join(dir, fileName), label: fileName, referer });
    });
    return tasks;
  }

  // 单图
  const single = illust.meta_single_page && illust.meta_single_page.original_image_url;
  if (single) {
    const ext = extOf(single, null);
    const fileName = names.illustFileName({ id, title, ext });
    tasks.push({ url: single, savePath: path.join(dir, fileName), label: fileName, referer });
  }
  return tasks;
}

/**
 * 多个作品 → 任务列表（同一画师目录）
 * @param {Array<object>} illusts
 * @param {{dir:string, referer:string, delayOf?:(id:string|number)=>number|null, limit?:number}} opts
 *        delayOf：同步取动图延时（调用方预先取好并缓存，保持本函数纯净）
 */
function illustsToTasks(illusts, opts) {
  const list = Array.isArray(illusts) ? illusts : [];
  const limited = opts.limit ? list.slice(0, opts.limit) : list;
  const out = [];
  for (const illust of limited) {
    const delay = ugoira.isUgoira(illust) && opts.delayOf ? opts.delayOf(illust.id) : undefined;
    out.push(...illustToTasks(illust, { dir: opts.dir, referer: opts.referer, ugoiraDelay: delay }));
  }
  return out;
}

module.exports = { illustToTasks, illustsToTasks, extOf };
