'use strict';
/**
 * src/cli/commands.js —— 各命令的实现（零依赖）
 *
 * 命令与旧版参数一一对应（双兼容）：
 *   login / logout / getFollows(-G) / bookmark(-B) / byUids(-u) / byPids(-p)
 *   / update(-U) / blacklist(-l) / divide(-d) / cleanTmp(-D) / setting
 *
 * 设计约定：
 *   - 每个命令返回「退出码」（0 成功、非 0 失败），由 cli.js 决定 process.exitCode
 *   - 需要登录/需要数据根的命令先做断言，报错信息里给出下一步动作
 *   - 一切写盘走 src/store（原子写、绝不删除用户文件）；清理类操作把文件移入回收站而非删除
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createPkce } = require('../pixiv/client.js');
const {
  requireLogin,
  requireDataRoot,
  persistRefreshToken,
  clearRefreshToken,
} = require('./context.js');
const {
  fetchFollows,
  fetchBookmarks,
  fetchIllusts,
  downloadIllusts,
  downloadForCreators,
  PIXIV_REFERER,
} = require('./fetch.js');
const { downloadAll } = require('../download/engine.js');
const { webPagesToTasks } = require('../download/plan.js');
const { readJson, writeJsonAtomic, stateFile } = require('../store/json.js');
const { fmtBytes } = require('../util/progress.js');

/** 交互式单行输入（登录粘贴 code 用；stdin 非 TTY 时直接读一行） */
function promptLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/** 从「授权后回调地址」或裸 code 中提取 code（用户常整段粘贴 URL） */
function extractAuthCode(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  const matched = /[?&]code=([^&\s]+)/.exec(text);
  return decodeURIComponent(matched ? matched[1] : text);
}

/** 读取「画师清单」JSON（数组）；文件不存在返回空数组 */
function readCreatorList(file) {
  const data = readJson(file, []);
  if (!Array.isArray(data)) return [];
  return data.filter((item) => item && item.id !== undefined);
}

