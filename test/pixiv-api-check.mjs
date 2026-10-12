#!/usr/bin/env node
/**
 * test/pixiv-api-check.mjs —— Pixiv API 客户端检查
 *
 * 覆盖场景：
 *   离线（无需网络）：
 *     1. X-Client-Time 格式（本地时间带时区偏移，与官方客户端一致）
 *     2. X-Client-Hash = md5(time + HASH_SECRET)（与独立计算比对）
 *     3. PKCE：verifier/challenge 长度与 sha256 关系正确、登录链接参数齐全
 *     4. 查询串组装：跳过空值、正确编码
 *     5. 默认请求头齐全（App-OS / User-Agent / X-Client-*）
 *   在线（需要代理，不需要登录）：
 *     6. 未带 token 请求 /v1/user/me/state 应得 401，并抛出带 Pixiv 错误信息的 PixivError
 *        —— 这一条同时证明「请求头链路 + 错误提取 + 代理」是通的
 *
 * 用法：
 *   node test/pixiv-api-check.mjs                      # 只跑离线断言
 *   PXREPO_PROXY=socks5h://ip:port node test/pixiv-api-check.mjs   # 附带在线断言
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const config = require(join(ROOT, 'lib', 'config.js'));
const pixiv = require(join(ROOT, 'lib', 'pixiv.js'));
const { createHttp } = require(join(ROOT, 'lib', 'http.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

async function main() {
  // ── 1. X-Client-Time 格式 ──────────────────────────────────────────
  const time = pixiv.isoLocalWithOffset(new Date('2026-10-13T07:30:00+08:00'));
  assert('① X-Client-Time 为「本地时间+偏移」格式', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(time), time);

  // ── 2. X-Client-Hash ──────────────────────────────────────────────
  const hash = pixiv.clientHash(time);
  const expectHash = createHash('md5').update(`${time}28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c`).digest('hex');
  assert('② X-Client-Hash = md5(时间+密钥)', hash === expectHash && hash.length === 32, hash.slice(0, 12));

  // ── 3. PKCE ───────────────────────────────────────────────────────
  const pkce = pixiv.createPkce();
  const expectChallenge = createHash('sha256').update(pkce.codeVerifier).digest('base64url');
  assert('③ code_verifier 为 43 字符 base64url', /^[A-Za-z0-9_-]{43}$/.test(pkce.codeVerifier), String(pkce.codeVerifier).length + ' 字符');
  assert('④ code_challenge = base64url(sha256(verifier))', pkce.codeChallenge === expectChallenge, pkce.codeChallenge.slice(0, 12));
  assert('⑤ 登录链接参数齐全', /code_challenge=.+&code_challenge_method=S256&client=pixiv-android/.test(pkce.loginUrl), pkce.loginUrl.slice(0, 70));
  assert('⑥ 两次 PKCE 不重复', pixiv.createPkce().codeVerifier !== pkce.codeVerifier, '随机数重复');

  // ── 4. 查询串组装 ─────────────────────────────────────────────────
  const q = pixiv.qs({ user_id: 123, restrict: 'public', offset: undefined, empty: '', type: 'illust' });
  assert('⑦ 查询串跳过空值并正确拼接', q === 'user_id=123&restrict=public&type=illust', q);

  // ── 5. 默认请求头 ─────────────────────────────────────────────────
  const h = pixiv.defaultHeaders();
  const okHeaders = ['X-Client-Time', 'X-Client-Hash', 'App-OS', 'App-OS-Version', 'App-Version', 'User-Agent', 'Accept-Language']
    .every((k) => Boolean(h[k]));
  assert('⑧ 默认请求头齐全（含伪装字段）', okHeaders, JSON.stringify(Object.keys(h)));
  assert('⑨ 请求头里的时间可被解析', !Number.isNaN(Date.parse(h['X-Client-Time'])), h['X-Client-Time']);

  // ── 6. 在线：未鉴权请求应得 401（证明到达 Pixiv API） ───────────────
  const cfg = config.load();
  const proxy = cfg.proxy || process.env.PXREPO_PROXY || '';
  if (!proxy) {
    console.log('SKIP  ⑩ 未鉴权请求返回 401（未配置代理，跳过在线断言）');
  } else {
    const http = createHttp({ ...cfg, proxy, tps: 0, timeoutMs: 30000, retries: 1 });
    const client = new pixiv.PixivClient({ http });
    try {
      await client.userMe();
      assert('⑩ 未鉴权请求被 Pixiv 拒绝', false, '竟然成功了（不该发生）');
    } catch (err) {
      // 实测：Pixiv 对「缺 Authorization」的业务请求返回 400 + "Error occurred at the OAuth process…"
      // （而不是 401），所以这里两种都接受——关键是「错误来自 Pixiv 且被正确解析」。
      const okStatus = err instanceof pixiv.PixivError && (err.status === 400 || err.status === 401);
      assert('⑩ 未鉴权请求被 Pixiv 拒绝且错误信息来自 Pixiv',
        okStatus && Boolean(err.message),
        `${err.name}/${err.status || '-'}: ${String(err.message).slice(0, 60)}`);
    }
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[pixiv-check] 异常:', err && err.stack || err);
  process.exit(1);
});
