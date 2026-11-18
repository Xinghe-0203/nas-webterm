// 按变体生成 AI 桥接入口：普通版指向空实现，AI 版指向真实现。
//
// 为什么要这一步：Vite 的静态 import 无法按条件裁剪。用一个「变体入口」文件
// 让两个实现互斥，打包器就只会把用到的那个收进 bundle——普通版的 JS 里
// 一行 AI 代码都不会有。
//
// 用法：node scripts/variant-bridge.mjs <plain|ai>
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const variant = process.argv[2];
if (!['plain', 'ai'].includes(variant)) {
  console.error('用法: node scripts/variant-bridge.mjs <plain|ai>');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'src', 'ai', 'bridge-entry.ts');

const body = `/**
 * AI 桥接入口（由 scripts/variant-bridge.mjs 生成，勿手改）。
 *
 * 变体：${variant}
 * ${
   variant === 'plain'
     ? '普通版：指向空实现，AI 代码完全不进 bundle。'
     : 'AI 版：指向真实现。'
 }
 */
export { AI_BRIDGE, createAiBridge } from './${
   variant === 'plain' ? 'bridge-null' : 'bridge-ai'
 }';
`;

writeFileSync(target, body, 'utf8');
console.log(`variant-bridge: ${variant} → ${target}`);
