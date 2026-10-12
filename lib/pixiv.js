'use strict';
/**
 * lib/pixiv.js —— Pixiv App API 客户端（零依赖）
 *
 * 职责：
 *   1. OAuth PKCE 登录（生成登录链接 → 用户浏览器授权 → 回调 code 换 token）
 *   2. refresh_token 换取 access_token（自动续期，401 时自动刷新一次并重试）
 *   3. 本项目用到的端点封装：关注列表 / 画师作品 / 收藏 / 作品详情 / 动图元数据 / 分页
 *
 * 鉴权要点（照抄 Pixiv 官方 Android 客户端协议，缺一不可）：
 *   - 请求头 X-Client-Time（本地时间带时区偏移）+ X-Client-Hash = md5(X-Client-Time + HASH_SECRET)
 *   - 业务请求额外带 Authorization: Bearer <access_token>
 *   - App-OS / App-OS-Version / App-Version / User-Agent 必须伪装成官方 Android 客户端
 *
 * 关于 CLIENT_ID / CLIENT_SECRET / HASH_SECRET：
 *   这三个是 Pixiv 官方 App 内置的**公开协议常量**（所有第三方客户端都在用），
 *   不是用户凭据、也与任何账号绑定。仍支持用环境变量覆盖，避免「写死」。
 *   真正的用户凭据只有 refresh_token，它只保存在 .env（已 gitignore）。
 */

const crypto = require('node:crypto');

const BASE_URL = 'https://app-api.pixiv.net';
const OAUTH_URL = 'https://oauth.secure.pixiv.net/auth/token';
const LOGIN_URL = `${BASE_URL}/web/v1/login`;
const REDIRECT_URI = `${BASE_URL}/web/v1/users/auth/pixiv/callback`;

/** 官方 App 公开协议常量（env 可覆盖，见文件头说明） */
const CLIENT_ID = process.env.PXREPO_CLIENT_ID || 'MOBrBDS8blbauoSck0ZfDbtuzpyT';
const CLIENT_SECRET = process.env.PXREPO_CLIENT_SECRET || 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj';
const HASH_SECRET = process.env.PXREPO_HASH_SECRET || '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c';

/** 伪装官方 Android 客户端的固定请求头 */
const APP_HEADERS = Object.freeze({
  'App-OS': 'android',
  'App-OS-Version': '9.0',
  'App-Version': '5.0.234',
  'Accept-Language': 'en-us',
  'User-Agent': 'PixivAndroidApp/5.0.234 (Android 9.0; Pixel 3)',
});

/**
 * 本地时间 + 时区偏移（形如 2026-10-13T07:30:00+08:00）
 * 为什么要自己拼：Pixiv 校验 X-Client-Time 与 X-Client-Hash 的一致性，
 * 旧实现用 moment().format() 输出这种带偏移的本地时间；用 toISOString()（UTC+Z）格式不同，
 * 虽然哈希自洽，但为最大限度兼容官方客户端行为，这里保持一致格式。
 */
function isoLocalWithOffset(date = new Date()) {
  const pad = (n) => String(Math.abs(n)).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const off = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return `${ymd}T${hms}${off}`;
}

/** X-Client-Hash = md5(时间 + HASH_SECRET)（Node 内置 crypto 已提供 md5，无需自写） */
function clientHash(timeStr) {
  return crypto.createHash('md5').update(`${timeStr}${HASH_SECRET}`).digest('hex');
}

/** 每次请求都要新算时间与哈希（旧值复用会被判过期） */
function defaultHeaders() {
  const time = isoLocalWithOffset();
  return { ...APP_HEADERS, 'X-Client-Time': time, 'X-Client-Hash': clientHash(time) };
}

/** 组装查询串（替代 qs 依赖；空值不参与拼接） */
function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    usp.append(k, String(v));
  }
  return usp.toString();
}

/**
 * 生成 PKCE 参数与登录链接
 * code_verifier：32 字节随机数的 base64url；code_challenge：其 SHA256 的 base64url
 */
function createPkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const loginUrl = `${LOGIN_URL}?${qs({ code_challenge: codeChallenge, code_challenge_method: 'S256', client: 'pixiv-android' })}`;
  return { codeVerifier, codeChallenge, loginUrl };
}

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
   *        http 为 lib/http.js 的 createHttp 实例（共享代理/限速/重试）
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
  async request(pathOrUrl, { method = 'GET', headers = {}, form = null, _retried = false } = {}) {
    const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${BASE_URL}${pathOrUrl}`;
    const finalHeaders = { ...defaultHeaders(), ...headers };
    if (this.accessToken) finalHeaders.Authorization = `Bearer ${this.accessToken}`;
    let body;
    if (form) {
      body = qs(form);
      finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await this.http.request(url, { method, headers: finalHeaders, body, parseJson: true });
    if (res.status === 401 && this.refreshToken && !_retried) {
      await this.refreshAccessToken(this.refreshToken);
      return this.request(pathOrUrl, { method, headers, form, _retried: true });
    }
    if (res.status >= 400 || (res.json && res.json.error)) {
      const msg = extractErrorMessage(res.json, `HTTP ${res.status}`);
      throw new PixivError(msg, { status: res.status, body: res.json });
    }
    return res.json;
  }

  /** 用授权码换 token（PKCE 流程第二步） */
  async exchangeCode(code, codeVerifier) {
    const json = await this.request(OAUTH_URL, {
      method: 'POST',
      form: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
        include_policy: true,
      },
    });
    this.applyTokenResponse(json);
    return json;
  }

  /** 用 refresh_token 换新的 access_token（也用于首次「token 登录」） */
  async refreshAccessToken(refreshToken) {
    const json = await this.request(OAUTH_URL, {
      method: 'POST',
      form: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        get_secure_url: true,
        include_policy: true,
        grant_type: 'refresh_token',
        refresh_token: refreshToken || this.refreshToken,
      },
    });
    this.applyTokenResponse(json);
    return json;
  }

  /** 保存 token 响应（Pixiv 把结果包在 response 字段里） */
  applyTokenResponse(json) {
    const r = (json && json.response) || {};
    if (r.access_token) this.accessToken = r.access_token;
    if (r.refresh_token) this.refreshToken = r.refresh_token;
    if (r.user) this.user = r.user;
    return r;
  }

  // ── 以下为本项目实际用到的端点 ───────────────────────────────────────

  /** 当前登录用户（用于拉自己的关注列表） */
  userMe() {
    return this.request('/v1/user/me/state');
  }

  /** 画师资料 */
  userDetail(userId) {
    return this.request(`/v1/user/detail?${qs({ user_id: userId })}`);
  }

  /** 我的关注列表（restrict: public|private；分页用 offset 或 next_url） */
  userFollowing(userId, { restrict = 'public', offset } = {}) {
    return this.request(`/v1/user/following?${qs({ user_id: userId, restrict, offset })}`);
  }

  /** 画师的作品列表（type 固定 illust，只要插画不要小说） */
  userIllusts(userId, { type = 'illust', offset, filter } = {}) {
    return this.request(`/v1/user/illusts?${qs({ user_id: userId, type, offset, filter })}`);
  }

  /** 收藏的插画（restrict: public|private） */
  userBookmarksIllust(userId, { restrict = 'public', offset } = {}) {
    return this.request(`/v1/user/bookmarks/illust?${qs({ user_id: userId, restrict, offset })}`);
  }

  /** 单个作品详情（按 PID 下载时用） */
  illustDetail(illustId) {
    return this.request(`/v1/illust/detail?${qs({ illust_id: illustId })}`);
  }

  /** 动图（ugoira）帧元数据 */
  ugoiraMetadata(illustId) {
    return this.request(`/v1/ugoira/metadata?${qs({ illust_id: illustId })}`);
  }

  /** 直接请求 API 返回的 next_url（分页游标） */
  requestNext(nextUrl) {
    return this.request(nextUrl);
  }
}

module.exports = {
  PixivClient,
  PixivError,
  createPkce,
  defaultHeaders,
  isoLocalWithOffset,
  clientHash,
  qs,
  BASE_URL,
  OAUTH_URL,
  LOGIN_URL,
  REDIRECT_URI,
  APP_HEADERS,
};
