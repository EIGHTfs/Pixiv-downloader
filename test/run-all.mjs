#!/usr/bin/env node
/**
 * test/run-all.mjs —— 一键跑全部测试（零依赖）
 *
 * 用法：
 *   node test/run-all.mjs              跑 test/ 下所有 *check*.mjs
 *   node test/run-all.mjs --all        连需要外部条件的脚本（代理/候选文件）也一起跑
 *   node test/run-all.mjs --only http  只跑名字含 http 的
 *   node test/run-all.mjs --list       只列清单
 *
 * 退出码约定（子脚本）：
 *   0 = 全部断言通过；1 = 有断言失败；2 = 环境不具备（缺代理/缺参数）→ 本运行器记为 SKIP
 */

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

/** 默认跑的脚本：文件名含 check 的（其余是需要外部输入的工具型脚本） */
function listTests({ all, only }) {
  const files = readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && f !== 'run-all.mjs')
    .filter((f) => (all ? true : /check/.test(f)))
    .filter((f) => (only ? f.includes(only) : true))
    .sort();
  return files;
}

/** 跑一个脚本，返回 {code, output} */
function runOne(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(HERE, file)], { cwd: ROOT, env: process.env });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolvePromise({ code, output }));
  });
}

/** 从输出里解析「结果: X PASS / Y FAIL」 */
function parseResult(output) {
  const matched = /结果:\s*(\d+)\s*PASS\s*\/\s*(\d+)\s*FAIL/.exec(output);
  if (!matched) return null;
  return { pass: Number(matched[1]), fail: Number(matched[2]) };
}

async function main() {
  const argv = process.argv.slice(2);
  const all = argv.includes('--all');
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  const files = listTests({ all, only });

  if (argv.includes('--list')) {
    console.log(`可用测试脚本（${files.length}）：`);
    for (const file of files) console.log(`  ${file}`);
    return 0;
  }
  if (!files.length) {
    console.error('没有匹配的测试脚本');
    return 2;
  }

  console.log(`跑 ${files.length} 个测试脚本（cwd=${ROOT}）\n`);
  let totalPass = 0;
  let totalFail = 0;
  const skipped = [];
  const failed = [];

  for (const file of files) {
    const { code, output } = await runOne(file);
    const parsed = parseResult(output);
    if (code === 2 && !parsed) {
      skipped.push(file);
      console.log(`SKIP  ${file.padEnd(30)} ${output.trim().split('\n').pop().slice(0, 70)}`);
      continue;
    }
    if (parsed) {
      totalPass += parsed.pass;
      totalFail += parsed.fail;
      console.log(`${parsed.fail ? 'FAIL' : 'PASS'}  ${file.padEnd(30)} ${parsed.pass} PASS / ${parsed.fail} FAIL`);
      if (parsed.fail) failed.push(file);
    } else {
      totalFail += 1;
      failed.push(file);
      console.log(`FAIL  ${file.padEnd(30)} 输出无法解析（退出码 ${code}）`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  }

  console.log(`\n总计: ${totalPass} PASS / ${totalFail} FAIL｜脚本 ${files.length - skipped.length} 跑、${skipped.length} 跳过`);
  if (skipped.length) console.log(`跳过（需外部条件）: ${skipped.join(', ')}`);
  if (failed.length) console.log(`失败: ${failed.join(', ')}`);
  return totalFail ? 1 : 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error('[run-all] 异常:', err && err.stack || err);
    process.exitCode = 1;
  });
