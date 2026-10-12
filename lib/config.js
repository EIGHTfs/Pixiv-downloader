'use strict';
/**
 * lib/config.js —— 配置层（零依赖）
 *
 * 职责：
 *   1. 解析项目根目录的 `.env`（自写解析器，不引入 dotenv 等依赖）
 *   2. 与 `process.env` 合并，套用内置默认值
 *   3. 提供类型转换（int/bool）、`~` 展开、必填校验
 *
 * 优先级（高 → 低）：命令行参数 > process.env > .env 文件 > 内置默认值
 *   说明：`.env` 只是「没有真实环境变量时的兜底」；真实环境变量永远优先，
 *   这样 CI / 临时覆盖（PXREPO_DATA_ROOT=/tmp/x node cli.js ...）都能生效。
 *
 * 变量前缀固定 `PXREPO_`（与项目新名 Pixiv-downloader 无关，保持既有习惯不变）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 项目根目录（lib/ 的上一级）——所有相对路径都以它为基准，避免依赖 cwd */
const ROOT = path.resolve(__dirname, '..');
/** .env 固定位置：项目根（不随 cwd 漂移） */
const ENV_FILE = path.join(ROOT, '.env');

/**
 * 内置默认值（只放「有普适默认」的项）
 * 注意：dataRoot / refreshToken 没有默认值——它们是用户环境相关数据，必须显式配置，
 *       给它们编一个默认路径会导致「以为配好了，结果下载到意外目录」。
 */
const DEFAULTS = Object.freeze({
  dataRoot: '',            // PXREPO_DATA_ROOT    下载输出根目录（必填，无默认）
  refreshToken: '',        // PXREPO_REFRESH_TOKEN Pixiv refresh_token（登录后写入）
  concurrency: 5,          // PXREPO_CONCURRENCY  并发下载数
  tps: 1,                  // PXREPO_TPS          每秒请求上限（限速，反爬/防风控）
  proxy: '',               // PXREPO_PROXY        http(s) 代理；空=直连；'disable'=强制直连
  progress: 'multi',       // PXREPO_PROGRESS     进度条样式 single|multi|ipull
  httpdns: false,          // PXREPO_HTTPDNS      1=启用硬编码 IP 直连（失败自动回退系统 DNS）
  timeoutMs: 30000,        // PXREPO_TIMEOUT_MS   单请求超时（毫秒）
  retries: 3,              // PXREPO_RETRIES      失败重试次数（指数退避）
  stateDir: '',            // PXREPO_STATE_DIR    状态文件目录（黑名单/任务清单/历史）；空=数据根下 .pxrepo
});

/** 允许的进度条样式（与 lib/progress.js 保持一致） */
const PROGRESS_STYLES = Object.freeze(['single', 'multi', 'ipull']);

/**
 * 解析 .env 文本 → 键值对象
 *
 * 支持的写法（够用即可，不追求 dotenv 全兼容）：
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value'
 *   export KEY=value      （有些人习惯写 export）
 *   # 注释 / 空行          （忽略）
 *
 * 不做变量插值（${X}）、不做多行值——需要这些时用真实环境变量。
 *
 * @param {string} text .env 文件内容
 * @returns {Record<string,string>} 解析结果（值均为字符串，去引号后原样保留）
 */
