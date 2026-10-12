#!/usr/bin/env node
/**
 * test/cli-e2e-check.mjs —— CLI 端到端小样本实测（免登录命令，零依赖）
 *
 * 为什么这些命令能免登录测：`-D 清理`、`-d 拆分清单`、`--setting`、`-h` 不碰 Pixiv API，
 * 却能覆盖「参数解析 → 上下文装配 → 命令执行 → 落盘/回收站」整条链路。
 *
 * 覆盖场景（全部在临时目录里做，不碰真实数据）：
 *   1. `-D --dryrun`：只列出待清理的 .tmp，**不移动**文件
 *   2. `-D`：把 .tmp / .tmp.bad 移入回收站（可恢复），普通文件不动
 *   3. `-d "downJson,50"`：按 50 条拆分 120 条清单 → 3 个文件，**原文件不变**
 *   4. `--setting`：打印配置且退出码 0
 *   5. `-h` / 无参数：退出码分别为 0 / 2
 *   6. 未登录执行需要登录的命令：退出码 1 且提示明确
 *
 * 用法：node test/cli-e2e-check.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli.js');

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

/** 跑一次 CLI（用临时 dataRoot/stateDir，完全隔离真实配置） */
function runCli(args, env) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` };
}

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'pxrepo-cli-'));
  const dataRoot = join(dir, 'data');
  const stateDir = join(dir, 'state');
  const env = { PXREPO_DATA_ROOT: dataRoot, PXREPO_STATE_DIR: stateDir, PXREPO_PROGRESS: 'multi' };

  try {
    // 造样本：两个断点文件 + 一个正常文件
    mkdirSync(join(dataRoot, 'creator'), { recursive: true });
    writeFileSync(join(dataRoot, 'creator', 'a.jpg.tmp'), 'partial-a');
    writeFileSync(join(dataRoot, 'creator', 'b.jpg.tmp.bad'), 'bad-b');
    writeFileSync(join(dataRoot, 'creator', 'c.jpg'), 'complete-c');

    // 1. dryrun 清理：只报告不动手
    const dry = runCli(['-D', '--dryrun'], env);
    assert('① -D --dryrun 报告 2 个断点文件', dry.code === 0 && /发现 2 个断点文件/.test(dry.out), dry.out.trim().slice(-80));
    assert('② dryrun 不移动任何文件',
      existsSync(join(dataRoot, 'creator', 'a.jpg.tmp')) && existsSync(join(dataRoot, 'creator', 'b.jpg.tmp.bad')),
      '文件被移动了');

    // 2. 真清理：移入回收站
    const clean = runCli(['-D'], env);
    const trashRoot = join(stateDir, 'trash');
    const trashed = existsSync(trashRoot) ? readdirSync(trashRoot).flatMap((d) => readdirSync(join(trashRoot, d))) : [];
    assert('③ -D 把断点文件移入回收站', clean.code === 0 && trashed.length === 2, `trash=${JSON.stringify(trashed)}`);
    assert('④ 断点文件已离开下载目录且正常文件未动',
      !existsSync(join(dataRoot, 'creator', 'a.jpg.tmp')) && existsSync(join(dataRoot, 'creator', 'c.jpg')),
      '清理结果不符');

    // 3. 拆分清单
    mkdirSync(stateDir, { recursive: true });
    const listFile = join(stateDir, 'download.json');
    writeFileSync(listFile, JSON.stringify(Array.from({ length: 120 }, (_v, i) => ({ id: 1000 + i, name: `c${i}` }))), 'utf8');
    const before = readFileSync(listFile, 'utf8');
    const divide = runCli(['-d', 'downJson,50'], env);
    const parts = readdirSync(stateDir).filter((f) => /^download\.json\.\d+\.json$/.test(f)).sort();
    assert('⑤ -d 拆出 3 个分片', divide.code === 0 && parts.length === 3, `parts=${JSON.stringify(parts)}`);
    assert('⑥ -d 不改动原文件', readFileSync(listFile, 'utf8') === before, '原文件被改写');

    // 4. 查看配置
    const setting = runCli(['--setting'], env);
    assert('⑦ --setting 退出码 0 且显示数据根', setting.code === 0 && setting.out.includes(dataRoot), setting.out.trim().slice(0, 60));

    // 5. 帮助与无命令
    assert('⑧ -h 退出码 0', runCli(['-h'], env).code === 0, '');
    assert('⑨ 无参数退出码 2', runCli([], env).code === 2, '');

    // 6. 需要登录的命令：明确报错、退出码 1
    const needLogin = runCli(['-u', '12345'], { ...env, PXREPO_REFRESH_TOKEN: '' });
    assert('⑩ 未登录命令退出码 1 且提示明确',
      needLogin.code === 1 && /未登录/.test(needLogin.out), `code=${needLogin.code} out=${needLogin.out.trim().slice(-60)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main();
