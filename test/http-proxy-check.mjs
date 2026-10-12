#!/usr/bin/env node
/**
 * test/http-proxy-check.mjs —— src/net/http.js 代理链路自检
 *
 * 为什么要这个测试：
 *   公开代理批量探测全失败时，必须能区分「代理都是死的」与「我的 CONNECT 实现有 bug」。
 *   本测试在本地起一个真实 CONNECT 代理（node:http 的 connect 事件 + net 转发），
 *   让 src/net/http.js 走完整链路：CONNECT 隧道 → TLS 包装 → HTTP 请求 → 响应解压。
 *   因此它不依赖任何外部代理，可离线复现。
 *
 * 覆盖场景：
 *   1. 经本地 CONNECT 代理请求 https 站点 → 200 且 body 可解析
 *   2. 代理要求 Basic 认证时，src/net/http.js 正确带上 Proxy-Authorization
 *   3. 代理认证失败（407）时报错信息清晰
 *   4. 代理端口不通时报错清晰
 *
 * 用法：node test/http-proxy-check.mjs
 */

import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { createHttp } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'net', 'http.js'));

const TARGET = process.env.PROBE_TARGET || 'https://api.github.com/';

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/**
 * 启动本地 CONNECT 代理
 * @param {{requireAuth?: boolean}} opts requireAuth=true 时校验 Proxy-Authorization
 */
