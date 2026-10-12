#!/usr/bin/env node
'use strict';
/**
 * cli.js —— Pixiv 下载器入口（零依赖）
 *
 * 用法（旧版参数全部保留，另加 Pawchive 风格新参数）：
 *   node cli.js --login [token]          登录（不带 token 走 PKCE 授权；带 token 直接换 access_token）
 *   node cli.js --logout                 登出（清除 .env 里的 refresh token）
 *   node cli.js -G [isPublic]            拉取关注列表写入清单（false=私密；加 --download 立即下载）
 *   node cli.js -B [isPublic]            下载自己的收藏
 *   node cli.js -u <uid(s)>              按画师 UID 下载（逗号分隔）
 *   node cli.js -p <pid(s)>              按作品 PID 下载（逗号分隔）
 *   node cli.js -U [json]                按清单更新下载（downJson/historyJson/任意 .json 路径）
 *   node cli.js -l <uid(s)>              黑名单增删（存在则移出，不存在则加入）
 *   node cli.js -d [json,size]           拆分清单为多份（原文件不动）
 *   node cli.js -D                       清理未完成下载（.tmp 移入回收站，可恢复）
 *   node cli.js --setting                查看当前生效配置
 *   node cli.js <命令> [path] [选项]      path = 下载根目录（覆盖 PXREPO_DATA_ROOT）
 *
 * 通用选项：
 *   --dryrun                只生成计划，不发请求不落盘
 *   --concurrency N         并发下载数
 *   --tps N                 每秒请求上限（0=不限速）
 *   --progress <style>      single | multi | ipull
 *   --limit N               只处理最新 N 个作品（小样本验证）
 *   --verbose               出错时打印堆栈
 *   -h, --help / -v, --version
 */

const VERSION = '5.0.0'; // 零依赖项目无 package.json，版本号以本常量与 README 版本记录为准

const { createContext } = require('./src/cli/context.js');
const commands = require('./src/cli/commands.js');

/** 选项表：type = bool（开关）| required（必须带值）| optional（值可省略，见 shouldTakeOptionalValue） */
const OPTION_SPECS = [
  { name: 'login', long: '--login', type: 'optional', valueHint: '[token]', help: '登录 Pixiv（不带 token 走 PKCE 授权）' },
  { name: 'logout', long: '--logout', type: 'bool', help: '登出（清除 .env 中的 refresh token）' },
  { name: 'get', long: '--get', short: '-G', type: 'optional', valueHint: '[isPublic]', help: '拉取关注列表（false=私密）' },
  { name: 'bookmark', long: '--bookmark', short: '-B', type: 'optional', valueHint: '[isPublic]', help: '下载自己的收藏（false=私密）' },
  { name: 'uid', long: '--uid', short: '-u', type: 'required', valueHint: '<uid(s)>', help: '按画师 UID 下载（逗号分隔）' },
  { name: 'pid', long: '--pid', short: '-p', type: 'required', valueHint: '<pid(s)>', help: '按作品 PID 下载（逗号分隔）' },
  { name: 'update', long: '--update', short: '-U', type: 'optional', valueHint: '[json]', help: '按清单更新下载' },
  { name: 'blacklist', long: '--blacklist', short: '-l', type: 'required', valueHint: '<uid(s)>', help: '黑名单增删' },
  { name: 'divide', long: '--divide', short: '-d', type: 'optional', valueHint: '[json,size]', help: '拆分清单文件' },
  { name: 'delete', long: '--delete', short: '-D', type: 'bool', help: '清理未完成下载（.tmp 移入回收站）' },
  { name: 'setting', long: '--setting', type: 'bool', help: '查看当前配置' },
  { name: 'download', long: '--download', type: 'bool', help: '配合 -G：拉完关注立刻下载' },
  { name: 'dryrun', long: '--dryrun', type: 'bool', help: '只生成计划，不落盘' },
  { name: 'concurrency', long: '--concurrency', type: 'required', valueHint: '<N>', help: '并发下载数' },
  { name: 'tps', long: '--tps', type: 'required', valueHint: '<N>', help: '每秒请求上限（0=不限速）' },
  { name: 'progress', long: '--progress', type: 'required', valueHint: '<style>', help: '进度条样式 single|multi|ipull' },
  { name: 'limit', long: '--limit', type: 'required', valueHint: '<N>', help: '只处理最新 N 个作品' },
  { name: 'verbose', long: '--verbose', type: 'bool', help: '出错时打印堆栈' },
  { name: 'help', long: '--help', short: '-h', type: 'bool', help: '显示本帮助' },
  { name: 'version', long: '--version', short: '-v', type: 'bool', help: '显示版本号' },
];

/** 按 --long / -short 找选项定义 */
function findOption(token) {
  return OPTION_SPECS.find((spec) => spec.long === token || (spec.short && spec.short === token)) || null;
}

