#!/usr/bin/env node
/**
 * test/store-names-check.mjs —— 命名净化 + JSON 状态存储检查（零依赖、离线）
 *
 * 覆盖场景：
 *   命名：
 *     1. 非法字符/控制字符净化、空名兜底
 *     2. 画师目录名 `(UID)名字` 且截掉 @ 摊位后缀（对齐旧实现行为）
 *     3. 从目录名/文件名反解 UID / PID（已下载判断的依据）
 *     4. 作品文件名：单图 / 多图 _pN / 动图 zip（含 @延时ms）
 *     5. 按字节截断不切断多字节字符（避免 ENAMETOOLONG）
 *     6. 从 URL 推扩展名
 *   存储：
 *     7. 文件不存在时返回 fallback（不抛错）
 *     8. 原子写：内容正确、无 .tmp 残留
 *     9. 损坏 JSON：改名留档为 .corrupt-* 并返回 fallback —— **绝不删除**
 *    10. 黑名单 add/has/remove/toggle 语义
 *    11. 任务清单 shift 推进后文件仍存在（旧实现会 unlinkSync 删掉）
 *    12. 历史记录 record/has（已存在则更新名字、不重复追加）
 *    13. 静态检查：store 模块不导出任何删除类 API
 *
 * 用法：node test/store-names-check.mjs
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const names = require(join(ROOT, 'src', 'util', 'names.js'));
// 存储层拆成两个模块：json.js（原子读写基础）+ stores.js（黑名单/任务清单/历史）
// 测试内聚合，便于一次性断言「两个模块都不导出删除类 API」
const jsonStore = require(join(ROOT, 'src', 'store', 'json.js'));
const stores = require(join(ROOT, 'src', 'store', 'stores.js'));
const store = { ...jsonStore, ...stores };

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

function main() {
  // 临时目录（派生自系统临时目录，测试结束即清理；不硬编码绝对路径）
  const dir = mkdtempSync(join(tmpdir(), 'pxrepo-store-'));
  try {
    // ── 命名 ────────────────────────────────────────────────────────
    assert('① 净化非法字符与控制字符',
      names.sanitizeName('a/b\\c:d*e?f"g<h>i|j.k&l$m\u0000n') === 'abcdefghijklmn',
      names.sanitizeName('a/b\\c:d*e?f"g<h>i|j.k&l$m\u0000n'));

    assert('② 空名兜底为 untitled', names.sanitizeName('///') === 'untitled', names.sanitizeName('///'));

    const dirName = names.illustratorDirName(12345, '画师名@お仕事募集中');
    assert('③ 目录名 (UID)名字 且截掉摊位后缀', dirName === '(12345)画师名', dirName);

    const dirName2 = names.illustratorDirName(999, 'A@B@C');
    assert('④ 多个 @ 只截第一个之后', dirName2 === '(999)A', dirName2);

    assert('⑤ 从目录名反解 UID', names.parseUidFromDirName('(12345)名字') === '12345' && names.parseUidFromDirName('无前缀') === null,
      String(names.parseUidFromDirName('(12345)名字')));
    assert('⑥ 从文件名反解 PID', names.parsePidFromFileName('(67890)标题_p0.jpg') === '67890' && names.parsePidFromFileName('x.jpg') === null,
      String(names.parsePidFromFileName('(67890)标题_p0.jpg')));

    assert('⑦ 单图文件名', names.illustFileName({ id: 1, title: '标题', ext: '.jpg' }) === '(1)标题.jpg',
      names.illustFileName({ id: 1, title: '标题', ext: '.jpg' }));
    assert('⑧ 多图文件名带页码', names.illustFileName({ id: 2, title: 'T', page: 3, ext: '.png' }) === '(2)T_p3.png',
      names.illustFileName({ id: 2, title: 'T', page: 3, ext: '.png' }));
    assert('⑨ 动图文件名（含延时）', names.illustFileName({ id: 3, title: 'U', ugoira: true, delay: 60 }) === '(3)U@60ms.zip',
      names.illustFileName({ id: 3, title: 'U', ugoira: true, delay: 60 }));

    const long = '中'.repeat(100); // 每个汉字 3 字节
    const cut = names.truncateBytes(long, 10);
    assert('⑩ 按字节截断不切断多字节字符', Buffer.byteLength(cut, 'utf8') <= 10 && cut === '中'.repeat(3), `${cut.length} 字符 / ${Buffer.byteLength(cut, 'utf8')} 字节`);

    assert('⑪ URL 推扩展名', names.extFromUrl('https://i.pximg.net/a/b_p0.png') === '.png' && names.extFromUrl('https://x/y') === '.jpg',
      names.extFromUrl('https://i.pximg.net/a/b_p0.png'));

    // ── 存储 ────────────────────────────────────────────────────────
    const missing = join(dir, 'nope.json');
    assert('⑫ 文件不存在返回 fallback', Array.isArray(store.readJson(missing, [])) && store.readJson(missing, []).length === 0, 'fallback 未生效');

    const atomic = join(dir, 'sub', 'data.json');
    store.writeJsonAtomic(atomic, { a: 1 });
    const leftovers = readdirSync(join(dir, 'sub')).filter((f) => f.endsWith('.tmp'));
    assert('⑬ 原子写内容正确且无 .tmp 残留', JSON.parse(readFileSync(atomic, 'utf8')).a === 1 && leftovers.length === 0, `残留=${leftovers.join(',')}`);

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ 这不是 JSON', 'utf8');
    const got = store.readJson(corrupt, { fallback: true });
    const corruptFiles = readdirSync(dir).filter((f) => f.startsWith('corrupt.json.corrupt-'));
    assert('⑭ 损坏 JSON 改名留档且返回 fallback', got && got.fallback === true && corruptFiles.length === 1,
      `fallback=${JSON.stringify(got)} 留档=${corruptFiles.length}`);

    const bl = store.createBlacklistStore(join(dir, 'blacklist.json'));
    bl.add(11, 'pixiv');
    const addDup = bl.add(11);
    assert('⑮ 黑名单 add 去重 + has', bl.has(11) && bl.all().length === 1 && addDup === false, JSON.stringify(bl.all()));
    assert('⑯ 黑名单 remove', bl.remove(11) === true && bl.has(11) === false, JSON.stringify(bl.all()));
    assert('⑰ 黑名单 toggle 两态', bl.toggle(22) === 'added' && bl.has(22) && bl.toggle(22) === 'removed' && !bl.has(22), JSON.stringify(bl.all()));

    const tasks = store.createTaskListStore(join(dir, 'download.json'));
    tasks.set([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
    const shifted = tasks.shift();
    assert('⑱ 任务清单 shift 推进且文件保留', shifted.id === 1 && tasks.all().length === 1 && existsSync(tasks.file), JSON.stringify(tasks.all()));

    const hist = store.createHistoryStore(join(dir, 'history.json'));
    hist.record(5, 'old');
    hist.record(5, 'new');
    const added6 = hist.record(6, 'x');
    assert('⑲ 历史记录去重更新且新增', hist.all().length === 2 && hist.all()[0].name === 'new' && added6 === true, JSON.stringify(hist.all()));

    const storeApi = Object.keys(store).join(',');
    assert('⑳ store 模块不含删除类 API（绝不删用户文件）', !/delete|unlink|remove|rm/i.test(storeApi), storeApi);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main();
