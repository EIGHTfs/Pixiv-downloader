'use strict';
/**
 * lib/http.js —— 网络层（零依赖，只用 node:http/https/tls/zlib）
 *
 * 职责：
 *   1. 统一请求入口：超时、失败重试（指数退避）、429/5xx 退避
 *   2. 代理支持：仅 http(s) 代理（https 目标走 CONNECT 隧道；http 目标走绝对 URI）
 *   3. 可选 HTTPDNS：按映射表把域名换成 IP 直连（保留 Host + SNI），失败自动回退系统 DNS
 *   4. 响应体自动解压（gzip/deflate/br）
 *   5. 全局 TPS 限速器（供 API 与下载共用，避免触发风控）
 *
 * 设计取舍：
 *   - 不引入 axios/node-fetch：Node 内置 https 足够，且能精确控制 socket/超时
 *   - 重试只覆盖「连接失败 / 超时 / 429 / 5xx」；4xx（除 429）直接抛，不浪费配额
 *   - 不实现 SOCKS：零依赖下需自写握手协议，本期明确不做（见方案「后续优化清单」）
 */

const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { URL } = require('node:url');

/**
 * HTTPDNS 默认映射表（域名 → IP）
 * 用途：部分网络环境下 Pixiv 域名被污染/解析不到，直连 IP 可绕过。
 * 默认关闭（config.httpdns=false）；可用环境变量覆盖：PXREPO_HTTPDNS_MAP="host=ip,host=ip"
 * 注意：IP 会随时间失效，所以「直连失败必须能回退系统 DNS」是硬要求（见 requestOnce）。
 */
const DEFAULT_HOSTS = Object.freeze({
  'app-api.pixiv.net': '210.140.131.218',
  'oauth.secure.pixiv.net': '210.140.131.218',
  'i.pximg.net': '210.140.92.138',
});

/** 解析 HTTPDNS 映射（env 覆盖 > 内置默认） */
function resolveHosts() {
  const raw = process.env.PXREPO_HTTPDNS_MAP;
  if (!raw) return { ...DEFAULT_HOSTS };
  const out = { ...DEFAULT_HOSTS };
  for (const pair of String(raw).split(',')) {
    const [host, ip] = pair.split('=').map((s) => (s || '').trim());
    if (host && ip) out[host] = ip;
  }
  return out;
}

/** 取代理地址：config.proxy 优先；'disable' = 强制不走代理；空 = 读环境变量 */
function pickProxy(config = {}) {
  const configured = String(config.proxy || '').trim();
  if (configured.toLowerCase() === 'disable') return '';
  if (configured) return configured;
  return (
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy || ''
  );
}

/** 解析代理 URL（只认 http/https；socks 会被忽略并在调用处提示） */
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(proxyUrl) ? proxyUrl : `http://${proxyUrl}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null; // 非 http(s) 代理（如 socks）本期不支持
  const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}` : '';
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    secure: u.protocol === 'https:',
    auth,
    raw: proxyUrl,
  };
}

/** 带超时的 Promise 等待（避免外部依赖 timers/promises 的版本差异） */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message || '操作超时')), ms); }),
  ]);
}

