'use strict';
/**
 * src/cli/context.js —— CLI 运行时上下文（零依赖）
 *
 * 把「配置 → HTTP → Pixiv 客户端 → 状态存储 → 进度条工厂」这套装配集中一处，
 * 让各命令函数只关心业务动作，不重复装配（旧实现里这套装配散落在 bin/pxrepo 的全局变量里）。
 */

const fs = require('node:fs');
const path = require('node:path');
const configModule = require('../config.js');
const { createHttp } = require('../net/http.js');
const { PixivClient } = require('../pixiv/client.js');
const { createProgressTracker, isTty } = require('../util/progress.js');
const { stateFile, ensureStateDir, ensureDir, readJson, writeJsonAtomic } = require('../store/json.js');
const { createBlacklistStore, createTaskListStore, createHistoryStore } = require('../store/stores.js');

/**
 * 把键值写进 .env（保留原有注释与顺序；键已存在则替换该行，否则追加）
 * 用途：登录成功后保存 refresh_token（只写这一个凭据，绝不写账号密码）
 */
function writeEnvValue(envFile, key, value) {
  const line = `${key}=${value}`;
  let text = '';
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    text = '';
  }
  const lines = text.split(/\r?\n/);
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(lines[i])) {
      lines[i] = line;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length && lines[lines.length - 1] !== '') lines.push('');
    lines.push(line);
  }
  fs.writeFileSync(envFile, `${lines.join('\n').replace(/\n*$/, '')}\n`, 'utf8');
  return envFile;
}

/** 从 .env 删除某键（登出用；只删键行，保留其它配置） */
function removeEnvValue(envFile, key) {
  let text = '';
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    return envFile;
  }
  const kept = text.split(/\r?\n/).filter((l) => !new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
  fs.writeFileSync(envFile, `${kept.join('\n').replace(/\n*$/, '')}\n`, 'utf8');
  return envFile;
}

/** 旧版黑名单位置（迁移用；只读不删） */
const LEGACY_BLACKLIST = path.join(configModule.ROOT, 'config', 'blacklist.json');
/** 默认黑名单项：跳过 pixiv 事务局（官方账号 id=11），与旧版行为一致 */
const DEFAULT_BLACKLIST_ENTRY = Object.freeze({ id: 11, remarks: 'pixiv 事务局（官方账号）' });

/**
 * 一次性迁移旧黑名单：目标文件不存在、且旧文件存在时，把旧条目复制过去
 * 原则：不覆盖已存在的新文件、不删除旧文件（可恢复）
 * @returns {number} 迁移条数（0 = 没迁移）
 */
function migrateLegacyBlacklist(targetFile) {
  if (fs.existsSync(targetFile)) return 0;
  if (!fs.existsSync(LEGACY_BLACKLIST)) return 0;
  const legacy = readJson(LEGACY_BLACKLIST, []);
  if (!Array.isArray(legacy) || !legacy.length) return 0;
  writeJsonAtomic(targetFile, legacy);
  return legacy.length;
}

/** 黑名单不存在时播种默认项（跳过官方账号） */
function seedDefaultBlacklist(targetFile) {
  if (fs.existsSync(targetFile)) return false;
  writeJsonAtomic(targetFile, [DEFAULT_BLACKLIST_ENTRY]);
  return true;
}

/**
 * 组装上下文
 * @param {object} flags parseArgs 的结果
 */
function createContext(flags) {
  const cfg = configModule.applyOverrides(configModule.load(), flags);
  const http = createHttp(cfg);
  const pixiv = new PixivClient({ http, refreshToken: cfg.refreshToken });
  ensureStateDir(cfg);

  // 黑名单：路径可配（PXREPO_BLACKLIST），首次使用会从旧版位置迁移 / 播种默认项
  ensureDir(path.dirname(cfg.blacklistFile));
  const migrated = migrateLegacyBlacklist(cfg.blacklistFile);
  if (migrated) console.log(`[黑名单] 已从旧文件迁移 ${migrated} 条：${LEGACY_BLACKLIST} → ${cfg.blacklistFile}`);
  if (seedDefaultBlacklist(cfg.blacklistFile)) console.log('[黑名单] 已初始化默认项：跳过 pixiv 事务局（id=11）');

  const stores = {
    blacklist: createBlacklistStore(cfg.blacklistFile),
    tasks: createTaskListStore(stateFile(cfg, 'download.json')),
    history: createHistoryStore(stateFile(cfg, 'history.json')),
  };
  return {
    flags,
    cfg,
    http,
    pixiv,
    stores,
    /** 造进度条（自动判断 TTY 与样式） */
    makeTracker: (totalFiles) => createProgressTracker(totalFiles, isTty(), cfg.progress),
    /** 是否干跑 */
    dryrun: Boolean(flags.dryrun),
  };
}

/** 登录态断言（需要账号的命令先调它，报错信息给出下一步动作） */
function requireLogin(ctx) {
  if (!ctx.cfg.refreshToken) {
    const err = new Error('未登录：请先执行 `node cli.js --login`（或把 refresh token 写入 .env 的 PXREPO_REFRESH_TOKEN）');
    err.code = 'NOT_LOGGED_IN';
    throw err;
  }
  return true;
}

/** 下载根目录断言 */
function requireDataRoot(ctx) {
  if (!ctx.cfg.dataRoot) {
    const err = new Error('缺少下载目录：请用参数传入 path，或在 .env 配置 PXREPO_DATA_ROOT');
    err.code = 'NO_DATA_ROOT';
    throw err;
  }
  return ctx.cfg.dataRoot;
}

/** 保存登录凭据到 .env */
function persistRefreshToken(ctx, token) {
  writeEnvValue(ctx.cfg._envFile, 'PXREPO_REFRESH_TOKEN', token);
  ctx.cfg.refreshToken = token;
  return token;
}

/** 清除登录凭据 */
function clearRefreshToken(ctx) {
  removeEnvValue(ctx.cfg._envFile, 'PXREPO_REFRESH_TOKEN');
  ctx.cfg.refreshToken = '';
  return true;
}

module.exports = {
  createContext,
  migrateLegacyBlacklist,
  seedDefaultBlacklist,
  LEGACY_BLACKLIST,
  DEFAULT_BLACKLIST_ENTRY,
  requireLogin,
  requireDataRoot,
  persistRefreshToken,
  clearRefreshToken,
  writeEnvValue,
  removeEnvValue,
};
