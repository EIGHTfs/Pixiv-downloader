#!/usr/bin/env node
/**
 * test/download-plan-check.mjs —— 作品 JSON → 下载任务 的规划器检查（零依赖、离线）
 *
 * 覆盖场景：
 *   1. 单图：一个任务，文件名 `(PID)标题.ext`
 *   2. 多图：每页一个任务，文件名 `(PID)标题_pN.ext`（页码从 0 起）
 *   3. 动图：一个 zip 任务——URL 由 img-original→img-zip-ugoira、`_ugoira0.jpg`→`_ugoira1920x1080.zip`；
 *      文件名带 `@延时ms`（延时变化即视为不同文件，避免误判已下载）
 *   4. 异常输入：null / 缺字段 / 动图缺 meta_single_page → 返回空数组且不抛错
 *   5. limit 截断（只处理最新 N 个作品）
 *   6. 扩展名推断：URL 有后缀用后缀，没有则回退 .jpg
 *
 * 用法：node test/download-plan-check.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { illustToTasks, illustsToTasks, extOf } = require(join(ROOT, 'src', 'download', 'plan.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

const DIR = '/tmp/pixiv-dir';
const REFERER = 'https://www.pixiv.net/';

const singleIllust = {
  id: 111,
  title: '单图标题',
  type: 'illust',
  meta_pages: [],
  meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/img/2021/01/01/00/00/00/111_p0.png' },
};

const multiIllust = {
  id: 222,
  title: '多图标题',
  type: 'illust',
  meta_pages: [
    { image_urls: { original: 'https://i.pximg.net/img-original/img/x/222_p0.jpg' } },
    { image_urls: { original: 'https://i.pximg.net/img-original/img/x/222_p1.jpg' } },
    { image_urls: { original: 'https://i.pximg.net/img-original/img/x/222_p2.jpg' } },
  ],
  meta_single_page: {},
};

const ugoiraIllust = {
  id: 333,
  title: '动图标题',
  type: 'ugoira',
  meta_pages: [],
  meta_single_page: { original_image_url: 'https://i.pximg.net/img-original/img/2021/02/03/04/05/06/333_ugoira0.jpg' },
};

function main() {
  // 1. 单图
  const t1 = illustToTasks(singleIllust, { dir: DIR, referer: REFERER });
  assert('① 单图产出 1 个任务且文件名正确',
    t1.length === 1 && t1[0].label === '(111)单图标题.png' && t1[0].savePath === join(DIR, '(111)单图标题.png'),
    JSON.stringify(t1.map((t) => t.label)));
  assert('② 任务带 Referer（图片 CDN 需要）', t1[0].referer === REFERER, t1[0].referer);

  // 2. 多图
  const t2 = illustToTasks(multiIllust, { dir: DIR, referer: REFERER });
  assert('③ 多图每页一个任务且页码从 0 起',
    t2.length === 3 && t2.map((t) => t.label).join(',') === '(222)多图标题_p0.jpg,(222)多图标题_p1.jpg,(222)多图标题_p2.jpg',
    JSON.stringify(t2.map((t) => t.label)));

  // 3. 动图
  const t3 = illustToTasks(ugoiraIllust, { dir: DIR, referer: REFERER, ugoiraDelay: 60 });
  assert('④ 动图产出 1 个 zip 任务且 URL 转换正确',
    t3.length === 1 && t3[0].url === 'https://i.pximg.net/img-zip-ugoira/img/2021/02/03/04/05/06/333_ugoira1920x1080.zip',
    t3[0] && t3[0].url);
  assert('⑤ 动图文件名带延时', t3[0].label === '(333)动图标题@60ms.zip', t3[0].label);

  const t3b = illustToTasks(ugoiraIllust, { dir: DIR, referer: REFERER });
  assert('⑥ 取不到延时时文件名不带 @', t3b[0].label === '(333)动图标题.zip', t3b[0].label);

  // 4. 异常输入
  assert('⑦ null / 缺字段输入返回空数组不抛错',
    illustToTasks(null, { dir: DIR, referer: REFERER }).length === 0
    && illustToTasks({ id: 1, title: 'x', type: 'illust', meta_pages: [], meta_single_page: {} }, { dir: DIR, referer: REFERER }).length === 0
    && illustToTasks({ id: 2, title: 'y', type: 'ugoira', meta_pages: [] }, { dir: DIR, referer: REFERER }).length === 0,
    '有非空结果');

  // 5. limit
  const many = [singleIllust, multiIllust, ugoiraIllust];
  const limited = illustsToTasks(many, { dir: DIR, referer: REFERER, limit: 1 });
  assert('⑧ limit 只处理最新 N 个作品', limited.length === 1 && limited[0].label === '(111)单图标题.png', JSON.stringify(limited.map((t) => t.label)));

  const all = illustsToTasks(many, { dir: DIR, referer: REFERER, delayOf: () => 30 });
  assert('⑨ 全量规划：1 + 3 + 1 = 5 个任务', all.length === 5, `实际 ${all.length}`);

  // 6. 扩展名
  assert('⑩ 扩展名推断（有后缀用后缀，无后缀回退 .jpg）',
    extOf('https://x/y.webp') === '.webp' && extOf('https://x/y') === '.jpg' && extOf('https://x/y.gif?v=2') === '.gif',
    [extOf('https://x/y.webp'), extOf('https://x/y'), extOf('https://x/y.gif?v=2')].join('|'));

  // 7. 标题净化在任务名上生效（非法字符不进文件名）
  const dirty = illustToTasks({ id: 444, title: 'a/b:c*d?e"f<g>h|i', type: 'illust', meta_pages: [], meta_single_page: { original_image_url: 'https://x/444.jpg' } }, { dir: DIR, referer: REFERER });
  assert('⑪ 标题非法字符被净化', dirty[0].label === '(444)abcdefghi.jpg', dirty[0].label);

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main();
