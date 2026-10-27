// 构建后处理：把 index.html 里的相对资源路径改写成 __FN_BASE_RAW__ 占位符。
//
// 原因：应用挂在网关前缀 /app/<appname>/ 下，浏览器若按相对路径解析
// "./assets/x.js"，在 URL 缺少结尾斜杠时会解析成 /app/assets/x.js 而 404。
// 改写成占位符后由 Rust 服务在响应时注入真实前缀。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = join(here, '..', '..', 'app', 'ui');
const indexPath = join(uiDir, 'index.html');

if (!existsSync(indexPath)) {
  console.error('[postbuild] 找不到 index.html:', indexPath);
  process.exit(1);
}

let html = readFileSync(indexPath, 'utf8');
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
