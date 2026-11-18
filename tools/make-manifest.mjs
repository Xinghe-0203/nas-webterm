#!/usr/bin/env node
/**
 * 生成某个变体（普通版 / AI 版）的 manifest。
 *
 * 两个版本的代码是同一套，只在打包时改：
 *   - appname / display_name / 桌面入口 key（两者可以同时装在一台机器上）
 *   - desc（普通版的介绍里不出现 AI）
 *   - changelog（前面补上本版本的说明）
 *
 * 用法：node tools/make-manifest.mjs <plain|ai> <version> <out-file>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const variant = process.argv[2];
const version = process.argv[3];
const outFile = process.argv[4];

if (!['plain', 'ai'].includes(variant) || !version || !outFile) {
  console.error('用法: node tools/make-manifest.mjs <plain|ai> <version> <out-file>');
  process.exit(2);
}

const APPNAME = variant === 'plain' ? 'nas-webterm' : 'nas-webterm-ai';
const DISPLAY = variant === 'plain' ? 'Web 终端' : 'Web 终端 AI';

// 版本更新内容统一维护在 manifest 的 changelog 字段里（唯一来源，
// 避免这个脚本里再抄一份、发版时忘了改导致 changelog 与实际版本对不上）。
// 这里只给普通版补一句「不含 AI」，避免用户以为装错了。
const VERSION_NOTE = variant === 'plain' ? '普通版（不含 AI）。' : '';

let text = readFileSync(join(ROOT, 'manifest'), 'utf8');

/** 覆盖某一行 `key = value`（保留对齐用的空格）。 */
function setField(src, key, value) {
  const re = new RegExp(`^(${key}\\s*=\\s*)[^\\n]*$`, 'm');
  if (!re.test(src)) throw new Error(`manifest 缺少字段: ${key}`);
  return src.replace(re, (_m, head) => `${head}${value}`);
}

/** 取某字段的当前值 */
function getField(src, key) {
  const re = new RegExp(`^${key}\\s*=\\s*([^\\n]*)$`, 'm');
  const m = src.match(re);
  return m ? m[1] : '';
}

text = setField(text, 'appname', APPNAME);
text = setField(text, 'display_name', DISPLAY);
text = setField(text, 'desktop_applaunchname', `${APPNAME}.Application`);
text = setField(text, 'version', version);
text = setField(
  text,
  'changelog',
  VERSION_NOTE ? VERSION_NOTE + '<br/><br/>' + getField(text, 'changelog') : getField(text, 'changelog'),
);

if (variant === 'plain') {
  let desc = getField(text, 'desc');
  // 开场介绍里去掉 AI 相关描述
  desc = desc.replace(
    /，右侧可选 AI 助手（[^）]*）/,
    '',
  );
  // 去掉「5. AI 助手…」这一整条
  desc = desc.replace(/<br\/>5\. AI 助手[\s\S]*?(?=<br\/><br\/><strong>安全说明<\/strong>)/, '');
  // 安全说明里不再提 API Key
  desc = desc.replace(
    /3\. 会话数据只在内存中；AI 的 API Key[^<]*/,
    '3. 会话数据只在内存中，不写盘、不上传。',
  );
  text = setField(text, 'desc', desc);
}

writeFileSync(outFile, text, 'utf8');
console.log(`manifest(${variant}) -> appname=${APPNAME} display=${DISPLAY}`);
