/**
 * AI 助手与主程序之间的接口。
 *
 * 目的：让 app.ts（终端主体）**不包含任何 AI 代码**。
 * 普通版用 `null` 实现（见 `bridge-null.ts`），AI 版用真实现（见 `bridge-ai.ts`）。
 * 构建时按变体选一个，AI 版的实现不会进普通版的 bundle。
 */

export interface AiBridge {
  /** 是否启用 AI（普通版恒为 false） */
  readonly enabled: boolean;

  /** 初始化（在 App 启动时调用一次） */
  init(): Promise<void>;

  /** 面板是否可见 */
  readonly visible: boolean;

  /** 显示 / 隐藏面板 */
  setVisible(visible: boolean, remember?: boolean): void;

  /** 切换面板显隐 */
  toggle(): void;

  /** 从终端发一段自然语言给 AI（面板输入框提交时调用） */
  submitText(text: string): void;

  /** 停止当前任务 */
  stop(): void;

  /** 重新开始一轮对话 */
  reset(): void;

  /** 打开 AI 设置 */
  openSettings(): void;

  /** 关闭 AI 设置 */
  closeSettings(): void;

  /** 面板是否在显示（用于右键菜单等） */
  isVisible(): boolean;

  /** 往当前终端写输入（AI 执行命令时用） */
  writeActiveInput(text: string): void;
}
