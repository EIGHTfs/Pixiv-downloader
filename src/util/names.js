'use strict';
/**
 * src/util/names.js —— 画师目录名 / 文件名净化（零依赖）
 *
 * 为什么单独成模块：旧实现把这段逻辑散在 illustrator.js / illust.js / plugins/utils.js 三处，
 * 结果出现「PID 目录名一处写 'PID'、另一处写 '「PID」'」这类不一致。集中一处便于测试与复用。
 *
 * 规则来源（对齐旧实现的实际行为，见 pxder-legacy 分支 src/plugins/utils.js:RemoveIllegalCharacters）：
 *   1. 画师名常带摊位后缀（如 `名字@お仕事募集中`）——@ 或全角 ＠ 之后的内容一律截掉
 *   2. 去掉文件系统非法字符：/ \ : * ? " < > | . & $
 *   3. 去掉结尾空格
 *   4. 目录名统一 `(UID)画师名`，文件名统一 `(PID)标题[_p页码][@延时ms].ext`
 *      —— 这两个前缀是「按 UID/PID 识别已下载内容」的依据（正则 ^\((\d+)\)），不能改格式
 */

const ILLEGAL_CHARS = /[/\\:*?"<>|.&$]/g;      // 与旧实现一致（额外把 . 也去掉，避免出现隐藏文件/多重扩展名）
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;      // 控制字符（标题里可能混入换行等）
const TRAILING_SPACES = /[ ]+$/;
const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i; // Windows 保留名（跨平台拷贝时不至于炸）

/**
 * 按字节截断字符串（不切断多字节字符）
 * 为什么按字节：Linux 文件名上限 255 **字节**，日文/中文标题按字符截断仍可能超限（ENAMETOOLONG）
 */
function truncateBytes(str, maxBytes) {
  const s = String(str || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

/** 基础净化：去控制字符、非法字符、结尾空格/点，并保证非空 */
function sanitizeName(name, { maxBytes = 180 } = {}) {
  let s = String(name || '');
  s = s.replace(CONTROL_CHARS, '');
  s = s.replace(ILLEGAL_CHARS, '');
  s = s.replace(TRAILING_SPACES, '');
  s = s.replace(/[. ]+$/, '');           // 结尾的点/空格在 Windows/部分 FS 上会被吞掉
  s = s.trim();
  if (RESERVED_NAMES.test(s)) s = `_${s}`;
  s = truncateBytes(s, maxBytes);
  return s || 'untitled';                // 极端情况下给个兜底名，避免生成空文件名
}

/**
 * 画师目录名：`(UID)画师名`
 * @param {string|number} uid 画师 UID
 * @param {string} name 画师名（可含摊位后缀）
 */
function illustratorDirName(uid, name) {
  let n = String(name || '');
  const at = n.search(/@|＠/);           // 去掉摊位后缀（@ 之后）
  if (at >= 1) n = n.slice(0, at);
  return `(${uid})${sanitizeName(n, { maxBytes: 150 })}`;
}

/**
 * 从目录名解析 UID（`(12345)名字` → 12345），不匹配返回 null
 * 用途：`-U 更新` 时扫描下载目录，找出所有已下载的画师
 */
function parseUidFromDirName(dirName) {
  const matched = /^\((\d+)\)/.exec(String(dirName || ''));
  return matched ? matched[1] : null;
}

/**
 * 从文件名解析 PID（`(12345)标题_p0.jpg` → 12345），不匹配返回 null
 * 用途：按 PID 下载时跳过已存在的作品
 */
function parsePidFromFileName(fileName) {
  const matched = /^\((\d+)\)/.exec(String(fileName || ''));
  return matched ? matched[1] : null;
}

/**
 * 作品文件名：`(PID)标题[_p页码][@延时ms].ext`
 * @param {{id:string|number,title:string,page?:number,ext?:string,delay?:number,ugoira?:boolean}} illust
 * @returns {string}
 */
function illustFileName(illust) {
  const id = illust.id;
  const title = sanitizeName(illust.title, { maxBytes: 120 });
  if (illust.ugoira) {
    const delay = illust.delay ? `@${illust.delay}ms` : '';
    return `(${id})${title}${delay}.zip`;
  }
  const page = illust.page === undefined || illust.page === null ? '' : `_p${illust.page}`;
  const ext = illust.ext || '.jpg';
  return `(${id})${title}${page}${ext}`;
}

/** 从 URL 推断扩展名（取最后一个 `.` 后的 1-5 位字母数字；失败回退 .jpg） */
function extFromUrl(url) {
  const matched = /\.([a-z0-9]{1,5})(?:$|\?)/i.exec(String(url || ''));
  return matched ? `.${matched[1].toLowerCase()}` : '.jpg';
}

module.exports = {
  sanitizeName,
  illustratorDirName,
  parseUidFromDirName,
  parsePidFromFileName,
  illustFileName,
  extFromUrl,
  truncateBytes,
};
