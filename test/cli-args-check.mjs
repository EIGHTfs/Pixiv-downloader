#!/usr/bin/env node
/**
 * test/cli-args-check.mjs —— 命令行解析与命令分发检查（零依赖、离线）
 *
 * 覆盖场景：
 *   1. 布尔开关（--dryrun / -D / --logout）
 *   2. 必填值（-u / --pid / --concurrency）与 `--key=value` 形式
 *   3. 可选值：-G false 吃值、-G 单独出现不吃值、-U downJson / -U x.json 吃值、-U 后跟路径不吃值
 *   4. 位置参数（path）不与可选值混淆：`-U /data --dryrun` 中 /data 必须是 path
 *   5. 未知参数报错、必填缺值报错
 *   6. `--` 之后全部按位置参数
 *   7. 命令分发优先级（login > logout > get > … > setting）与无命令返回 null
 *
 * 用法：node test/cli-args-check.mjs
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parseArgs, pickCommand, VERSION, OPTION_SPECS } = require(join(ROOT, 'cli.js'));

let pass = 0;
let fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

function main() {
  // 1. 布尔开关
  const b = parseArgs(['--dryrun', '-D']);
  assert('① 布尔开关解析', b.dryrun === true && b.delete === true, JSON.stringify(b));

  // 2. 必填值 + = 形式
  const r1 = parseArgs(['-u', '111,222', '--concurrency', '3']);
  assert('② 必填值解析', r1.uid === '111,222' && r1.concurrency === '3', JSON.stringify(r1));
  const r2 = parseArgs(['--uid=333', '--tps=0']);
  assert('③ --key=value 形式', r2.uid === '333' && r2.tps === '0', JSON.stringify(r2));

  // 3. 可选值
  const o1 = parseArgs(['-G', 'false']);
  assert('④ -G false 吃值', o1.get === 'false', JSON.stringify(o1));
  const o2 = parseArgs(['-G', '--dryrun']);
  assert('⑤ -G 单独出现不吃值', o2.get === true && o2.dryrun === true, JSON.stringify(o2));
  const o3 = parseArgs(['-U', 'downJson']);
  assert('⑥ -U downJson 吃值', o3.update === 'downJson', JSON.stringify(o3));
  const o4 = parseArgs(['-U', 'list.json']);
  assert('⑦ -U list.json 吃值', o4.update === 'list.json', JSON.stringify(o4));
  const o5 = parseArgs(['-U', '--dryrun']);
  assert('⑧ -U 后跟开关不吃值', o5.update === true && o5.dryrun === true, JSON.stringify(o5));

  // 4. 位置参数
  const p1 = parseArgs(['-U', '/data/root', '--dryrun']);
  assert('⑨ 位置参数不被 -U 吃掉', p1.update === true && p1._positional[0] === '/data/root', JSON.stringify(p1));
  const p2 = parseArgs(['-u', '111', '/data/root']);
  assert('⑩ 位置参数与必填值共存', p2.uid === '111' && p2._positional[0] === '/data/root', JSON.stringify(p2));

  // 5. 错误
  let unknownErr = '';
  try { parseArgs(['--nope']); } catch (err) { unknownErr = err.message; }
  assert('⑪ 未知参数报错', /未知参数/.test(unknownErr), unknownErr);
  let missingErr = '';
  try { parseArgs(['-u']); } catch (err) { missingErr = err.message; }
  assert('⑫ 必填缺值报错', /需要一个值/.test(missingErr), missingErr);

  // 6. -- 之后
  const d = parseArgs(['-u', '1', '--', '--dryrun', 'x']);
  assert('⑬ -- 之后全部按位置参数', d.dryrun === undefined && d._positional.join(',') === '--dryrun,x', JSON.stringify(d._positional));

  // 7. 分发
  assert('⑭ 无命令返回 null', pickCommand(parseArgs([])) === null && pickCommand(parseArgs(['--dryrun'])) === null, '应有 null');
  const cmdLogin = pickCommand(parseArgs(['--login']));
  const cmdGet = pickCommand(parseArgs(['-G']));
  const cmdSetting = pickCommand(parseArgs(['--setting']));
  assert('⑮ 命令分发正确', typeof cmdLogin === 'function' && typeof cmdGet === 'function'
    && typeof cmdSetting === 'function' && cmdLogin !== cmdGet && cmdGet !== cmdSetting, '分发函数异常');
  const both = pickCommand(parseArgs(['--login', '-G']));
  assert('⑯ 多命令时按优先级取 login', both === cmdLogin, '优先级不符');

  // 8. 选项表自洽 + 版本
  const names = OPTION_SPECS.map((s) => s.name);
  assert('⑰ 选项表无重名且都有 long', new Set(names).size === names.length && OPTION_SPECS.every((s) => s.long), names.join(','));
  assert('⑱ 版本号可读且非空', /^\d+\.\d+\.\d+/.test(VERSION), VERSION);

  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}

main();
