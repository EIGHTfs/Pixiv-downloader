'use strict';
/**
 * src/pixiv/web.js —— 网页会话客户端（Cookie 认证，零依赖）
 *
 * 为什么需要它：
 *   Pixiv 对**未登录请求隐藏 R-18 作品的图片地址**（`urls.original` 为 null），
 *   而 App API 的账号密码授权已被官方废除（password grant → invalid_grant）。
 *   因此「拿浏览器里的会话 Cookie 调 www.pixiv.net/ajax/*」是账号密码用户最现实的路径。
 *
 * Cookie 来源（优先级从高到低）：
 *   1. `config.cookie`（PXREPO_COOKIE 原文，如 `PHPSESSID=xxx; ...`）
 *   2. `config.cookieFile`（默认 `<stateDir>/web-session.json`）里的 cookies 数组
 *      —— 由 `test/pixiv-web-login.mjs` 或「浏览器导出」写入
 *
 * 说明：图片 CDN（i.pximg.net）只需 Referer，不需要 Cookie；Cookie 仅用于 ajax 接口。
 */

const fs = require('node:fs');

const WEB_BASE = 'https://www.pixiv.net';
const WEB_REFERER = 'https://www.pixiv.net/';
const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 浏览器导出的 cookies 数组 → Cookie 请求头 */
function cookiesToHeader(cookies) {
  if (!Array.isArray(cookies)) return '';
  return cookies
    .filter((c) => c && c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/**
 * 解析生效的 Cookie 头
 * @param {{cookie?:string, cookieFile?:string}} config
 * @returns {{header:string, source:string}}
 */
function resolveCookie(config = {}) {
  if (config.cookie) return { header: String(config.cookie), source: 'PXREPO_COOKIE' };
  const file = config.cookieFile;
  if (!file || !fs.existsSync(file)) return { header: '', source: '' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const header = Array.isArray(data.cookies) ? cookiesToHeader(data.cookies) : String(data.cookie || '');
    return { header, source: header ? file : '' };
  } catch {
    return { header: '', source: '' };
  }
}

/** 网页 ajax 错误（带状态码与 Pixiv 的 message） */
class WebSessionError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'WebSessionError';
    this.status = status;
    this.body = body;
  }
}

class WebSessionClient {
  /**
   * @param {{http:object, cookie:string}} opts http 为 src/net/http.js 的客户端；cookie 为 Cookie 头原文
   */
  constructor({ http, cookie = '' } = {}) {
    this.http = http;
    this.cookie = cookie;
  }

  get loggedIn() {
    return Boolean(this.cookie);
  }

  /** 统一请求头（UA / Referer / Cookie） */
  headers(extra = {}) {
    return { 'User-Agent': WEB_UA, Referer: WEB_REFERER, Cookie: this.cookie, ...extra };
  }

  /** GET 一个 ajax 接口，返回 body（Pixiv 的响应形如 {error:false, body:...}） */
  async requestJson(path) {
    const url = /^https?:\/\//i.test(path) ? path : `${WEB_BASE}${path}`;
    const res = await this.http.request(url, { headers: this.headers(), parseJson: true });
    const json = res.json;
    if (res.status >= 400 || !json) {
      throw new WebSessionError(`HTTP ${res.status}`, { status: res.status, body: json });
    }
    if (json.error) {
      throw new WebSessionError(json.message || '接口返回 error=true', { status: res.status, body: json });
    }
    return json.body;
  }

  /** 作品详情（网页 ajax 形态：含 title/userName/userId/pageCount/xRestrict） */
  illustDetail(illustId) {
    return this.requestJson(`/ajax/illust/${illustId}`);
  }

  /** 作品每一页的图片地址（R-18 必须登录才有值） */
  async illustPages(illustId) {
    const body = await this.requestJson(`/ajax/illust/${illustId}/pages`);
    return Array.isArray(body) ? body : [];
  }

  /**
   * 取作品的原图地址列表（先 pages，取不到再退回 detail.urls.original）
   * @returns {Promise<{meta:object, urls:string[]}>}
   */
  async illustOriginalUrls(illustId) {
    const meta = await this.illustDetail(illustId);
    let urls = (await this.illustPages(illustId)).map((page) => page && page.urls && page.urls.original).filter(Boolean);
    if (!urls.length && meta && meta.urls && meta.urls.original) urls = [meta.urls.original];
    return { meta, urls };
  }

  /** 自己是否已登录（用一个轻量接口探测） */
  async checkLogin() {
    try {
      await this.requestJson('/ajax/user/self');
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = {
  WebSessionClient,
  WebSessionError,
  resolveCookie,
  cookiesToHeader,
  WEB_BASE,
  WEB_REFERER,
  WEB_UA,
};
