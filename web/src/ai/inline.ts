/**
 * 终端输入拦截层：判断「这一行是命令还是说话」。
 *
 * 交互（对标阿里云 Workbench 的 AI 终端）：
 *
 *   root@nas:~# 帮我看看磁盘满了吗⏎
 *     → 右侧 AI 面板出现对话、命令卡片与输出，终端里不再有任何 AI 文字
 *   root@nas:~# df -h
 *     → 完全不经过 AI，直接进 shell
 *
 * 关键点：
 *  - 普通命令**完全不拦截**，直接进 PTY；只有判定为自然语言的输入才被吞下。
 *  - 判断用服务端下发的真实命令清单（PATH 扫描），不再依赖写死的词表；
 *    所以 `opencode`、`lazygit` 这类工具不会被误判成自然语言。
 *  - 粘贴多行、Tab 补全（`\t`）、方向键这些会让「已输入的一行」变得不可靠，
 *    所以只跟踪**确定能跟踪的**按键：可打印字符 + 退格 + 回车。
 *  - 处在 AI 任务中时，Ctrl+C 一律用来打断 AI，而不是发给 shell。
 */

import { detectKind, type DetectOptions } from './detect';
import { AgentRunner } from './agent';
import type { AiPanel } from './panel';
import type { Conversation } from './history';

export interface InlineAiOptions {
  base: string;
  getSid: () => string;
  /** 往 PTY 直接写（抹掉命令行、任务结束后补空行用） */
  sendRaw: (text: string) => void;
  /** 配置是否可用（未启用/未配 Key 时提示而不是发请求） */
  isReady: () => boolean;
  /** 未就绪时打开设置窗 */
  openSettings: () => void;
  /** 未启用/未配置时的提示文案（写在终端里，因为这时面板不可用） */
  onBlocked: (message: string) => void;
  /** 开始一次 AI 任务前调用（用来把面板展开） */
  ensureVisible: () => void;
  /** 状态变化（顶栏按钮高亮） */
  onState?: (state: 'idle' | 'running') => void;
  /** 把整行输入直接交给 AI（面板内的建议词） */
  panel: AiPanel;
}

const CTRL_C = '\x03';
const CTRL_U = '\x15';

/**
 * 把 shell 里已经敲进去的这一行彻底丢掉。
 *
 * 用 Ctrl+U 是不够的，而且是**有害的**：实测在 bash 里清 UTF-8 的行时
 * readline 只吃掉了行首的一部分字节，剩下的 `$'\270\256我看看磁盘'` 会被
 * 当成命令名执行，终端里多出一行 `command not found`。
 * Ctrl+C 是无条件丢弃当前输入：干净、跨 readline 键位（emacs/vi）都有效，
 * 代价只是终端里留一个 `^C`——比执行半条残句安全得多。
 */
const CLEAR_LINE = CTRL_C;

const ESC = '\x1b';

/**
 * 这一段输入能不能安全地追加到「当前行」上。
 *
 * 只含可打印字符的块是安全的：输入法提交一个词、终端快速连发几个字符、
 * 粘贴一段单行文本，都属于这种。含控制字符（回车、Tab、裸 ESC、其它 C0）
 * 的块不安全——粘贴多行脚本、Tab 补全、方向键都会让光标位置偏离，
 * 我们没法再准确地知道这一行现在是什么。
 */
function printableOnly(data: string): boolean {
  for (const ch of data) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return data.length > 0;
}

export class InlineAi {
  private opts: InlineAiOptions;
  private runner: AgentRunner;
  /** 当前行已经敲进去的字符（用来做意图判断） */
  private line = '';
  /** 这一行是否「可信」：出现过粘贴/补全/方向键后就不再跟踪 */
  private lineTrusted = true;
  private detectOpts: DetectOptions = {};

  constructor(opts: InlineAiOptions) {
    this.opts = opts;
    this.runner = new AgentRunner({
      base: opts.base,
      getSid: opts.getSid,
      panel: opts.panel,
      onState: opts.onState,
      onFinished: () => {
        // 任务结束后补一个干净的空行，避免 shell 提示符紧贴着上一段输出
        opts.sendRaw('\r');
      },
    });
  }

  get isRunning(): boolean {
    return this.runner.isBusy;
  }

  /** 当前聊天记录的会话 id（空 = 还没开始）。 */
  get conversationId(): string {
    return this.runner.conversationId;
  }

  /** 打开一段历史会话（回显并接着聊）。 */
  openConversation(conv: Conversation): void {
    this.runner.openConversation(conv);
  }