/**
 * optional 类型是否需要吃掉下一个 token
 * 规则（为了不误吃位置参数 path）：
 *   - -G/-B：仅 true/false
 *   - -U/-d：关键字 downJson/historyJson，或 .json 结尾的路径
 *   - --login：非 - 开头、且不是已存在的目录（token 通常是很长的随机串）
 */
function shouldTakeOptionalValue(name, next) {
  if (next === undefined || next.startsWith('-')) return false;
  if (name === 'get' || name === 'bookmark') return next === 'true' || next === 'false';
  if (name === 'update' || name === 'divide') return next === 'downJson' || next === 'historyJson' || /\.json$/i.test(next);
  if (name === 'login') {
    const fs = require('node:fs');
    try {
      if (fs.statSync(next).isDirectory()) return false; // 是目录 → 当作 path 位置参数
    } catch { /* 不存在 → 按 token 处理 */ }
    return true;
  }
  return false;
}

/** 解析命令行 → flags（含 _positional 位置参数） */
function parseArgs(argv) {
  const flags = { _positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      flags._positional.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith('-')) {
      flags._positional.push(token);
      continue;
    }
    const eqIndex = token.indexOf('=');
    const nameToken = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    const inlineValue = eqIndex >= 0 ? token.slice(eqIndex + 1) : null;
    const spec = findOption(nameToken);
    if (!spec) throw new Error(`未知参数：${token}（用 -h 查看用法）`);

    if (spec.type === 'bool') {
      flags[spec.name] = true;
      continue;
    }
    if (inlineValue !== null) {
      flags[spec.name] = inlineValue; // --uid=123 形式
      continue;
    }
    if (spec.type === 'required') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) throw new Error(`${nameToken} 需要一个值`);
      flags[spec.name] = next;
      i++;
      continue;
    }
    // optional：按规则决定是否吃下一个 token
    if (shouldTakeOptionalValue(spec.name, argv[i + 1])) {
      flags[spec.name] = argv[i + 1];
      i++;
    } else {
      flags[spec.name] = true;
    }
  }
  return flags;
}

/** 根据 flags 选出要执行的命令（无命令时返回 null → 打印帮助） */
function pickCommand(flags) {
  if (flags.login) return commands.cmdLogin;
  if (flags.logout) return commands.cmdLogout;
  if (flags.get) return commands.cmdGetFollows;
  if (flags.bookmark) return commands.cmdDownloadBookmark;
  if (flags.uid) return commands.cmdDownloadByUids;
  if (flags.pid) return commands.cmdDownloadByPids;
  if (flags.update) return commands.cmdUpdate;
  if (flags.blacklist) return commands.cmdBlacklist;
  if (flags.divide) return commands.cmdDivide;
  if (flags.delete) return commands.cmdCleanTmp;
  if (flags.setting) return commands.cmdSetting;
  return null;
}

/** 打印帮助 */
function printHelp() {
  const lines = [`Pixiv 下载器 v${VERSION}（零依赖 Node CLI）`, '', '用法：', '  node cli.js <命令> [path] [选项]', '', '命令：'];
  for (const spec of OPTION_SPECS) {
    const left = `${spec.short ? `${spec.short}, ` : '    '}${spec.long}${spec.valueHint ? ` ${spec.valueHint}` : ''}`;
    lines.push(`  ${left.padEnd(30)} ${spec.help}`);
  }
  lines.push('', '示例：');
  lines.push('  node cli.js --login                              # 首次登录（浏览器授权）');
  lines.push('  node cli.js -G false                             # 拉私密关注到清单');
  lines.push('  node cli.js -U --dryrun                          # 按清单干跑，看会下什么');
  lines.push('  node cli.js -u 12345 ~/Pixiv --concurrency 3     # 下载指定画师');
  lines.push('  node cli.js -p 87727821 --limit 1                # 只下 1 个作品');
  console.log(lines.join('\n'));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return 0;
  }
  if (flags.version) {
    console.log(VERSION);
    return 0;
  }
  if (flags._positional.length) flags.dataRoot = flags._positional[0]; // 位置参数 = 下载根目录

  const command = pickCommand(flags);
  if (!command) {
    printHelp();
    return 2;
  }

  const ctx = createContext(flags);
  try {
    return await command(ctx);
  } catch (err) {
    if (flags.verbose && err && err.stack) console.error(err.stack);
    else console.error(`✗ ${String(err && err.message || err)}`);
    return 1;
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code || 0; })
    .catch((err) => {
      console.error(`✗ 未捕获异常：${String(err && err.stack || err)}`);
      process.exitCode = 1;
    });
}

module.exports = { parseArgs, pickCommand, findOption, shouldTakeOptionalValue, printHelp, VERSION, OPTION_SPECS };
