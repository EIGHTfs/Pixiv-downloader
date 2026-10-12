'use strict';
/**
 * src/download/ugoira.js —— 动图（ugoira）处理（零依赖）
 *
 * Pixiv 的动图不是一个 gif，而是「帧序列打包的 zip」：
 *   - 原图地址里的 `img-original` 换成 `img-zip-ugoira`，文件名 `_ugoira0.jpg` 换成 `_ugoira1920x1080.zip`
 *   - 帧延时需要另调 `/v1/ugoira/metadata`；旧实现把它拼进文件名（`@60ms.zip`），
 *     目的是「同一个作品换了延时参数时不会被误判为已下载」——这里沿用该约定（见 src/util/names.js）
 */

const fs = require('node:fs');
const names = require('../util/names.js');

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

/** 判断作品是否是动图 */
function isUgoira(illust) {
  return Boolean(illust) && (illust.type === 'ugoira' || illust.illustType === 2);
}

/** 从作品 JSON 推出动图 zip 的下载地址（拿不到返回 null） */
function ugoiraZipUrl(illust) {
  const original = illust
    && illust.meta_single_page
    && illust.meta_single_page.original_image_url;
  if (!original) return null;
  return String(original)
    .replace('img-original', 'img-zip-ugoira')
    .replace(/_ugoira0\.(.*)/, '_ugoira1920x1080.zip');
}

/** 取动图第一帧延时（毫秒）；失败返回 null（延时只影响文件名，不该阻塞下载） */
async function fetchUgoiraDelay(pixiv, illustId) {
  try {
    const json = await pixiv.ugoiraMetadata(illustId);
    const frames = json && json.ugoira_metadata && json.ugoira_metadata.frames;
    if (!Array.isArray(frames) || !frames.length) return null;
    return frames[0].delay || null;
  } catch {
    return null;
  }
}

/** 动图文件名（`(PID)标题@延时ms.zip`） */
function ugoiraFileName(illustId, title, delay) {
  return names.illustFileName({ id: illustId, title, ugoira: true, delay });
}

/** 校验落盘的是不是 zip（防止把 HTML 错误页当动图） */
function isZipFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4);
    const read = fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return read === 4 && buf.equals(ZIP_MAGIC);
  } catch {
    return false;
  }
}

module.exports = {
  isUgoira,
  ugoiraZipUrl,
  fetchUgoiraDelay,
  ugoiraFileName,
  isZipFile,
  ZIP_MAGIC,
};