function startProxy(opts = {}) {
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    if (opts.requireAuth) {
      const expected = `Basic ${Buffer.from('user:pw').toString('base64')}`;
      if ((req.headers['proxy-authorization'] || '') !== expected) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        clientSocket.destroy();
        return;
      }
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * 启动本地 SOCKS5 代理（手写最小实现，用于验证 src/net/http.js 的 SOCKS5 客户端）
 * 只实现 CONNECT 命令 + 可选用户名密码认证，够验证链路即可。
 * @param {{requireAuth?: boolean}} opts
 */
function startSocks5Proxy(opts = {}) {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let stage = 'method';
    const reply = (bytes) => socket.write(Buffer.from(bytes));
    socket.on('error', () => socket.destroy());

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (stage === 'method') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = buf.subarray(2, 2 + n);
        buf = buf.subarray(2 + n);
        if (opts.requireAuth) {
          if (!methods.includes(0x02)) { reply([0x05, 0xff]); socket.end(); return; }
          reply([0x05, 0x02]);
          stage = 'auth';
        } else {
          reply([0x05, 0x00]);
          stage = 'request';
        }
        return;
      }

      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        if (user === 'user' && pass === 'pw') { reply([0x01, 0x00]); stage = 'request'; }
        else { reply([0x01, 0x01]); socket.end(); }
        return;
      }

      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host;
        let cursor;
        if (atyp === 0x01) {
          if (buf.length < 10) return;
          host = buf.subarray(4, 8).join('.');
          cursor = 8;
        } else if (atyp === 0x03) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString();
          cursor = 5 + len;
        } else {
          reply([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // 地址类型不支持
          socket.end();
          return;
        }
        const port = buf.readUInt16BE(cursor);
        buf = buf.subarray(cursor + 2);
        stage = 'relay';
        const upstream = net.connect(port, host, () => {
          reply([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); // 成功
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on('error', () => {
          try { reply([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); } catch { /* 已断开 */ }
          socket.destroy();
        });
        return;
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // 场景 1：无认证代理
  const plain = await startProxy();
  const c1 = createHttp({ proxy: `http://127.0.0.1:${plain.port}`, timeoutMs: 15000, retries: 0, tps: 0 });
  try {
    const res = await c1.request(TARGET, { headers: { 'User-Agent': 'pxrepo-proxy-check' }, retries: 0 });
    assert('① 经 CONNECT 代理取到响应', res.status > 0, `status=${res.status}`);
    assert('② 响应体已解压可读', Buffer.isBuffer(res.body) && res.body.length > 0, `bytes=${res.body ? res.body.length : 0}`);
    assert('③ 状态码为 2xx', res.status >= 200 && res.status < 300, `status=${res.status}`);
  } catch (err) {
    assert('① 经 CONNECT 代理取到响应', false, String(err.message));
    assert('② 响应体已解压可读', false, '未执行');
    assert('③ 状态码为 2xx', false, '未执行');
  } finally {
    plain.server.close();
  }

  // 场景 2：需要 Basic 认证（正确凭据）
  // 注意：代理实例要活到场景 3 之后才能关——场景 3 还要用它验证「凭据错误 → 407」，
  //       提前 close 会让场景 3 变成 ECONNREFUSED（这是测试自身的坑，不是 lib 的问题）。
  const authd = await startProxy({ requireAuth: true });
  const c2 = createHttp({ proxy: `http://user:pw@127.0.0.1:${authd.port}`, timeoutMs: 15000, retries: 0, tps: 0 });
  try {
    const res = await c2.request(TARGET, { headers: { 'User-Agent': 'pxrepo-proxy-check' }, retries: 0 });
    assert('④ 代理认证头正确（407 未触发）', res.status >= 200 && res.status < 300, `status=${res.status}`);
  } catch (err) {
    assert('④ 代理认证头正确（407 未触发）', false, String(err.message));
  }

  // 场景 3：凭据错误 → 407 应转成明确错误
  const wrong = createHttp({ proxy: `http://bad:bad@127.0.0.1:${authd.port}`, timeoutMs: 8000, retries: 0, tps: 0 });
  try {
    await wrong.request(TARGET, { headers: { 'User-Agent': 'pxrepo-proxy-check' }, retries: 0 });
    assert('⑤ 代理认证失败报错清晰', false, '未抛错');
  } catch (err) {
    assert('⑤ 代理认证失败报错清晰', /407|CONNECT/.test(String(err.message)), String(err.message).slice(0, 80));
  } finally {
    authd.server.close();
  }

  // 场景 4：代理端口不通
  const dead = createHttp({ proxy: 'http://127.0.0.1:1', timeoutMs: 4000, retries: 0, tps: 0 });
  try {
    await dead.request(TARGET, { retries: 0 });
    assert('⑥ 代理不通时报错清晰', false, '未抛错');
  } catch (err) {
    assert('⑥ 代理不通时报错清晰', /ECONNREFUSED|超时|timeout|socket/i.test(String(err.code || err.message)), String(err.code || err.message));
  }

  // 场景 5：SOCKS5（无认证）——验证手写握手 + 域名远程解析 + TLS 包装
  const s5 = await startSocks5Proxy();
  const c5 = createHttp({ proxy: `socks5h://127.0.0.1:${s5.port}`, timeoutMs: 15000, retries: 0, tps: 0 });
  try {
    const res = await c5.request(TARGET, { headers: { 'User-Agent': 'pxrepo-proxy-check' }, retries: 0 });
    assert('⑦ 经 SOCKS5（无认证）取到响应', res.status >= 200 && res.status < 300, `status=${res.status}`);
    assert('⑧ SOCKS5 通道响应体可读', Buffer.isBuffer(res.body) && res.body.length > 0, `bytes=${res.body ? res.body.length : 0}`);
  } catch (err) {
    assert('⑦ 经 SOCKS5（无认证）取到响应', false, String(err.message).slice(0, 80));
    assert('⑧ SOCKS5 通道响应体可读', false, '未执行');
  } finally {
    s5.server.close();
  }

  // 场景 6：SOCKS5 用户名密码认证
  const s5auth = await startSocks5Proxy({ requireAuth: true });
  const c6 = createHttp({ proxy: `socks5h://user:pw@127.0.0.1:${s5auth.port}`, timeoutMs: 15000, retries: 0, tps: 0 });
  try {
    const res = await c6.request(TARGET, { headers: { 'User-Agent': 'pxrepo-proxy-check' }, retries: 0 });
    assert('⑨ SOCKS5 用户名密码认证通过', res.status >= 200 && res.status < 300, `status=${res.status}`);
  } catch (err) {
    assert('⑨ SOCKS5 用户名密码认证通过', false, String(err.message).slice(0, 80));
  }

  // 场景 7：SOCKS5 凭据错误 → 认证失败应明确报错
  const c7 = createHttp({ proxy: `socks5h://bad:bad@127.0.0.1:${s5auth.port}`, timeoutMs: 8000, retries: 0, tps: 0 });
  try {
    await c7.request(TARGET, { retries: 0 });
    assert('⑩ SOCKS5 认证失败报错清晰', false, '未抛错');
  } catch (err) {
    assert('⑩ SOCKS5 认证失败报错清晰', /SOCKS5 认证失败|SOCKS5/.test(String(err.message)), String(err.message).slice(0, 60));
  } finally {
    s5auth.server.close();
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[proxy-check] 异常:', err && err.stack || err);
  process.exit(1);
});
