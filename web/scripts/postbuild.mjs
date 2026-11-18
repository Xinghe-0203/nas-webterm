// 构建后处理：
//   1. 把 index.html 里的相对资源路径改写成 __FN_BASE_RAW__ 占位符
//      （应用挂在网关前缀 /app/<appname>/ 下，浏览器按相对路径解析会 404）
//   2. 普通版：把 AI 相关的 DOM 整块删掉
//
// 用法：node scripts/postbuild.mjs [--plain]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, '..', '..', 'app', 'ui');
const indexPath = join(uiDir, 'index.html');

const plain = process.argv.includes('--plain');

if (!existsSync(indexPath)) {
  console.error('[postbuild] 找不到 index.html:', indexPath);
  process.exit(1);
}

let html = readFileSync(indexPath, 'utf8');

// 1) 资源路径占位符
const before = html;
html = html.replaceAll('"./assets/', '"__FN_BASE_RAW__assets/');
html = html.replaceAll("'./assets/", "'__FN_BASE_RAW__assets/");
html = html.replaceAll('"./images/', '"__FN_BASE_RAW__images/');
html = html.replaceAll("'./images/", "'__FN_BASE_RAW__images/");

if (html === before) {
  console.warn('[postbuild] 未发现需要改写的相对资源路径');
}
writeFileSync(indexPath, html, 'utf8');
console.log('[postbuild] 已改写资源路径为 __FN_BASE_RAW__ 占位符');

// 2) 普通版：删掉 AI 相关的 DOM
if (plain) {
  let out = html;
  // 成对元素（dialog / div / span…）：连内容一起删
  out = out.replace(
    /<([a-zA-Z][\w-]*)\b[^>]*\bdata-ai-only\b[^>]*>[\s\S]*?<\/\1>/g,
    '',
  );
  // 自闭合 / 单标签：只删标签本身
  out = out.replace(/<[^>]*\bdata-ai-only\b[^>]*>/g, '');
  writeFileSync(indexPath, out, 'utf8');

  const left = (out.match(/data-ai-only/g) || []).length;
  if (left) {
    console.error(`[postbuild] 普通版仍有 ${left} 处 AI 标记残留`);
    process.exit(1);
  }
  if (out.includes('ai-dock') || out.includes('ai-settings-dialog')) {
    console.error('[postbuild] 普通版的 index.html 仍含 AI 容器');
    process.exit(1);
  }
  console.log('[postbuild] 普通版：已删除全部 AI 相关 DOM');
}