function parseEnvFile(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;          // 空行 / 注释
    const eq = line.indexOf('=');
    if (eq <= 0) continue;                                 // 没有 = 或键名为空 → 跳过（不报错，容忍手写噪音）
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim(); // 兼容 `export KEY=`
    let value = line.slice(eq + 1).trim();
    // 去掉成对引号（只去一层，避免把值里的引号吃掉）
    if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** 读取 .env（不存在返回空对象；读取失败也返回空对象，不阻塞启动） */
function readEnvFile(file = ENV_FILE) {
  try {
    if (!fs.existsSync(file)) return {};
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {}; // .env 坏了不应该让整个程序起不来——真实环境变量仍可用
  }
}

/** 展开开头的 `~` / `~/xxx` 为用户主目录（.env 里写 ~/Pixiv 是常见写法） */
function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 转整数：非法值回退默认（并在 debug 时可见，避免静默吃错配置） */
function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 转布尔：1/true/yes/on 为真，0/false/no/off 为假，其余回退默认 */
function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

/**
 * 取一个配置项：process.env 优先，其次 .env 文件，最后默认值
 * @param {Record<string,string>} fileEnv 已解析的 .env
 * @param {string} key 变量名（如 PXREPO_DATA_ROOT）
 */
function pick(fileEnv, key) {
  const fromProcess = process.env[key];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const fromFile = fileEnv[key];
  if (fromFile !== undefined && fromFile !== '') return fromFile;
  return undefined;
}

/**
 * 载入配置
 * @param {{ envFile?: string, env?: Record<string,string> }} [opts]
 *   envFile 自定义 .env 路径（测试用）；env 直接注入的键值（测试用，等价于 .env 内容）
 * @returns {object} 配置对象（含 _sources 便于排查「这个值到底哪来的」）
 */
function load(opts = {}) {
  const fileEnv = opts.env !== undefined ? opts.env : readEnvFile(opts.envFile || ENV_FILE);
  const raw = (key) => pick(fileEnv, key);

  const config = {
    dataRoot: expandHome(raw('PXREPO_DATA_ROOT') || DEFAULTS.dataRoot),
    refreshToken: raw('PXREPO_REFRESH_TOKEN') || DEFAULTS.refreshToken,
    concurrency: toInt(raw('PXREPO_CONCURRENCY'), DEFAULTS.concurrency),
    tps: toInt(raw('PXREPO_TPS'), DEFAULTS.tps),
    proxy: raw('PXREPO_PROXY') !== undefined ? raw('PXREPO_PROXY') : DEFAULTS.proxy,
    progress: raw('PXREPO_PROGRESS') || DEFAULTS.progress,
    httpdns: toBool(raw('PXREPO_HTTPDNS'), DEFAULTS.httpdns),
    timeoutMs: toInt(raw('PXREPO_TIMEOUT_MS'), DEFAULTS.timeoutMs),
    retries: toInt(raw('PXREPO_RETRIES'), DEFAULTS.retries),
    stateDir: expandHome(raw('PXREPO_STATE_DIR') || ''),
    // 元信息（不参与业务判断，仅用于日志/排查）
    _root: ROOT,
    _envFile: opts.envFile || ENV_FILE,
    _envFileExists: opts.env !== undefined ? false : fs.existsSync(opts.envFile || ENV_FILE),
  };

  // 越界值收敛（配置写错时给出可用值，而不是让并发跑成 0 或负数）
  if (config.concurrency < 1) config.concurrency = 1;
  if (config.tps < 0) config.tps = 0;                       // 0 = 不限速
  if (config.timeoutMs < 1000) config.timeoutMs = 1000;
  if (config.retries < 0) config.retries = 0;
  if (!PROGRESS_STYLES.includes(config.progress)) config.progress = DEFAULTS.progress;
  // 状态目录缺省：数据根下的 .pxrepo（数据根也没有时退回项目根，保证 --login 等命令仍可用）
  if (!config.stateDir) config.stateDir = path.join(config.dataRoot || ROOT, '.pxrepo');

  return config;
}

/**
 * 应用命令行覆盖（cli.js 解析出的 flags → 配置）
 * 只覆盖用户显式给出的项（undefined 不动），保证「没传就按 .env」。
 */
function applyOverrides(config, flags = {}) {
  if (flags.dataRoot) config.dataRoot = expandHome(flags.dataRoot);
  if (flags.concurrency !== undefined) config.concurrency = Math.max(1, toInt(flags.concurrency, config.concurrency));
  if (flags.tps !== undefined) config.tps = Math.max(0, toInt(flags.tps, config.tps));
  if (flags.proxy !== undefined) config.proxy = String(flags.proxy);
  if (flags.progress) {
    const s = String(flags.progress);
    if (PROGRESS_STYLES.includes(s)) config.progress = s;
  }
  if (flags.httpdns !== undefined) config.httpdns = toBool(flags.httpdns, config.httpdns);
  if (flags.limit !== undefined) config.limit = toInt(flags.limit, 0); // 只处理最新 N 个作品（小样本验证）
  return config;
}

/**
 * 校验必填项：下载类命令需要 dataRoot；登录类命令不需要
 * @param {object} config
 * @param {{ needAuth?: boolean, needDataRoot?: boolean }} [need]
 */
function assertReady(config, need = {}) {
  const problems = [];
  if (need.needDataRoot !== false && !config.dataRoot) {
    problems.push('缺少 PXREPO_DATA_ROOT：请在 .env 里配置下载根目录，或用命令行传入 path');
  }
  if (need.needAuth && !config.refreshToken) {
    problems.push('未登录：请先执行 `node cli.js --login`（或把 refresh token 写入 .env 的 PXREPO_REFRESH_TOKEN）');
  }
  if (problems.length) {
    const err = new Error(problems.join('\n'));
    err.code = 'CONFIG_NOT_READY';
    err.problems = problems;
    throw err;
  }
  return true;
}

module.exports = {
  ROOT,
  ENV_FILE,
  DEFAULTS,
  PROGRESS_STYLES,
  parseEnvFile,
  readEnvFile,
  expandHome,
  load,
  applyOverrides,
  assertReady,
};
