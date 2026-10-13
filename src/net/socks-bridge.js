'use strict';
/**
 * src/net/socks-bridge.js —— 本地代理桥（把「HTTP CONNECT 代理」转成上游 SOCKS5/HTTP 代理）
 *
 * 为什么需要它：
 *   实测同一个 SOCKS5 代理，本项目的网络层（src/net/proxy.js）能通，而 Chromium 报
 *   `ERR_SOCKS_CONNECTION_FAILED`。Chromium 对 SOCKS5 的兼容性/握手偏好与自研实现不同，
 *   而它对 **HTTP CONNECT 代理** 的支持非常稳定。
 *   于是：本地起一个 HTTP CONNECT 代理，收到 CONNECT 后用自研 SOCKS5 连上游，
 *   再把字节双向转发——Chromium 只需要认识「本地 HTTP 代理」。
 *
 * 用途：无头浏览器登录（test/pixiv-web-login.mjs）等需要浏览器走代理的场景。
 *
 * 用法：
 *   const { startBridge } = require('./socks-bridge.js');
 *   const bridge = await startBridge({ upstream: parseProxy('socks5h://ip:port'), timeoutMs: 30000 });
 *   // 浏览器用 --proxy-server=http://127.0.0.1:${bridge.port}
 *   await bridge.close();
 */

const http = require('node:http');
const { createRawSocket } = require('./proxy.js');

/**
 * 启动本地桥
 * @param {{upstream:object, timeoutMs?:number, onError?:(e:Error)=>void}} opts
 *        upstream 为 src/net/proxy.js 的 parseProxy 结果（socks5 或 http 均可）
 * @returns {Promise<{server:http.Server, port:number, close:()=>Promise<void>, stats:{connects:number, failures:number}}>}
 */
function startBridge(opts) {
  const { upstream, timeoutMs = 30000 } = opts || {};
  if (!upstream) return Promise.reject(new Error('startBridge 需要 upstream 代理（parseProxy 结果）'));
  const stats = { connects: 0, failures: 0 };

  const server = http.createServer((req, res) => {
    // 只做 CONNECT 隧道；普通 HTTP 请求不支持（Pixiv 全站 https，够用）
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('bridge: only CONNECT is supported\n');
  });

  server.on('connect', (req, clientSocket, head) => {
    const [host, portText] = String(req.url || '').split(':');
    const port = Number(portText) || 443;
    stats.connects += 1;

    // 目标统一按 https 处理：SOCKS5 会把域名交给上游解析（远程 DNS），避免本机 DNS 污染
    const target = { protocol: 'https:', hostname: host, port };

    clientSocket.on('error', () => clientSocket.destroy());
    createRawSocket(target, upstream, timeoutMs)
      .then((upstreamSocket) => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) upstreamSocket.write(head);
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
        upstreamSocket.on('error', () => clientSocket.destroy());
      })
      .catch((err) => {
        stats.failures += 1;
        if (opts && typeof opts.onError === 'function') opts.onError(err);
        try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* 已断开 */ }
        clientSocket.destroy();
      });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        stats,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

module.exports = { startBridge };