/** 逗号分隔的 UID/PID 列表 → 去空数组 */
function splitIds(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── 登录 / 登出 ────────────────────────────────────────────────────────

/** `--login [token]`：带 token 直接换 access_token；不带则走 PKCE 授权码流程 */
async function cmdLogin(ctx) {
  const tokenArg = typeof ctx.flags.login === 'string' ? ctx.flags.login.trim() : '';
  if (tokenArg) {
    await ctx.pixiv.refresh(tokenArg);
    persistRefreshToken(ctx, ctx.pixiv.refreshToken);
    console.log('✓ 已用 refresh token 登录，凭据已写入 .env（PXREPO_REFRESH_TOKEN）');
    return 0;
  }
  const pkce = createPkce();
  console.log('\n请用浏览器打开下面链接并完成授权：\n');
  console.log(pkce.loginUrl);
  console.log('\n授权后浏览器会跳转到一个打不开的地址，把地址栏里的 code 参数（或整段地址）粘贴到下面：');
  const input = await promptLine('code: ');
  const code = extractAuthCode(input);
  if (!code) {
    console.error('✗ 没有拿到 code，登录中止');
    return 1;
  }
  await ctx.pixiv.exchangeCode(code, pkce.codeVerifier);
  persistRefreshToken(ctx, ctx.pixiv.refreshToken);
  console.log('✓ 登录成功，refresh token 已写入 .env（本工具不保存账号密码）');
  return 0;
}

/** `--logout`：清除 .env 里的 refresh token */
async function cmdLogout(ctx) {
  clearRefreshToken(ctx);
  console.log('✓ 已登出（.env 中的 PXREPO_REFRESH_TOKEN 已清除）');
  return 0;
}

// ── 关注 / 收藏 ────────────────────────────────────────────────────────

/**
 * `-G, --get [isPublic]`：拉取关注列表写入清单文件（默认 `download.json`）
 * 与旧版一致：只收集清单，下载交给 `-U`（也支持 --download 立即下载）
 */
async function cmdGetFollows(ctx) {
  requireLogin(ctx);
  const restrict = ctx.flags.get === false || ctx.flags.get === 'false' ? 'private' : 'public';
  console.log(`拉取${restrict === 'private' ? '私密' : '公开'}关注列表…`);
  const users = await fetchFollows(ctx.pixiv, { restrict, limit: ctx.cfg.limit || 0 });
  const file = stateFile(ctx.cfg, 'download.json');
  writeJsonAtomic(file, users);
  console.log(`✓ 关注 ${users.length} 位，已写入 ${file}`);

  if (ctx.flags.download) {
    requireDataRoot(ctx);
    const summary = await downloadForCreators(ctx, users);
    console.log(`下载汇总：处理 ${summary.processed}｜跳过 ${summary.skipped}｜新文件 ${summary.downloads}｜失败 ${summary.failed}`);
    return summary.failed ? 1 : 0;
  }
  console.log('下一步：`node cli.js -U` 按该清单下载（或加 --download 直接下载）');
  return 0;
}

/** `-B, --bookmark [isPublic]`：下载自己的收藏 */
async function cmdDownloadBookmark(ctx) {
  requireLogin(ctx);
  const dataRoot = requireDataRoot(ctx);
  if (!ctx.pixiv.user || !ctx.pixiv.user.id) throw new Error('无法确定自己的 UID，请重新登录');
  const restrict = ctx.flags.bookmark === false || ctx.flags.bookmark === 'false' ? 'private' : 'public';
  const dir = path.join(dataRoot, '「Bookmark」');
  console.log(`拉取${restrict === 'private' ? '私密' : '公开'}收藏…`);
  const illusts = await fetchBookmarks(ctx.pixiv, ctx.pixiv.user.id, { restrict, limit: ctx.cfg.limit || 0 });
  console.log(`收藏 ${illusts.length} 个作品 → ${dir}`);
  const { result } = await downloadIllusts(ctx, illusts, dir);
  console.log(`汇总：新 ${result.downloaded} 跳过 ${result.existed} 失败 ${result.failed}｜${fmtBytes(result.bytes)}`);
  return result.failed ? 1 : 0;
}

// ── 按 UID / PID 下载 ──────────────────────────────────────────────────

/** `-u, --uid <uid(s)>`：按画师 UID 下载（逗号分隔） */
async function cmdDownloadByUids(ctx) {
  requireLogin(ctx);
  requireDataRoot(ctx);
  const uids = splitIds(ctx.flags.uid);
  if (!uids.length) throw new Error('--uid 需要至少一个画师 UID');
  const summary = await downloadForCreators(ctx, uids.map((id) => ({ id })));
  console.log(`汇总：处理 ${summary.processed}｜黑名单跳过 ${summary.skipped}｜新文件 ${summary.downloads}｜失败 ${summary.failed}`);
  return summary.failed ? 1 : 0;
}

/** `-p` 走 App API（需要 refresh_token）：拿作品 JSON 交给公共下载编排 */
async function downloadPidsViaAppApi(ctx, pids, dir) {
  const illusts = [];
  for (const pid of pids) {
    try {
      const detail = await ctx.pixiv.illustDetail(pid);
      if (detail && detail.illust) illusts.push(detail.illust);
      else console.log(`跳过 ${pid}：接口未返回作品`);
    } catch (err) {
      console.log(`跳过 ${pid}：${String(err && err.message || err).slice(0, 80)}`);
    }
  }
  if (!illusts.length) return null;
  const { result } = await downloadIllusts(ctx, illusts, dir);
  return result;
}

/** `-p` 走网页会话（Cookie）：支持未登录拿不到地址的 R-18 作品 */
async function downloadPidsViaWeb(ctx, pids, dir) {
  const tasks = [];
  for (const pid of pids) {
    try {
      const { meta, urls } = await ctx.web.illustOriginalUrls(pid);
      console.log(`[网页会话] ${meta.title || pid}｜${meta.userName || '?'}｜${urls.length} 页｜xRestrict=${meta.xRestrict}`);
      tasks.push(...webPagesToTasks(meta, urls, { dir, referer: PIXIV_REFERER }));
    } catch (err) {
      console.log(`跳过 ${pid}：${String(err && err.message || err).slice(0, 100)}`);
    }
  }
  if (!tasks.length) return null;
  const tracker = ctx.makeTracker(tasks.length);
  try {
    return await downloadAll(tasks, {
      http: ctx.http,
      concurrency: ctx.cfg.concurrency,
      dryrun: ctx.dryrun,
      tracker,
      lockDir: path.join(ctx.cfg.stateDir, 'locks'),
      timeoutMs: ctx.cfg.timeoutMs,
    });
  } finally {
    tracker.finishLine();
  }
}

/** `-p, --pid <pid(s)>`：按作品 PID 下载到「PID」目录（有 refresh_token 走 App API，否则走网页会话 Cookie） */
async function cmdDownloadByPids(ctx) {
  const dataRoot = requireDataRoot(ctx);
  const pids = splitIds(ctx.flags.pid);
  if (!pids.length) throw new Error('--pid 需要至少一个作品 PID');
  const dir = path.join(dataRoot, '「PID」');

  const hasToken = Boolean(ctx.cfg.refreshToken);
  const hasCookie = Boolean(ctx.web && ctx.web.loggedIn);
  if (!hasToken && !hasCookie) {
    throw new Error('未登录：请配置 PXREPO_REFRESH_TOKEN（App API）或 PXREPO_COOKIE / 会话文件（网页会话 Cookie）');
  }

  let result;
  if (hasToken) {
    requireLogin(ctx);
    result = await downloadPidsViaAppApi(ctx, pids, dir);
  } else {
    console.log('[会话] 使用网页会话 Cookie 下载（无需 App API token）');
    result = await downloadPidsViaWeb(ctx, pids, dir);
  }
  if (!result) {
    console.log('没有可下载的作品');
    return 1;
  }
  console.log(`汇总：新 ${result.downloaded} 跳过 ${result.existed} 失败 ${result.failed}｜${fmtBytes(result.bytes)}`);
  return result.failed ? 1 : 0;
}

// ── 按清单更新 ─────────────────────────────────────────────────────────

/**
 * `-U, --update [json]`：按清单更新下载
 * 清单来源：参数指定路径 / `downJson` / `historyJson` / 默认 stateDir 下的 download.json
 */
async function cmdUpdate(ctx) {
  requireLogin(ctx);
  requireDataRoot(ctx);
  const arg = ctx.flags.update;
  let file;
  if (typeof arg === 'string' && arg && arg !== 'downJson' && arg !== 'historyJson') {
    file = path.resolve(arg);
  } else if (arg === 'historyJson') {
    file = stateFile(ctx.cfg, 'history.json');
  } else {
    file = stateFile(ctx.cfg, 'download.json');
  }
  if (!fs.existsSync(file)) {
    throw new Error(`清单文件不存在：${file}（先用 -G 生成，或把 json 路径传给 -U）`);
  }
  const creators = readCreatorList(file);
  console.log(`清单 ${file}：${creators.length} 位画师`);
  if (!creators.length) return 0;

  const summary = await downloadForCreators(ctx, creators);
  console.log(`汇总：处理 ${summary.processed}｜黑名单跳过 ${summary.skipped}｜新文件 ${summary.downloads}｜失败 ${summary.failed}`);
  return summary.failed ? 1 : 0;
}

// ── 黑名单 ─────────────────────────────────────────────────────────────

/** `-l, --blacklist <uid(s)>`：切换黑名单（在则移出、不在则加入） */
async function cmdBlacklist(ctx) {
  const uids = splitIds(ctx.flags.blacklist);
  if (!uids.length) throw new Error('--blacklist 需要至少一个画师 UID');
  for (const uid of uids) {
    const action = ctx.stores.blacklist.toggle(uid, 'cli');
    console.log(`${action === 'added' ? '加入' : '移出'}黑名单：${uid}`);
  }
  const all = ctx.stores.blacklist.all();
  console.log(`当前黑名单 ${all.length} 项：${all.map((x) => x.id).join(', ') || '（空）'}`);
  return 0;
}

// ── 拆分清单 ───────────────────────────────────────────────────────────

/** `-d, --divide [json,size]`：把清单按 size 条拆成多个文件（原文件保持不变） */
async function cmdDivide(ctx) {
  const raw = typeof ctx.flags.divide === 'string' ? ctx.flags.divide : '';
  const [fileArg, sizeArg] = raw.split(',');
  const file = !fileArg || fileArg === 'downJson'
    ? stateFile(ctx.cfg, 'download.json')
    : path.resolve(fileArg);
  const size = Number.parseInt(sizeArg, 10) || 50;
  const list = readJson(file, []);
  if (!Array.isArray(list) || !list.length) throw new Error(`清单为空或不存在：${file}`);

  let written = 0;
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const out = `${file}.${Math.floor(i / size) + 1}.json`;
    if (ctx.dryrun) {
      console.log(`[dryrun] 将写 ${out}（${chunk.length} 条）`);
    } else {
      writeJsonAtomic(out, chunk);
    }
    written++;
  }
  console.log(`${ctx.dryrun ? '[dryrun] 计划拆分' : '已拆分'} ${written} 个文件（每份 ${size} 条）；原文件未改动：${file}`);
  return 0;
}

