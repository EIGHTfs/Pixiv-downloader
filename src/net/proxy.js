'use strict';
/**
 * src/net/proxy.js —— 代理层（零依赖：node:http/https/tls/net）
 *
 * 支持两类代理：
 *   - http(s) 代理：https 目标走 CONNECT 隧道；http 目标走绝对 URI
 *   - socks5 / socks5h：手写握手（RFC 1928 认证协商/连接请求 + RFC 1929 用户名密码），
 *     域名交服务端解析（socks5h 语义）——本机 DNS 可能被污染，本地解析反而拿不到真 IP
 *
 * 不实现 socks4/socks4a（返回 null，调用方忽略）。
 * 为什么手写：零依赖项目不引入 socks-proxy-agent / https-proxy-agent。
 *
 * SOCKS5 握手实现说明：拆成「会话对象 + 三个阶段处理函数」（method/auth/connect），
 * 每个函数只处理自己那一段报文，避免一个上百行的巨型状态机（可读性与可测性都更好）。
 */

const http = require('node:http');
const tls = require('node:tls');
const net = require('node:net');
const { URL } = require('node:url');

/**
 * HTTPDNS 默认映射表（域名 → IP）
 * 用途：部分网络环境下 Pixiv 域名被污染/解析不到，直连 IP 可绕过。
 * 默认关闭（config.httpdns=false）；可用环境变量覆盖：PXREPO_HTTPDNS_MAP="host=ip,host=ip"
 * 注意：IP 会随时间失效，所以「直连失败必须能回退系统 DNS」是硬要求（见 src/net/http.js）。
 */
const DEFAULT_HOSTS = Object.freeze({
  'app-api.pixiv.net': '210.140.131.218',
  'oauth.secure.pixiv.net': '210.140.131.218',
  'i.pximg.net': '210.140.92.138',
});

/** SOCKS5 应答码 → 中文说明（便于排错，不用去翻 RFC） */
const SOCKS5_REP = Object.freeze({
  0x01: '通用失败',
  0x02: '连接不被允许',
  0x03: '网络不可达',
  0x04: '主机不可达',
  0x05: '连接被拒绝',
  0x06: 'TTL 过期',
  0x07: '不支持的命令',
  0x08: '不支持的地址类型',
});

