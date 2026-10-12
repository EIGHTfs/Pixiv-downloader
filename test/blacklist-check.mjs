#!/usr/bin/env node
/**
 * test/blacklist-check.mjs —— 黑名单行为检查（零依赖、离线）
 *
 * 黑名单语义：命中即**跳过该作者的下载**（只影响本工具，不是去 Pixiv 拉黑）。
 * 覆盖场景：
 *   1. 旧文件迁移：目标不存在 + 旧 `config/blacklist.json` 存在 → 条目复制过去，旧文件保留
 *   2. 不覆盖：目标已存在时迁移不动作（0 条）
 *   3. 默认项播种：都不存在 → 写入默认项（跳过 pixiv 事务局 id=11），再次调用不重复播种
 *   4. 下载跳过：黑名单作者**完全不发请求**，其余作者照常处理
 *   5. 自动拉黑：接口明确拒绝（PixivError）的作者被自动加入黑名单，且可用 -l 移出
 *
 * 用法：node test/blacklist-check.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const context = require(join(ROOT, 'src', 'cli', 'context.js'));
const { downloadForCreators } = require(join(ROOT, 'src', 'cli', 'fetch.js'));
const { createBlacklistStore, createHistoryStore } = require(join(ROOT, 'src', 'store', 'stores.js'));
const { createProgressTracker } = require(join(ROOT, 'src', 'util', 'progress.js'));
const { PixivError } = require(join(ROOT, 'src', 'pixiv', 'client.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/** 造一个只记录调用的假 pixiv 客户端 */
function makeFakePixiv({ failUids = [] } = {}) {
  const calls = [];
  return {
    calls,
    async userDetail(uid) {
      calls.push(`userDetail:${uid}`);
      if (failUids.includes(String(uid))) throw new PixivError('该用户不存在或已注销', { status: 404 });
      return { user: { id: uid, name: `画师${uid}` } };
    },
    async userIllusts(uid) {
      calls.push(`userIllusts:${uid}`);
      return { illusts: [], next_url: null };
    },
    async requestNext() { return { illusts: [], next_url: null }; },
  };
}

/** 造一个最小上下文（不联网） */
function makeCtx(dir, pixiv) {
  const blacklist = createBlacklistStore(join(dir, 'blacklist.json'));
  const history = createHistoryStore(join(dir, 'history.json'));
  return {
    cfg: { dataRoot: join(dir, 'data'), limit: 0, concurrency: 1, stateDir: dir, timeoutMs: 5000 },
    stores: { blacklist, history },
    pixiv,
    makeTracker: (n) => createProgressTracker(n, false),
    http: {},
    dryrun: false,
    flags: {},
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pxrepo-blacklist-'));
  try {
    // ── 1. 旧文件迁移 ────────────────────────────────────────────────
    const legacyPath = context.LEGACY_BLACKLIST;
    const legacyExists = existsSync(legacyPath);
    const target1 = join(dir, 'migrated.json');
    const migrated = context.migrateLegacyBlacklist(target1);
    if (legacyExists) {
      const legacyRaw = readFileSync(legacyPath, 'utf8').trim();
      const targetRaw = existsSync(target1) ? readFileSync(target1, 'utf8').trim() : '';
      assert('① 旧黑名单迁移到新位置且内容一致', migrated > 0 && JSON.parse(targetRaw).length === JSON.parse(legacyRaw).length,
        `migrated=${migrated} target=${targetRaw.slice(0, 40)}`);
      assert('② 迁移不删除旧文件', existsSync(legacyPath), '旧文件消失');
    } else {
      assert('① 旧黑名单迁移到新位置且内容一致', migrated === 0, '旧文件不存在时应为 0');
      assert('② 迁移不删除旧文件', true, '');
    }

    // ── 2. 不覆盖已存在目标 ──────────────────────────────────────────
    const target2 = join(dir, 'existing.json');
    writeFileSync(target2, JSON.stringify([{ id: 999 }]), 'utf8');
    const migrated2 = context.migrateLegacyBlacklist(target2);
    assert('③ 目标已存在时不迁移（不覆盖用户数据）',
      migrated2 === 0 && JSON.parse(readFileSync(target2, 'utf8'))[0].id === 999, `migrated=${migrated2}`);

    // ── 3. 默认项播种 ───────────────────────────────────────────────
    const target3 = join(dir, 'seed.json');
    const seeded = context.seedDefaultBlacklist(target3);
    const seededAgain = context.seedDefaultBlacklist(target3);
    const seedContent = JSON.parse(readFileSync(target3, 'utf8'));
    assert('④ 首次播种默认项（跳过 id=11）且不重复播种',
      seeded === true && seededAgain === false && seedContent.length === 1 && seedContent[0].id === 11,
      JSON.stringify(seedContent));

    // ── 4. 下载时跳过黑名单作者（且不发任何请求） ─────────────────────
    const pixiv = makeFakePixiv();
    const ctx = makeCtx(dir, pixiv);
    mkdirSync(ctx.cfg.dataRoot, { recursive: true });
    ctx.stores.blacklist.add(111, '测试');
    const summary = await downloadForCreators(ctx, [{ id: 111 }, { id: 222 }]);
    const touched111 = pixiv.calls.some((c) => c.endsWith(':111'));
    assert('⑤ 黑名单作者被跳过且完全不发请求', touched111 === false && summary.skipped === 1,
      `calls=${JSON.stringify(pixiv.calls)} skipped=${summary.skipped}`);
    assert('⑥ 非黑名单作者照常处理', pixiv.calls.some((c) => c.endsWith(':222')) && summary.processed === 1,
      `calls=${JSON.stringify(pixiv.calls)} processed=${summary.processed}`);

    // ── 5. 接口拒绝 → 自动拉黑 ──────────────────────────────────────
    const pixiv2 = makeFakePixiv({ failUids: ['333'] });
    const ctx2 = makeCtx(dir, pixiv2);
    await downloadForCreators(ctx2, [{ id: 333 }]);
    const autoAdded = ctx2.stores.blacklist.has(333);
    assert('⑦ 接口拒绝的作者被自动加入黑名单', autoAdded === true, JSON.stringify(ctx2.stores.blacklist.all()));
    assert('⑧ 自动拉黑可用 -l 移出（toggle 语义）',
      ctx2.stores.blacklist.toggle(333) === 'removed' && ctx2.stores.blacklist.has(333) === false,
      JSON.stringify(ctx2.stores.blacklist.all()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('[blacklist-check] 异常:', err && err.stack || err);
  process.exit(1);
});
