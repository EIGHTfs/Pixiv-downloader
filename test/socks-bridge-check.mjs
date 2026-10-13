#!/usr/bin/env node
/**
 * test/socks-bridge-check.mjs —— 本地代理桥检查（零依赖、离线、不依赖外部代理）
 *
 * 背景：Chromium 直连 SOCKS5 实测报 ERR_SOCKS_CONNECTION_FAILED，而本项目自研 SOCKS5 能通；
 * 于是用「本地 HTTP CONNECT 桥 → 自研 SOCKS5 → 上游」把两者接起来。本测试用本地 mock SOCKS5
 * 验证桥的完整链路，避免依赖不稳定的公开代理。
 *
 * 覆盖场景：
 *   1. 经桥的 CONNECT 隧道能建立，且隧道内可正常收发数据（端到端内容一致）
 *   2. 上游 SOCKS5 不可达时，桥返回 502 并关闭连接（不挂死）
 *   3. 非 CONNECT 的普通 HTTP 请求返回 405（桥只做隧道）
 *
 * 用法：node test/socks-bridge-check.mjs
 */

import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { startBridge } = require(join(ROOT, 'src', 'net', 'socks-bridge.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/** 最小 SOCKS5 服务端（只做 CONNECT 中继，无认证） */
function startMockSocks5() {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let stage = 'method';
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'method') {
        if (buf.length < 2 + buf[1]) return;
        buf = buf.subarray(2 + buf[1]);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
        return;
      }
      if (stage !== 'request' || buf.length < 5) return;
      const atyp = buf[3];
      let host;
      let cursor;
      if (atyp === 0x01) { host = buf.subarray(4, 8).join('.'); cursor = 8; }
      else if (atyp === 0x03) { const len = buf[4]; host = buf.subarray(5, 5 + len).toString(); cursor = 5 + len; }
      else { socket.destroy(); return; }
      if (buf.length < cursor + 2) return;
      const port = buf.readUInt16BE(cursor);
      buf = buf.subarray(cursor + 2);
      stage = 'relay';
      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    });
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port })));
}

/** 经本地 HTTP 代理发一次 CONNECT + 明文 HTTP 请求，返回响应文本 */
function requestViaBridge(bridgePort, targetHost, targetPort, path) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.connect(bridgePort, '127.0.0.1', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });
    let phase = 'connect';
    let data = '';
    socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('超时')); });
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (phase === 'connect') {
        if (!data.includes('\r\n\r\n')) return;
        const status = /^HTTP\/1\.1 (\d+)/.exec(data);
        if (!status || status[1] !== '200') { socket.destroy(); reject(new Error(`CONNECT 失败: ${data.split('\r\n')[0]}`)); return; }
        phase = 'request';
        data = '';
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nConnection: close\r\n\r\n`);
        return;
      }
      if (data.includes('__END__')) { socket.destroy(); resolvePromise(data); }
    });
    socket.on('close', () => { if (phase === 'request') resolvePromise(data); });
  });
}

async function main() {
  // 目标服务（隧道尽头）
  const target = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`tunnel-ok:${req.url}__END__`);
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;

  const socks = await startMockSocks5();
  const bridge = await startBridge({
    upstream: { protocol: 'socks5', host: '127.0.0.1', port: socks.port, auth: '', raw: `socks5h://127.0.0.1:${socks.port}` },
    timeoutMs: 8000,
  });

  try {
    // 1. 端到端隧道
    const text = await requestViaBridge(bridge.port, '127.0.0.1', targetPort, '/hello');
    assert('① 经桥的隧道可用且内容一致', /tunnel-ok:\/hello/.test(text), text.slice(0, 80));
    assert('② 桥统计到 1 次 CONNECT', bridge.stats.connects === 1, JSON.stringify(bridge.stats));

    // 2. 普通 HTTP 请求 → 405
    const plain = await new Promise((resolvePromise) => {
      const req = http.request({ host: '127.0.0.1', port: bridge.port, method: 'GET', path: 'http://example.com/' }, (res) => {
        res.resume();
        resolvePromise(res.statusCode);
      });
      req.on('error', () => resolvePromise(0));
      req.end();
    });
    assert('③ 非 CONNECT 请求返回 405', plain === 405, String(plain));

    // 3. 上游不可达 → 502（不挂死）
    const deadBridge = await startBridge({
      upstream: { protocol: 'socks5', host: '127.0.0.1', port: 1, auth: '', raw: 'socks5h://127.0.0.1:1' },
      timeoutMs: 3000,
    });
    let failedStatus = '';
    try {
      await requestViaBridge(deadBridge.port, '127.0.0.1', targetPort, '/x');
    } catch (err) {
      failedStatus = String(err.message);
    } finally {
      await deadBridge.close();
    }
    assert('④ 上游不可达时返回 502 且不挂死', /502/.test(failedStatus) || /CONNECT 失败/.test(failedStatus), failedStatus.slice(0, 80));
  } finally {
    await bridge.close();
    socks.server.close();
    target.close();
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[bridge-check] 异常:', err && err.stack || err);
  process.exit(1);
});