// ── 清理未完成下载 ─────────────────────────────────────────────────────

/** 递归找出所有 `.tmp`（断点文件） */
function findTmpFiles(root, out = [], depth = 0) {
  if (depth > 6) return out; // 防御：目录层级异常时不无限递归
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) findTmpFiles(full, out, depth + 1);
    else if (entry.name.endsWith('.tmp') || entry.name.endsWith('.tmp.bad')) out.push(full);
  }
  return out;
}

/**
 * `-D, --delete`：清理未完成下载的 `.tmp`
 * 安全策略：不直接删除，移到 `<stateDir>/trash/<时间戳>-<原名>`（可恢复），并先报数量
 */
async function cmdCleanTmp(ctx) {
  const dataRoot = requireDataRoot(ctx);
  const files = findTmpFiles(dataRoot);
  console.log(`扫描 ${dataRoot}：发现 ${files.length} 个断点文件（.tmp/.tmp.bad）`);
  if (!files.length) return 0;
  if (ctx.dryrun) {
    for (const file of files.slice(0, 20)) console.log(`[dryrun] 将移入回收站：${file}`);
    if (files.length > 20) console.log(`[dryrun] …其余 ${files.length - 20} 个`);
    return 0;
  }
  const trashDir = path.join(ctx.cfg.stateDir, 'trash', String(Date.now()));
  fs.mkdirSync(trashDir, { recursive: true });
  let moved = 0;
  for (const file of files) {
    try {
      fs.renameSync(file, path.join(trashDir, path.basename(file)));
      moved++;
    } catch (err) {
      console.error(`移动失败 ${file}：${String(err && err.message || err).slice(0, 80)}`);
    }
  }
  console.log(`✓ 已移入回收站 ${moved} 个：${trashDir}`);
  return 0;
}

