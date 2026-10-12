'use strict';
/**
 * src/net/http.js —— 请求层（零依赖：node:http/https/zlib）
 *
 * 职责：
 *   1. 统一请求入口：超时、失败重试（指数退避）、429/5xx 退避、Retry-After 支持
 *   2. 响应体自动解压（gzip/deflate/br）
 *   3. 连接方式分派：直连 / 可选 HTTPDNS 直连 / http(s) 代理 / socks5 代理
 *      （代理与 SOCKS5 握手的实现在 ./proxy.js；限速器在 ./limiter.js）
 *
 * 重试策略：只覆盖「连接失败 / 超时 / 429 / 5xx」；4xx（除 429）直接抛，不浪费配额。
 */

const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { URL } = require('node:url');

const {
  parseProxy,
  pickProxy,
  resolveHosts,
  createRawSocket,
  wrapTls,
} = require('./proxy.js');
const { createRateLimiter, sleep } = require('./limiter.js');

/** 按 content-encoding 解压响应体（解压失败原样返回，交由上层判断） */
function decodeBody(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer);
    if (enc.includes('deflate')) return zlib.inflateSync(buffer);
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer);
  } catch {
    return buffer;
  }
  return buffer;
}

/**
 * 单次请求（不做重试）
 * @param {string} target 绝对 URL
 * @param {object} opts { method, headers, body, timeoutMs, stream, parseJson, retries }
 * @param {object} config 配置（proxy/httpdns/timeoutMs）
 * @returns {Promise<{status:number, headers:object, body?:Buffer, text?:string, json?:any, res?:object, url:string}>}
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

    /** 用已建立的 socket 发请求（代理分支共用） */
    const issue = (socket) => {
      const mod = isHttps ? https : http;
      const req = mod.request(
        {
          method,
          path,
          headers: { ...headers, Host: url.host },
          createConnection: () => socket,
          timeout: timeoutMs,
        },
        onResponse
      );
      req.on('timeout', () => req.destroy(new Error(`请求超时：${url.href}`)));
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    };

    try {
      // ── 分支 A：SOCKS5 代理（http/https 目标都走这里） ──────────────
      if (proxy && proxy.protocol === 'socks5') {
        createRawSocket(url, proxy, timeoutMs)
          .then((socket) => (isHttps ? wrapTls(socket, url, timeoutMs) : socket))
          .then(issue)
          .catch(reject);
        return;
      }

      // ── 分支 B：http 代理 + https 目标 → CONNECT 隧道 + TLS ─────────
      if (proxy && proxy.protocol === 'http' && isHttps) {
        createRawSocket(url, proxy, timeoutMs)
          .then((socket) => wrapTls(socket, url, timeoutMs))
          .then(issue)
          .catch(reject);
        return;
      }

      // ── 分支 C：http 代理 + http 目标 → 绝对 URI 请求代理 ────────────
      if (proxy && proxy.protocol === 'http' && !isHttps) {
        const proxyHeaders = { ...headers, Host: url.host };
        if (proxy.auth) proxyHeaders['Proxy-Authorization'] = `Basic ${Buffer.from(proxy.auth).toString('base64')}`;
        const req = http.request(
          { host: proxy.host, port: proxy.port, method, path: url.href, headers: proxyHeaders, timeout: timeoutMs },
          onResponse
        );
        req.on('timeout', () => req.destroy(new Error(`请求超时：${url.href}`)));
        req.on('error', reject);
        if (opts.body) req.write(opts.body);
        req.end();
        return;
      }

      // ── 分支 D：直连（可选 HTTPDNS 把域名换 IP，保留 Host + SNI） ────
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
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    } catch (err) {
      reject(err);
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
    || /超时|timeout|SOCKS5/i.test(err.message || '');
}

/** 指数退避等待：1s、2s、4s…（上限 30s），429 优先用 Retry-After */
function backoffMs(attempt, headers) {
  if (headers && headers['retry-after']) {
    const sec = Number.parseInt(headers['retry-after'], 10);
    if (Number.isFinite(sec) && sec > 0) return Math.min(sec * 1000, 120000);
  }
  return Math.min(1000 * 2 ** attempt, 30000);
}

/**
 * 创建带重试与限速的客户端
 * @param {object} config 见 src/config.js
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
        // HTTPDNS 直连失败 → 关掉直连回退系统 DNS 再试（IP 失效是常态）
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

module.exports = {
  createHttp,
  requestOnce,
  shouldRetry,
  backoffMs,
  decodeBody,
  // 便于调用方/测试从同一入口取代理与限速工具（实现分别在 ./proxy.js、./limiter.js）
  parseProxy,
  pickProxy,
  resolveHosts,
  createRateLimiter,
  sleep,
};