/** SOCKS5 协议常量（避免满屏裸数字） */
const SOCKS5 = Object.freeze({
  VERSION: 0x05,
  AUTH_VERSION: 0x01,
  METHOD_NO_AUTH: 0x00,
  METHOD_USERPASS: 0x02,
  METHOD_NONE_ACCEPTABLE: 0xff,
  CMD_CONNECT: 0x01,
  ATYP_IPV4: 0x01,
  ATYP_DOMAIN: 0x03,
  ATYP_IPV6: 0x04,
  AUTH_OK: 0x00,
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

/**
 * 解析代理 URL
 * @returns {null|{protocol:'http'|'socks5',host:string,port:number,auth:string,secure?:boolean,raw:string}}
 */
function parseProxy(proxyUrl) {
  if (!proxyUrl) return null;
  const raw = String(proxyUrl).trim();
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const auth = parsed.username ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password || '')}` : '';
  if (/^socks5h?$/i.test(parsed.protocol.replace(':', ''))) {
    return { protocol: 'socks5', host: parsed.hostname, port: Number(parsed.port) || 1080, auth, raw };
  }
  if (/^https?:$/i.test(parsed.protocol)) {
    return {
      protocol: 'http',
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
      secure: parsed.protocol === 'https:',
      auth,
      raw,
    };
  }
  return null; // 其它协议（socks4 等）本期不支持
}

/** 带超时的 Promise 等待 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message || '操作超时')), ms); }),
  ]);
}

/** 把目标地址编码成 SOCKS5 的 ATYP + ADDR 字段（域名交服务端解析） */
function encodeTargetAddress(host, port) {
  let addr;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    addr = Buffer.concat([Buffer.from([SOCKS5.ATYP_IPV4]), Buffer.from(host.split('.').map(Number))]);
  } else if (host.includes(':')) {
    const parts = host.split(':').filter(Boolean);
    const bytes = Buffer.alloc(16);
    parts.slice(-8).forEach((seg, idx) => bytes.writeUInt16BE(Number.parseInt(seg, 16) || 0, idx * 2));
    addr = Buffer.concat([Buffer.from([SOCKS5.ATYP_IPV6]), bytes]);
  } else {
    const hostBuf = Buffer.from(host, 'utf8');
    addr = Buffer.concat([Buffer.from([SOCKS5.ATYP_DOMAIN, hostBuf.length]), hostBuf]);
  }
  return Buffer.concat([addr, Buffer.from([(port >> 8) & 0xff, port & 0xff])]);
}

/** 判断 CONNECT 应答报文总长度（VER+REP+RSV+ATYP + 地址 + PORT） */
function connectReplyLength(buf) {
  if (buf.length < 4) return 0;
  const atyp = buf[3];
  if (atyp === SOCKS5.ATYP_IPV4) return 4 + 4 + 2;
  if (atyp === SOCKS5.ATYP_IPV6) return 4 + 16 + 2;
  if (atyp === SOCKS5.ATYP_DOMAIN) return buf.length < 5 ? 0 : 4 + 1 + buf[4] + 2;
  return 4 + 2; // 未知类型：至少把固定头读掉，交由 REP 判定失败
}

/**
 * 创建一个 SOCKS5 会话（三阶段状态机）
 * @param {{socket:net.Socket, proxy:object, host:string, port:number, timeoutMs:number,
 *          onDone:Function, onFail:Function}} opts
 */
function createSocks5Session(opts) {
  const { socket, proxy, host, port, onDone, onFail } = opts;
  let buf = Buffer.alloc(0);
  let stage = 'method';
  let settled = false;

  const fail = (message) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    onFail(new Error(message));
  };
  const done = () => {
    if (settled) return;
    settled = true;
    socket.setTimeout(0);
    socket.removeAllListeners('data');
    onDone(socket);
  };

  /** 阶段一：认证协商 → 选择无认证或用户名密码 */
  const handleMethod = () => {
    const method = buf[1];
    buf = buf.subarray(2);
    if (method === SOCKS5.METHOD_NONE_ACCEPTABLE) return fail('SOCKS5 服务端不接受任何认证方式');
    if (method === SOCKS5.METHOD_USERPASS) return sendAuth();
    return sendConnect(); // 无认证
  };

  /** 阶段二：用户名密码认证（RFC 1929） */
  const handleAuth = () => {
    const status = buf[1];
    buf = buf.subarray(2);
    if (status !== SOCKS5.AUTH_OK) return fail(`SOCKS5 认证失败（status=${status}）`);
    return sendConnect();
  };

  /** 阶段三：CONNECT 应答（成功即拿到可用 socket） */
  const handleConnect = () => {
    const rep = buf[1];
    const need = connectReplyLength(buf);
    if (!need || buf.length < need) return undefined;
    if (rep !== 0x00) return fail(`SOCKS5 连接目标失败（REP=${rep}：${SOCKS5_REP[rep] || '未知'}）`);
    buf = buf.subarray(need);
    return done();
  };

  const handlers = { method: handleMethod, auth: handleAuth, connect: handleConnect };

  /** 发送认证报文 */
  const sendAuth = () => {
    if (!proxy.auth) return fail('SOCKS5 服务端要求用户名密码，但代理地址里没提供');
    const [user, pass] = proxy.auth.split(':');
    const userBuf = Buffer.from(user || '', 'utf8');
    const passBuf = Buffer.from(pass || '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([SOCKS5.AUTH_VERSION, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
    stage = 'auth';
    return undefined;
  };

  /** 发送 CONNECT 请求 */
  const sendConnect = () => {
    socket.write(Buffer.concat([Buffer.from([SOCKS5.VERSION, SOCKS5.CMD_CONNECT, 0x00]), encodeTargetAddress(host, port)]));
    stage = 'connect';
  };

  return {
    /** 连接建立后发问候（声明支持的认证方式） */
    start() {
      const methods = proxy.auth ? [SOCKS5.METHOD_NO_AUTH, SOCKS5.METHOD_USERPASS] : [SOCKS5.METHOD_NO_AUTH];
      socket.write(Buffer.from([SOCKS5.VERSION, methods.length, ...methods]));
    },
    /** 收到数据：按当前阶段处理；报文不足则等下一片 */
    feed(chunk) {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      handlers[stage]();
    },
    fail,
  };
}

/**
 * SOCKS5 握手：返回已连到目标的裸 TCP socket（https 目标需调用方再做 TLS 包装）
 */
function socks5Connect(proxy, target, timeoutMs) {
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const host = target.hostname;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const session = createSocks5Session({
      socket,
      proxy,
      host,
      port,
      timeoutMs,
      onDone: resolve,
      onFail: reject,
    });
    socket.setTimeout(timeoutMs, () => session.fail(`SOCKS5 握手超时（${proxy.raw}）`));
    socket.on('error', (err) => session.fail(`SOCKS5 连接失败 ${proxy.host}:${proxy.port}：${err.code || err.message}`));
    socket.on('connect', () => session.start());
    socket.on('data', (chunk) => session.feed(chunk));
  });
}

/** 打开到目标主机的 CONNECT 隧道（http 代理 + https 目标） */
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

/** 建立到目标的裸 socket（socks5 握手 或 http 代理 CONNECT） */
async function createRawSocket(url, proxy, timeoutMs) {
  if (proxy.protocol === 'socks5') return socks5Connect(proxy, url, timeoutMs);
  return openTunnel(proxy, url, timeoutMs);
}

/** 把裸 socket 包装成 TLS（https 目标经代理时必须显式做，Node 不会自动包） */
async function wrapTls(socket, url, timeoutMs) {
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

module.exports = {
  DEFAULT_HOSTS,
  SOCKS5_REP,
  SOCKS5,
  resolveHosts,
  pickProxy,
  parseProxy,
  socks5Connect,
  createSocks5Session,
  encodeTargetAddress,
  createRawSocket,
  wrapTls,
  withTimeout,
};