// ── 查看设置 ───────────────────────────────────────────────────────────

/** `--setting`：打印当前生效配置（凭据脱敏；不做交互式编辑） */
async function cmdSetting(ctx) {
  const mask = (value) => (value ? `${String(value).slice(0, 6)}…（已配置，${String(value).length} 字符）` : '（未配置）');
  const rows = [
    ['配置文件', ctx.cfg._envFile + (ctx.cfg._envFileExists ? '（已存在）' : '（不存在）')],
    ['下载根目录', ctx.cfg.dataRoot || '（未配置）'],
    ['状态目录', ctx.cfg.stateDir],
    ['并发数', ctx.cfg.concurrency],
    ['TPS 限速', ctx.cfg.tps === 0 ? '不限速' : ctx.cfg.tps],
    ['代理', ctx.http.proxyInfo ? ctx.http.proxyInfo.raw : '（直连）'],
    ['HTTPDNS 直连', ctx.cfg.httpdns ? '开启' : '关闭'],
    ['进度条样式', ctx.cfg.progress],
    ['登录凭据', mask(ctx.cfg.refreshToken)],
    ['黑名单', `${ctx.stores.blacklist.all().length} 项`],
    ['清单文件', stateFile(ctx.cfg, 'download.json')],
  ];
  console.log('当前配置：');
  for (const [key, value] of rows) console.log(`  ${key.padEnd(12, '　')} ${value}`);
  console.log('\n修改方式：直接编辑 .env（模板见 env.example）');
  return 0;
}

module.exports = {
  cmdLogin,
  cmdLogout,
  cmdGetFollows,
  cmdDownloadBookmark,
  cmdDownloadByUids,
  cmdDownloadByPids,
  cmdUpdate,
  cmdBlacklist,
  cmdDivide,
  cmdCleanTmp,
  cmdSetting,
  extractAuthCode,
  splitIds,
  readCreatorList,
  findTmpFiles,
};