/** 打开到目标主机的 CONNECT 隧道（https 走代理时必须） */
function openTunnel(proxy, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = Number(targetUrl.port) || 443;
    const headers = {};
    if (proxy.auth) headers['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${port}`,
      headers,
      timeout: timeoutMs,
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败：${res.statusCode}（${proxy.raw}）`));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => req.destroy(new Error(`代理连接超时：${proxy.raw}`)));
    req.on('error', reject);
    req.end();
  });
}

/** 建立到目标的 socket（含代理隧道 + TLS 包装） */
async function createSocket(url, proxy, timeoutMs) {
  const socket = await openTunnel(proxy, url, timeoutMs);
  const tlsSocket = tls.connect({ socket, servername: url.hostname });
  await withTimeout(
    new Promise((resolve, reject) => {
      tlsSocket.once('secureConnect', resolve);
      tlsSocket.once('error', reject);
    }),
    timeoutMs,
    'TLS 握手超时'
  );
  return tlsSocket;
}

/** 按 content-encoding 解压响应体 */
function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
  } catch {
    return buffer; // 解压失败就原样返回，交由上层判断
  }
  return buffer;
}

/**
 * 单次请求（不做重试）
 * @param {string} target 绝对 URL
 * @param {object} opts { method, headers, body, timeoutMs, stream }
 * @param {object} config 配置（proxy/httpdns/timeoutMs）
 * @returns {Promise<{status:number, headers:object, body?:Buffer, text?:string, json?:any, res?:object, url:string}>}
 *          stream=true 时返回未消费的 res（由调用方 pipe 到文件）
 */
function requestOnce(target, opts = {}, config = {}) {
  const url = new URL(target);
  const isHttps = url.protocol === 'https:';
  const timeoutMs = opts.timeoutMs || config.timeoutMs || 30000;
  const proxy = parseProxy(pickProxy(config));
  const hosts = config.httpdns ? resolveHosts() : {};
  const directIp = hosts[url.hostname];
  const headers = { ...(opts.headers || {}) };
  const method = (opts.method || 'GET').toUpperCase();
  const path = `${url.pathname}${url.search}`;

  return new Promise((resolve, reject) => {
    const onResponse = (res) => {
      // 流式：直接把响应交给调用方（图片下载用）
      if (opts.stream) {
        resolve({ status: res.statusCode, headers: res.headers, res, url: url.href });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = decodeBody(Buffer.concat(chunks), res.headers['content-encoding']);
        const out = { status: res.statusCode, headers: res.headers, body, url: url.href };
        out.text = body.toString('utf8');
        if (opts.parseJson) {
          try { out.json = JSON.parse(out.text); } catch { out.json = null; }
        }
        resolve(out);
      });
      res.on('error', reject);
    };

    const fail = (err) => reject(err);

    try {
      // ── 分支 A：https 目标 + 代理 → CONNECT 隧道 + TLS ──────────────
      if (isHttps && proxy) {
        createSocket(url, proxy, timeoutMs).then((socket) => {
          const req = https.request(
            {
              method,
              path,
              headers: { ...headers, Host: url.hostname },
              createConnection: () => socket, // 复用已建立的 TLS socket
              timeout: timeoutMs,
            },
            onResponse
          );
          req.on('timeout', () => req.destroy(new Error(`请求超时：${url.href}`)));
          req.on('error', fail);
          if (opts.body) req.write(opts.body);
          req.end();
        }).catch(fail);
        return;
      }

      // ── 分支 B：http 目标 + 代理 → 绝对 URI 请求代理 ────────────────
      if (!isHttps && proxy) {
        const proxyHeaders = { ...headers, Host: url.host };
        if (proxy.auth) proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
        const req = http.request(
          { host: proxy.host, port: proxy.port, method, path: url.href, headers: proxyHeaders, timeout: timeoutMs },
          onResponse
        );
        req.on('timeout', () => req.destroy(new Error(`请求超时：${url.href}`)));
        req.on('error', fail);
        if (opts.body) req.write(opts.body);
        req.end();
        return;
      }

      // ── 分支 C：直连（可选 HTTPDNS 把域名换 IP，保留 Host + SNI） ────
      const useIp = Boolean(directIp);
      const options = {
        method,
        path,
        headers: useIp ? { ...headers, Host: url.hostname } : headers,
        timeout: timeoutMs,
        host: useIp ? directIp : url.hostname,
        port: Number(url.port) || (isHttps ? 443 : 80),
      };
      if (isHttps && useIp) options.servername = url.hostname; // SNI 必须用真实域名，否则证书校验失败
      const mod = isHttps ? https : http;
      const req = mod.request(options, onResponse);
      req.on('timeout', () => req.destroy(new Error(`请求超时：${url.href}`)));
      req.on('error', fail);
      if (opts.body) req.write(opts.body);
      req.end();
    } catch (err) {
      fail(err);
    }
  });
}

/** 判断是否值得重试：连接类错误 / 429 / 5xx */
function shouldRetry(err, status) {
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (!err) return false;
  const code = err.code || '';
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
    || /超时|timeout/i.test(err.message || '');
}

/** 指数退避等待：1s、2s、4s…（上限 30s），429 优先用 Retry-After */
function backoffMs(attempt, headers) {
  if (headers && headers['retry-after']) {
    const sec = Number.parseInt(headers['retry-after'], 10);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 120000);
  }
  return Math.min(1000 * 2 ** attempt, 30000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 创建带重试与限速的客户端
 * @param {object} config 见 lib/config.js
 */
function createHttp(config = {}) {
  const proxy = parseProxy(pickProxy(config));
  const retries = Number.isFinite(config.retries) ? config.retries : 3;
  const limiter = createRateLimiter(config.tps);

  /** 带重试的请求 */
  async function request(target, opts = {}) {
    const maxRetry = opts.retries !== undefined ? opts.retries : retries;
    let lastErr = null;
    for (let attempt = 0; attempt <= maxRetry; attempt++) {
      await limiter.wait(); // 全局限速：每次请求前取一个令牌
      try {
        const res = await requestOnce(target, opts, config);
        if (shouldRetry(null, res.status) && attempt < maxRetry) {
          await sleep(backoffMs(attempt, res.headers));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        // HTTPDNS 直连失败 → 关掉直连回退系统 DNS 再试一次（IP 失效是常态）
        if (config.httpdns && /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|超时|socket hang up/i.test(String(err.code || err.message))) {
          config.httpdns = false;
        }
        if (attempt < maxRetry && shouldRetry(err, 0)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('请求失败');
  }

  /** 便捷方法 */
  const getJson = (target, headers) => request(target, { headers, parseJson: true });
  const postForm = (target, formBody, headers) => request(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(headers || {}) },
    body: formBody,
    parseJson: true,
  });

  return {
    request,
    getJson,
    postForm,
    /** 流式下载（返回未消费的 res，调用方 pipe 到文件） */
    stream: (target, opts = {}) => request(target, { ...opts, stream: true, retries: opts.retries !== undefined ? opts.retries : 1 }),
    /** 本次生效的代理（用于启动日志） */
    proxyInfo: proxy,
    limiter,
  };
}

/**
 * 令牌桶式限速器：tps 为每秒请求数（0 = 不限速）
 * 用途：Pixiv API 与图片下载共用同一个实例，避免并发过高触发 429
 */
function createRateLimiter(tps) {
  const rate = Number(tps) || 0;
  if (rate <= 0) return { wait: async () => {}, intervalMs: 0 };
  const intervalMs = 1000 / rate;
  let nextAllowed = 0;
  return {
    intervalMs,
    wait: async () => {
      const now = Date.now();
      const at = Math.max(now, nextAllowed);
      nextAllowed = at + intervalMs;
      const delay = at - now;
      if (delay > 0) await sleep(delay);
    },
  };
}

module.exports = {
  createHttp,
  createRateLimiter,
  parseProxy,
  pickProxy,
  resolveHosts,
  DEFAULT_HOSTS,
  requestOnce,
  shouldRetry,
  backoffMs,
};
