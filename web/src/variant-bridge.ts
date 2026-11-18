/**
 * 变体入口：决定用哪个 AI 桥接实现。
 *
 * 构建时由 `web/scripts/variant-bridge.mjs` 按变体生成：
 *   普通版 → 指向 bridge-null.ts（空实现，AI 代码不进 bundle）
 *   AI 版  → 指向 bridge-ai.ts（真实现）
 *
 * 这样 app.ts（终端主体）完全不需要知道当前是哪个变体，
 * 也不用写任何 `if (isAi)` 分支。
 */

export { AI_BRIDGE, createAiBridge } from './ai/bridge-entry';
