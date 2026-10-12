'use strict';
/**
 * src/pixiv/client.js —— Pixiv App API 客户端（零依赖）
 *
 * 职责：持有 token 状态 + 封装本项目用到的端点（关注 / 画师作品 / 收藏 / 作品详情 / 动图元数据 / 分页）
 * 鉴权细节（协议常量、X-Client-Time/Hash、PKCE、token 交换）在 ./auth.js
 *
 * 鉴权要点：业务请求带 Authorization: Bearer <access_token>；401 时自动刷新 token 重试一次。
 */

const auth = require('./auth.js');

/** API 错误（带状态码与 Pixiv 的错误信息，便于上层判断 404/429 等） */
class PixivError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'PixivError';
    this.status = status;
    this.body = body;
  }
}

/** 从响应体里提取 Pixiv 的错误信息（形如 {error:{user_message,message}}） */
function extractErrorMessage(json, fallback) {
  if (!json) return fallback;
  if (json.error) {
    if (typeof json.error === 'string') return json.error;
    return json.error.user_message || json.error.message || fallback;
  }
  return json.message || fallback;
}

class PixivClient {
  /**
   * @param {{http:object, refreshToken?:string, accessToken?:string}} opts
   *        http 为 src/net/http.js 的 createHttp 实例（共享代理/限速/重试）
   */
  constructor({ http, refreshToken = '', accessToken = '' } = {}) {
    this.http = http;
    this.refreshToken = refreshToken;
    this.accessToken = accessToken;
    this.user = null; // 登录后填充（含 user.id，用于拉自己的关注列表）
  }

  get loggedIn() {
    return Boolean(this.accessToken);
  }

  /** 业务请求统一入口：默认头 + Bearer；401 时自动刷新 token 重试一次 */
  async request(pathOrUrl, { method = 'GET', headers = {}, form = null, retried = false } = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${auth.BASE_URL}${pathOrUrl}`;
    const finalHeaders = { ...auth.defaultHeaders(), ...headers };
    if (this.accessToken) finalHeaders.Authorization = `Bearer ${this.accessToken}`;
    let body;
    if (form) {
      body = auth.qs(form);
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.http.request(url, { method, headers: finalHeaders, body, parseJson: true });
    if (res.status === 401 && this.refreshToken && !retried) {
      await this.refresh();
      return this.request(pathOrUrl, { method, headers, form, retried: true });
    }
    if (res.status >= 400 || (res.json && res.json.error)) {
      const message = extractErrorMessage(res.json, `HTTP ${res.status}`);
      throw new PixivError(message, { status: res.status, body: res.json });
    }
    return res.json;
  }

  /** 保存 token 响应（Pixiv 把结果包在 response 字段里） */
  applyTokenResponse(response) {
    const data = response || {};
    if (data.access_token) this.accessToken = data.access_token;
    if (data.refresh_token) this.refreshToken = data.refresh_token;
    if (data.user) this.user = data.user;
    return data;
  }

  /** 用授权码换 token（PKCE 第二步） */
  async exchangeCode(code, codeVerifier) {
    const response = await auth.exchangeCode(this.http, code, codeVerifier);
    this.applyTokenResponse(response);
    return response;
  }

  /** 用 refresh_token 换新 access_token（也用于「token 登录」） */
  async refresh(refreshToken) {
    const token = refreshToken || this.refreshToken;
    const response = await auth.refreshAccessToken(this.http, token);
    this.applyTokenResponse(response);
    return response;
  }

  // ── 以下为本项目实际用到的端点 ───────────────────────────────────────

  /** 当前登录用户（用于拉自己的关注列表） */
  userMe() {
    return this.request('/v1/user/me/state');
  }

  /** 画师资料 */
  userDetail(userId) {
    return this.request(`/v1/user/detail?${auth.qs({ user_id: userId })}`);
  }

  /** 我的关注列表（restrict: public|private；分页用 offset 或 next_url） */
  userFollowing(userId, { restrict = 'public', offset } = {}) {
    return this.request(`/v1/user/following?${auth.qs({ user_id: userId, restrict, offset })}`);
  }

  /** 画师的作品列表（type 固定 illust，只要插画不要小说） */
  userIllusts(userId, { type = 'illust', offset, filter } = {}) {
    return this.request(`/v1/user/illusts?${auth.qs({ user_id: userId, type, offset, filter })}`);
  }

  /** 收藏的插画（restrict: public|private） */
  userBookmarksIllust(userId, { restrict = 'public', offset } = {}) {
    return this.request(`/v1/user/bookmarks/illust?${auth.qs({ user_id: userId, restrict, offset })}`);
  }

  /** 单个作品详情（按 PID 下载时用） */
  illustDetail(illustId) {
    return this.request(`/v1/illust/detail?${auth.qs({ illust_id: illustId })}`);
  }

  /** 动图（ugoira）帧元数据 */
  ugoiraMetadata(illustId) {
    return this.request(`/v1/ugoira/metadata?${auth.qs({ illust_id: illustId })}`);
  }

  /** 直接请求 API 返回的 next_url（分页游标） */
  requestNext(nextUrl) {
    return this.request(nextUrl);
  }
}

module.exports = {
  PixivClient,
  PixivError,
  extractErrorMessage,
  // 透传鉴权工具，调用方可以只 require 本模块
  createPkce: auth.createPkce,
  defaultHeaders: auth.defaultHeaders,
  isoLocalWithOffset: auth.isoLocalWithOffset,
  clientHash: auth.clientHash,
  qs: auth.qs,
  BASE_URL: auth.BASE_URL,
  OAUTH_URL: auth.OAUTH_URL,
  LOGIN_URL: auth.LOGIN_URL,
  REDIRECT_URI: auth.REDIRECT_URI,
  APP_HEADERS: auth.APP_HEADERS,
};