  /** 忘掉当前会话（记录被删除时用）。 */
  forgetConversation(): void {
    this.runner.forgetConversation();
  }

  /** 页面加载时恢复上一次的会话。 */
  async restoreLast(): Promise<void> {
    await this.runner.restoreLast();
  }

  /** 服务端下发的命令清单（PATH 扫描结果）。 */
  setCommands(commands: ReadonlySet<string>): void {
    this.detectOpts = { commands };
  }

  /** 清空对话上下文（New Conversation）。 */
  reset(): void {
    this.runner.reset();
    this.opts.panel.reset();
    this.line = '';
  }

  /** 手动打断（Ctrl+C 在面板/终端里、或点停止按钮）。 */
  stop(): void {
    this.runner.stop();
  }

  /**
   * Shift+Enter：不管这一行看起来像不像命令，一律当自然语言送给 AI。
   * 返回 false 表示当前没内容可发，让 xterm 按普通回车处理。
   */
  forceNatural(): boolean {
    if (this.runner.isBusy) return true; // 已经在跑，吞掉即可
    const text = this.line.trim();
    this.line = '';
    this.lineTrusted = true;
    if (!text) return false;
    this.startNatural(text);
    return true;
  }

  /** 面板里点了一个建议词。 */
  submitText(text: string): void {
    this.startNatural(text);
  }

  /**
   * 键盘输入入口。返回 true 表示这次输入被 AI 层吃掉，不再进 PTY。
   */
  handle(data: string): boolean {
    if (this.runner.isBusy) {
      // 生成/执行中只认 Ctrl+C
      if (data === CTRL_C) {
        this.runner.stop();
        this.line = '';
        this.lineTrusted = true;
      }
      return true;
    }

    // 方向键、Home/End 等：我们没法跟踪 shell 光标，放弃跟踪这一行
    if (data.startsWith(ESC)) {
      this.lineTrusted = false;
      return false;
    }

    if (data === '\r' || data === '\n') {
      const raw = this.line;
      const trusted = this.lineTrusted;
      this.line = '';
      this.lineTrusted = true;
      const text = raw.trim();
      if (!text) return false; // 空回车照常交给 shell

      // 这一行被粘贴/补全/方向键改过：位置已经不可靠，宁可不判断，
      // 让 shell 自己处理。误吞一条命令的代价远大于多发一次 AI 请求。
      if (!trusted) return false;

      const result = detectKind(text, this.detectOpts);
      if (result.kind === 'command') return false; // 普通命令：完全交给 PTY

      this.startNatural(result.text);
      return true; // 吞掉这个回车，不发给 shell
    }

    if (data === '\x7f' || data === '\b') {
      this.line = this.line.slice(0, -1);
      return false;
    }

    if (data === CTRL_C || data === CTRL_U) {
      this.line = '';
      this.lineTrusted = true;
      return false;
    }

    // 可打印的块（输入法提交、终端连发、单行粘贴）可以安全追加
    if (printableOnly(data)) {
      this.line += data;
      return false;
    }

    // 含控制字符的块（多行粘贴、Tab 补全、Ctrl+R…）：光标位置不可知，
    // 放弃跟踪这一行，交给 shell 自己处理。
    this.lineTrusted = false;
    this.line = '';
    return false;
  }

  /** 把这一行从 shell 里抹掉，然后交给 agent。 */
  startNatural(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.opts.isReady()) {
      // 抹掉命令行，避免留一行没执行的文字在提示符上
      this.opts.sendRaw(`${CLEAR_LINE}\r`);
      this.opts.onBlocked('AI 尚未启用或未配置 API Key。按 Ctrl+Alt+A 打开设置。');
      this.opts.openSettings();
      return;
    }
    // 面板要先展开：AI 的输出全部在面板里，终端里不显示
    this.opts.ensureVisible();
    // 这里**不**清行：清行由服务端在写入第一条命令前完成。
    // 浏览器发出的 Ctrl+C 和 agent 写入的命令走两条独立的路径
    // （前者经 WebSocket，后者在服务端直接写 PTY），谁先到达不确定，
    // 偶尔会把「已输入的半行」和命令粘在一起执行（`帮我看看磁盘 df -h`）。
    // 服务端在同一个输入通道里先写 Ctrl+C 再写命令，顺序就一定有保证。
    this.line = '';
    this.lineTrusted = true;
    void this.runner.run(trimmed);
  }
}
