'use strict';
/**
 * src/pixiv/auth.js —— Pixiv 鉴权（零依赖）
 *
 * 职责：
 *   1. 协议常量与「伪装官方 Android 客户端」的请求头
 *   2. X-Client-Time / X-Client-Hash 计算（Pixiv 用它校验请求时效）
 *   3. OAuth PKCE：生成 code_verifier / code_challenge / 登录链接
 *   4. token 交换与刷新（纯函数式：传入 http 客户端，返回 response 对象，不持有状态）
 *
 * 关于 CLIENT_ID / CLIENT_SECRET / HASH_SECRET：
 *   这三个是 Pixiv 官方 App 内置的**公开协议常量**（所有第三方客户端都在用），
 *   不是用户凭据、也与任何账号绑定。仍支持环境变量覆盖，避免「写死」。
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
 * 为什么自己拼：Pixiv 校验 X-Client-Time 与 X-Client-Hash 的一致性；旧实现用 moment().format()
 * 输出这种带偏移的本地时间，用 toISOString()（UTC+Z）格式不同。为最大限度兼容官方客户端行为，保持一致格式。
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
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    usp.append(key, String(value));
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

/** 用授权码换 token（PKCE 第二步）；返回 Pixiv 的 response 对象 */
async function exchangeCode(http, code, codeVerifier) {
  const res = await http.request(OAUTH_URL, {
    method: 'POST',
    headers: defaultHeaders(),
    body: qs({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      code_verifier: codeVerifier,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      include_policy: true,
    }),
    parseJson: true,
  });
  return pickResponse(res);
}

/** 用 refresh_token 换 access_token；返回 Pixiv 的 response 对象 */
async function refreshAccessToken(http, refreshToken) {
  const res = await http.request(OAUTH_URL, {
    method: 'POST',
    headers: defaultHeaders(),
    body: qs({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      get_secure_url: true,
      include_policy: true,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
    parseJson: true,
  });
  return pickResponse(res);
}

/** 从 token 响应里取 response（Pixiv 把结果包在 response 字段）；失败抛错 */
function pickResponse(res) {
  const json = res.json;
  if (res.status >= 400 || (json && json.error)) {
    const detail = json && json.error
      ? (typeof json.error === 'string' ? json.error : (json.error.user_message || json.error.message))
      : `HTTP ${res.status}`;
    const err = new Error(`鉴权失败：${detail}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  if (!json || !json.response) {
    throw new Error('鉴权失败：响应缺少 response 字段');
  }
  return json.response;
}

module.exports = {
  BASE_URL,
  OAUTH_URL,
  LOGIN_URL,
  REDIRECT_URI,
  CLIENT_ID,
  CLIENT_SECRET,
  APP_HEADERS,
  isoLocalWithOffset,
  clientHash,
  defaultHeaders,
  createPkce,
  qs,
  exchangeCode,
  refreshAccessToken,
};
