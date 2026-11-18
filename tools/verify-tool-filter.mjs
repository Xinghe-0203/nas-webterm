#!/usr/bin/env node
/**
 * 工具标签泄漏回归（不需要浏览器，纯函数）。
 *
 * 背景：模型把协议标签和命令写在**同一行**时会变成
 *   <execute_command> <command>free -h; echo; ps … </command> … </execute_command>
 * 流式输出按任意边界分片。旧实现遇到「这一片只有一个 `<`」时先把 `<` 吐出去，
 * 后面的 `execute_command>` 就成了普通文字，整段标签会漏到界面上（1.1.0 实测）。
 *
 * 这个脚本把每个分片长度都试一遍，并在结尾用 stripProtocolTags 复查一遍。
 *
 * 用法：node tools/verify-tool-filter.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);

// 用 esbuild 现场编译 TS 源码（node_modules 里已有，就不引入新的测试框架）
const esbuild = require(join(root, 'web', 'node_modules', 'esbuild'));
const source = readFileSync(join(root, 'web', 'src', 'ai', 'tool-filter.ts'), 'utf8');
const code = esbuild.transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} };
// eslint-disable-next-line no-new-func
new Function('module', 'exports', code)(mod, mod.exports);
const { ToolFilter, stripProtocolTags } = mod.exports;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

/** 把一段模型输出按 size 分片喂进过滤器 */
function run(text, size) {
  const f = new ToolFilter();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  out += f.finish();
  return out;
}

// 用户截图里的原文（单行标签、命令含管道）
const SINGLE_LINE =
  '\n<execute_command> <command>free -h; echo; ps -eo pid,comm,rss,pmem --sort=-rss | head -15</command>' +
  ' <purpose>查看内存总量与占用，以及 RSS 排名前 15 的进程</purpose>' +
  ' <requires_approval>false</requires_approval> </execute_command>\n\n' +
  '内存偏紧，已用 6.7G/7.4G，可用仅 747M，swap 已吃掉 6.4G。\n';

// 多行标签（模型最常写的格式）
const MULTI_LINE =
  '内存偏紧，先看细节。\n\n' +
  '<execute_command>\n<command>free -h</command>\n<purpose>查看内存</purpose>\n' +
  '<requires_approval>false</requires_approval>\n</execute_command>\n\n' +
  '结论：swap 已吃掉 6.4G。\n';

// 文本里本来就有的 `<`（不能误吞后面的正文）
const WITH_LT =
  'a < b 表示比较。\n\n<execute_command> <command>ls</command> </execute_command>\n结束。\n';

let leaks = 0;
for (const [name, text] of [
  ['单行标签', SINGLE_LINE],
  ['多行标签', MULTI_LINE],
  ['正文含 < 号', WITH_LT],
]) {
  for (let size = 1; size <= 40; size += 1) {
    const out = run(text, size);
    const leaked = /execute_command|requires_approval|<\/?command>/.test(out);
    if (leaked) {
      leaks += 1;
      console.log(`  ✗ ${name} 分片=${size} 泄漏：${JSON.stringify(out.slice(0, 90))}`);
      break;
    }
  }
}
check('任意分片下协议标签都不泄漏', leaks === 0, leaks ? `泄漏 ${leaks} 次` : '分片 1–40 全部通过');

// 正文里的文字不能被吃掉
const keepText = run(WITH_LT, 1);
check('正文（含 < 号）保留', keepText.includes('a < b') && keepText.includes('结束。'), JSON.stringify(keepText.trim()));

// 结尾收尾：未闭合的标签尾巴要丢掉，普通文字保留
const dangling = run('先这样。\n<execute_command> <command>ls', 3);
check('未闭合标签在收尾时丢弃', !dangling.includes('execute_command') && dangling.includes('先这样。'));

// 整段复查（面板每次重渲染都会跑）
const rendered = stripProtocolTags(SINGLE_LINE);
check('stripProtocolTags 清掉整个标签', !rendered.includes('execute_command') && rendered.includes('内存偏紧'));

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n结果：${checks.length - failed}/${checks.length} 通过`);
process.exit(failed ? 1 : 0);
