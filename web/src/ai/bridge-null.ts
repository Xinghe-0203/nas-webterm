/**
 * 普通版的 AI 桥接：**空实现**。
 *
 * 所有方法都是空操作——普通版页面上没有 AI 面板，终端输入也不会被 AI 拦截。
 * 这个文件不含任何 AI 逻辑，所以可以安全地进普通版的 bundle。
 */

import type { AiBridge } from './bridge';

export const AI_BRIDGE: AiBridge = {
  enabled: false,
  visible: false,

  async init(): Promise<void> {
    /* 普通版没有 AI，什么都不用做 */
  },

  setVisible(): void {
    /* 无面板 */
  },

  toggle(): void {
    /* 无面板 */
  },

  submitText(): void {
    /* 不接受 AI 请求 */
  },

  stop(): void {
    /* 没有任务 */
  },

  reset(): void {
    /* 没有对话 */
  },

  openSettings(): void {
    /* 没有设置 */
  },

  closeSettings(): void {
    /* 没有设置 */
  },

  isVisible(): boolean {
    return false;
  },

  writeActiveInput(): void {
    /* 普通版不会让 AI 往终端写东西 */
  },
};

/**
 * 创建桥接（普通版恒为空实现）。
 *
 * 参数类型故意写得很宽松：普通版不 import bridge-ai.ts，
 * 所以这里的 deps 类型不能引用 AI 专用的类型。
 */
export function createAiBridge(_deps: unknown): AiBridge {
  return AI_BRIDGE;
}
