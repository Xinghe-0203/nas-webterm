/**
 * AI 聊天框（右下角浮动）。
 *
 * 形态：像聊天软件的气泡，浮在终端上方，**不挤占终端宽度**。
 * —— 终端是主角，AI 是随时可以叫出来、也可以随手收起的辅助面板。
 *
 * 结构很克制：顶部只有状态点 + 三个玻璃按钮，没有标题、没有 logo；
 * 对话区直接铺在玻璃上；底部是真正的输入框（回车发送，Shift+Enter 换行）。
 * 命令仍是一张可折叠卡片：标题「AI 正在执行 · 命令」，展开看命令、目的与输出。
 *
 * 视觉尺寸（宽度/高度）可拖动左上角调整，记忆在 localStorage。
 */

import { renderMarkdown } from './md-html';
import { stripProtocolTags } from './tool-filter';
import type { Conversation, HistoryCommand } from './history';
// AI 面板的样式独立成文件：普通版的面板模块不进 bundle，这里面的样式也不会进普通版的 CSS。
import './panel.css';

export interface PendingCommand {
  command: string;
  purpose: string;
  danger: boolean;
  reason: string;
  /** 需要人工确认（删除 / 改写文件）；false 表示服务端会直接执行 */
  needsApproval: boolean;
}

export type Decision = 'run' | 'skip' | 'stop';

export interface Answer {
  decision: Decision;
  command?: string;
}

export interface StepView {
  /** 命令已写入 PTY */
  markRunning(): void;
  /** 拿到命令输出与退出码（可选，用于卡片里显示） */
  setOutput(text: string, timedOut: boolean, exitCode?: number | null): void;
  markSkipped(): void;
  markStopped(): void;
  markError(message: string): void;
  markDone(): void;
}

export interface StepResult {
  view: StepView;
  answer: Promise<Answer>;
  /** 服务端直接执行，不需要用户确认 */
  auto: boolean;
}

type Status = 'idle' | 'thinking' | 'waiting' | 'running' | 'error';

const SIZE_KEY = 'nas-webterm.aiBubble';
const MIN_W = 320;
const MIN_H = 340;

const STATUS_TEXT: Record<Status, string> = {
  idle: '待命',
  thinking: '思考中',
  waiting: '等待确认',
  running: '执行中',
  error: '出错',
};

export class AiPanel {
  private root: HTMLElement;
  private thread: HTMLElement;
  private stateEl: HTMLElement;
  private dotEl: HTMLElement;
  private composer: HTMLFormElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private stopBtn: HTMLButtonElement;
  private onSubmit: ((text: string) => void) | null = null;
  private onStop: (() => void) | null = null;
  private onOpenSettings: (() => void) | null = null;
  private assistantEl: HTMLElement | null = null;
  private assistantRaw = '';
  private raf = 0;
  private emptyEl: HTMLElement | null = null;
  private ready = false;
  private model = '';
  private status: Status = 'idle';
  /**
   * 当前被用户展开的卡片。
   *
   * 它存在时**不再自动滚到底**：模型随后流式吐出的长文本会把卡片顶出屏幕，
   * 用户就只剩卡片标题那一条线可看（1.1.1 实测）。
   */
  private openCard: HTMLElement | null = null;
  /** 是否「贴着底部」：只有用户本来就在底部时才跟着新内容滚 */
  private stick = true;
  /** 「跳到最新」提示：不跟随的时候露出来 */
  private jumpEl: HTMLButtonElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.classList.add('ai-bubble');
    this.root.replaceChildren();

    // 左上角拖拽调整大小（锚定右下角，所以拖左上角最自然）
    const grip = document.createElement('div');
    grip.className = 'ai-grip';
    grip.title = '拖动调整大小';
    grip.setAttribute('aria-hidden', 'true');
    this.root.append(grip);
    this.bindResize(grip);

    const head = document.createElement('div');
    head.className = 'ai-head';

    const state = document.createElement('span');
    state.className = 'ai-state';
    this.dotEl = document.createElement('i');
    this.dotEl.className = 'ai-dot';
    this.stateEl = document.createElement('span');
    this.stateEl.className = 'ai-state-text';
    this.stateEl.textContent = STATUS_TEXT.idle;
    state.append(this.dotEl, this.stateEl);

    const actions = document.createElement('div');
    actions.className = 'ai-actions';
    actions.append(
      this.iconButton('ai-panel-history', '聊天记录', [
        // 时钟 + 顺时针箭头：常见的「历史」图标
        'M8 4.1a3.9 3.9 0 1 1-3.6 2.4',
        'M8 2.1v2.2H5.8',
        'M8 5.6v2.7l1.8 1.1',
      ]),
      this.iconButton('ai-panel-new', '新对话', [
        'M8 3.4v9.2M3.4 8h9.2',
      ]),
      this.iconButton('ai-panel-settings', '设置', [
        'M8 5.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z',
        'M8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.7 3.7l.9.9M11.4 11.4l.9.9M12.3 3.7l-.9.9M4.6 11.4l-.9.9',
      ]),
      this.iconButton('ai-panel-close', '收起', ['M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6']),
    );

    head.append(state, actions);

    this.thread = document.createElement('div');
    this.thread.className = 'ai-thread';
    this.thread.setAttribute('role', 'log');
    this.thread.setAttribute('aria-live', 'polite');
    // 用户滚到底部才继续「跟随」；往回翻看时不要被新内容拽回去
    this.thread.addEventListener('scroll', () => {
      const el = this.thread;
      this.stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      this.updateJump();
    });

    this.composer = document.createElement('form');
    this.composer.className = 'ai-composer';
    this.input = document.createElement('textarea');
    this.input.className = 'ai-input';
    this.input.rows = 1;
    this.input.spellcheck = false;
    this.input.placeholder = '在下方输入，或直接在终端里说中文…';
    this.input.setAttribute('aria-label', '给 AI 发消息');
    this.sendBtn = this.sendButton();
    this.stopBtn = this.stopButton();
    this.composer.append(this.input, this.stopBtn, this.sendBtn);

    this.root.append(head, this.thread, this.composer);

    // 「跳到最新」：用户往上翻、或展开的卡片挡住新内容时露出来
    this.jumpEl = document.createElement('button');
    this.jumpEl.type = 'button';
    this.jumpEl.className = 'ai-jump';
    this.jumpEl.hidden = true;
    this.jumpEl.textContent = '跳到最新 ↓';
    this.jumpEl.addEventListener('click', () => {
      this.setOpenCard(null);
      this.scrollToEnd();
    });
    this.root.append(this.jumpEl);

    this.input.addEventListener('input', () => this.autoGrow());
    this.input.addEventListener('keydown', (e) => {
      // 中文/日文输入法在组词状态下按回车是「确认候选词」，不是发送。
      // 不判断的话，打「内存占用」选词那一下就会把半截话发出去。
      if (e.isComposing || (e as KeyboardEvent).keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.submit();
      }
    });
    this.composer.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.sendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.stopBtn.addEventListener('click', (e) => {
      e.preventDefault();
      this.onStop?.();
    });

    this.restoreSize();
    this.renderEmpty();
  }

  /** 顶部三个按钮的回调。 */
  bindHeader(onNew: () => void, onSettings: () => void, onClose: () => void): void {
    this.onOpenSettings = onSettings;
    this.root.querySelector('#ai-panel-new')?.addEventListener('click', onNew);
    this.root.querySelector('#ai-panel-settings')?.addEventListener('click', onSettings);
    this.root.querySelector('#ai-panel-close')?.addEventListener('click', onClose);
  }

  /** 「聊天记录」按钮的回调。 */
  bindHistory(onOpen: () => void): void {
    this.root.querySelector('#ai-panel-history')?.addEventListener('click', onOpen);
  }

  /**
   * 把一份历史会话渲染到面板里（只读，不带审批按钮）。
   *
   * 块顺序与服务端记录一致：文字、命令卡片、文字……所以看到的
   * 就是当时的对话原样。
   */
  renderConversation(conv: Conversation): void {
    this.reset();
    this.ensureThread();
    let stepIndex = 0;
    for (const turn of conv.turns) {
      if (turn.user) this.addUser(turn.user);
      const blocks = turn.blocks?.length
        ? turn.blocks
        : [{ type: 'text' as const, text: turn.assistant }];
      for (const block of blocks) {
        if (block.type === 'text') {
          const safe = stripProtocolTags(String(block.text ?? ''));
          if (safe.trim()) {
            this.startAssistant();
            this.appendMarkdown(safe);
            this.endAssistant();
          }
        } else if (block.command?.command) {
          // 命令卡片要有命令本体；旧数据 / 损坏文件里的空块直接跳过
          this.addHistoryCommand(block.command, stepIndex);
          stepIndex += 1;
        }
      }
    }
    this.setStatus('idle');
    this.scrollToEnd();
  }

  /** 历史会话里的命令卡片：只读，不出现「执行 / 编辑 / 跳过」。 */
  private addHistoryCommand(cmd: HistoryCommand, step: number): void {
    this.ensureThread();
    this.endAssistant();

    const card = document.createElement('article');
    card.className = 'ai-step';
    const failed = cmd.timedOut || (cmd.exitCode !== null && cmd.exitCode !== 0);
    card.dataset.state = failed ? 'error' : 'done';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ai-step-head';
    head.setAttribute('aria-expanded', 'false');

    const badge = document.createElement('span');
    badge.className = 'ai-step-badge';
    badge.textContent = String(step + 1);

    const label = document.createElement('span');
    label.className = 'ai-step-label';
    label.textContent = failed ? '执行失败' : '已执行';

    const cmdEl = document.createElement('code');
    cmdEl.className = 'ai-step-cmd';
    cmdEl.textContent = oneLine(cmd.command);

    const stateEl = document.createElement('span');
    stateEl.className = 'ai-step-state';
    stateEl.textContent = cmd.timedOut
      ? '超时'
      : typeof cmd.exitCode === 'number' && cmd.exitCode !== 0
        ? `退出码 ${cmd.exitCode}`
        : '完成';

    const chevron = document.createElement('span');
    chevron.className = 'ai-step-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    head.append(badge, label, cmdEl, stateEl, chevron);

    const body = document.createElement('div');
    body.className = 'ai-step-body';
    body.hidden = true;

    if (cmd.purpose) {
      const purpose = document.createElement('p');
      purpose.className = 'ai-step-purpose';
      purpose.textContent = cmd.purpose;
      body.append(purpose);
    }
    if (cmd.danger) {
      const warn = document.createElement('p');
      warn.className = 'ai-step-danger';
      warn.textContent = '高危操作';
      body.append(warn);
    }
    const cmdBlock = document.createElement('pre');
    cmdBlock.className = 'ai-step-code';
    cmdBlock.textContent = cmd.command;
    body.append(cmdBlock);

    if (cmd.output.trim()) {
      const output = document.createElement('pre');
      output.className = 'ai-step-output';
      output.textContent = cmd.output.trim();
      body.append(output);
    }
    if (cmd.timedOut) {
      const note = document.createElement('p');
      note.className = 'ai-step-note';
      note.textContent = '命令执行超时，这里只是已读取的部分输出。';
      body.append(note);
    }

    card.append(head, body);
    this.thread.append(card);
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });
    this.collapseOpenCard();
    this.scrollToEnd();
  }

  /** 输入框发送 / 停止。 */
  bindComposer(onSubmit: (text: string) => void, onStop: () => void): void {
    this.onSubmit = onSubmit;
    this.onStop = onStop;
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** 模型是否已配置；空状态据此给出对应文案。 */
  setReady(ready: boolean): void {
    this.ready = ready;
    if (this.emptyEl) this.renderEmpty();
    this.updateComposer();
  }

  setModel(label: string): void {
    this.model = label || '';
    this.root.title = this.model ? `模型：${this.model}` : '';
    this.updateComposer();
  }

  setStatus(status: Status, text?: string): void {
    this.status = status;
    this.stateEl.textContent = text ?? STATUS_TEXT[status];
    this.dotEl.dataset.state = status;
    this.updateComposer();
  }

  /** 清空当前对话（只清界面，服务端历史由 agent.ts 重置）。 */
  reset(): void {
    this.assistantEl = null;
    this.assistantRaw = '';
    this.thread.replaceChildren();
    this.renderEmpty();
    this.setStatus('idle');
  }

  addUser(text: string): void {
    this.ensureThread();
    const el = document.createElement('article');
    el.className = 'ai-msg ai-msg-user';
    const body = document.createElement('div');
    body.className = 'ai-user-text';
    body.textContent = text;
    el.append(body);
    this.thread.append(el);
    this.setOpenCard(null);
    this.scrollToEnd();
  }

  /** 开启一段助手回复（后续 appendMarkdown 都追加到这段里）。 */
  startAssistant(): void {
    // 已经在写这一段：不要新建元素，否则每片增量都会变成一条独立消息，
    // 表格 / 列表这些需要跨行才能识别的结构就永远拼不起来。
    if (this.assistantEl) return;
    this.ensureThread();
    this.assistantRaw = '';
    const el = document.createElement('article');
    el.className = 'ai-msg ai-msg-assistant';
    const body = document.createElement('div');
    body.className = 'ai-md';
    el.append(body);
    this.thread.append(el);
    this.assistantEl = body;
    this.maybeScrollToEnd();
  }

  /** 流式追加一段 Markdown 原文。整段重渲染，节流到一帧一次。 */
  appendMarkdown(delta: string): void {
    if (!delta) return;
    this.startAssistant();
    this.assistantRaw += delta;
    this.scheduleRender();
  }

  /** 结束当前回复（下次 appendMarkdown 会新开一段）。 */
  endAssistant(): void {
    this.flushRender();
    this.assistantEl = null;
  }

  /** 新建一张命令卡片（可折叠）。 */
  addCommand(cmd: PendingCommand, step: number, auto: boolean): StepResult {
    this.ensureThread();
    this.endAssistant();

    let settled = false;
    let resolveAnswer: (a: Answer) => void = () => undefined;
    const answer = new Promise<Answer>((resolve) => {
      resolveAnswer = resolve;
    });

    const card = document.createElement('article');
    card.className = 'ai-step';
    card.dataset.state = auto ? 'running' : 'pending';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'ai-step-head';
    head.setAttribute('aria-expanded', auto ? 'false' : 'true');

    const badge = document.createElement('span');
    badge.className = 'ai-step-badge';
    badge.textContent = String(step + 1);

    const label = document.createElement('span');
    label.className = 'ai-step-label';

    const cmdEl = document.createElement('code');
    cmdEl.className = 'ai-step-cmd';
    cmdEl.textContent = oneLine(cmd.command);

    const stateEl = document.createElement('span');
    stateEl.className = 'ai-step-state';

    const chevron = document.createElement('span');
    chevron.className = 'ai-step-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.innerHTML =
      '<svg viewBox="0 0 16 16" width="12" height="12"><path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    head.append(badge, label, cmdEl, stateEl, chevron);

    const body = document.createElement('div');
    body.className = 'ai-step-body';
    body.hidden = auto;

    if (cmd.purpose) {
      const purpose = document.createElement('p');
      purpose.className = 'ai-step-purpose';
      purpose.textContent = cmd.purpose;
      body.append(purpose);
    }
    if (cmd.danger && cmd.reason) {
      const warn = document.createElement('p');
      warn.className = 'ai-step-danger';
      warn.textContent = `高危操作：${cmd.reason}`;
      body.append(warn);
    }

    const cmdBlock = document.createElement('pre');
    cmdBlock.className = 'ai-step-code';
    cmdBlock.textContent = cmd.command;
    body.append(cmdBlock);

    const output = document.createElement('pre');
    output.className = 'ai-step-output';
    output.hidden = true;
    body.append(output);

    const actions = document.createElement('div');
    actions.className = 'ai-step-actions';
    if (!auto) body.append(actions);

    const edit = document.createElement('div');
    edit.className = 'ai-step-edit';
    edit.hidden = true;
    const textarea = document.createElement('textarea');
    textarea.className = 'ai-step-editor';
    textarea.rows = 2;
    textarea.spellcheck = false;
    textarea.value = cmd.command;
    const editActions = document.createElement('div');
    editActions.className = 'ai-step-actions';
    edit.append(textarea, editActions);
    body.append(edit);

    card.append(head, body);
    this.thread.append(card);
    // 只保留一张展开的卡片：新的一张出现时，把上一张收起来
    this.collapseOpenCard();
    if (!body.hidden) this.setOpenCard(card);

    const setState = (state: string, labelText: string, stateText: string): void => {
      card.dataset.state = state;
      label.textContent = labelText;
      stateEl.textContent = stateText;
    };

    let armed = false;
    const runBtn = this.actionButton('执行', 'primary');
    const editBtn = this.actionButton('编辑', 'ghost');
    const skipBtn = this.actionButton('跳过', 'ghost');
    const stopBtn = this.actionButton('停止', 'danger');
    actions.append(runBtn, editBtn, skipBtn, stopBtn);

    const settle = (result: Answer): void => {
      if (settled) return;
      settled = true;
      runBtn.disabled = true;
      editBtn.disabled = true;
      skipBtn.disabled = true;
      stopBtn.disabled = true;
      resolveAnswer(result);
    };

    runBtn.addEventListener('click', () => {
      if (cmd.danger && !armed) {
        armed = true;
        runBtn.textContent = '再次确认执行';
        runBtn.classList.add('armed');
        return;
      }
      settle({ decision: 'run' });
      // 不收起：用户点「执行」就是想看这条命令跑出什么，
      // 卡片保持展开，后续输出直接长在里面
      body.hidden = false;
      head.setAttribute('aria-expanded', 'true');
      setState('running', 'AI 正在执行', '执行中');
      this.setOpenCard(card);
      this.keepCardVisible(card);
    });
    skipBtn.addEventListener('click', () => {
      settle({ decision: 'skip' });
      this.markCardSkipped(card, label, stateEl, head, body);
    });
    stopBtn.addEventListener('click', () => {
      settle({ decision: 'stop' });
      this.markCardStopped(card, label, stateEl, head, body);
    });

    editBtn.addEventListener('click', () => {
      edit.hidden = false;
      actions.hidden = true;
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });

    const saveBtn = this.actionButton('保存并执行', 'primary');
    const cancelBtn = this.actionButton('取消', 'ghost');
    editActions.append(saveBtn, cancelBtn);
    cancelBtn.addEventListener('click', () => {
      edit.hidden = true;
      actions.hidden = false;
    });
    saveBtn.addEventListener('click', () => {
      const next = textarea.value.trim();
      if (!next) {
        textarea.focus();
        return;
      }
      cmdEl.textContent = oneLine(next);
      settle({ decision: 'run', command: next });
      edit.hidden = true;
      actions.hidden = false;
      body.hidden = false;
      head.setAttribute('aria-expanded', 'true');
      setState('running', 'AI 正在执行', '执行中');
      this.setOpenCard(card);
      this.keepCardVisible(card);
    });

    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      head.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
      this.setOpenCard(body.hidden ? null : card);
    });

    if (auto) {
      label.textContent = 'AI 正在执行';
      stateEl.textContent = '执行中';
      resolveAnswer({ decision: 'run' });
      settled = true;
      this.scrollToEnd();
    } else {
      label.textContent = 'AI 请求执行';
      stateEl.textContent = cmd.danger ? '高危 · 待确认' : '待确认';
      this.setStatus('waiting');
      this.scrollToEnd();
    }

    const view: StepView = {
      markRunning: () => {
        if (card.dataset.state === 'pending') {
          setState('running', 'AI 正在执行', '执行中');
          // 保持展开：输出马上会长在这张卡片里
          body.hidden = false;
          head.setAttribute('aria-expanded', 'true');
          this.setOpenCard(card);
        }
        this.setStatus('running');
      },
      setOutput: (text: string, timedOut: boolean, exitCode?: number | null) => {
        const trimmed = text.trim();
        if (!trimmed) {
          output.hidden = true;
        } else {
          output.hidden = false;
          output.textContent = trimmed;
        }
        if (timedOut) {
          const note = document.createElement('p');
          note.className = 'ai-step-note';
          note.textContent = '命令执行超时，这里只是已读取的部分输出。';
          body.append(note);
        }
        if (typeof exitCode === 'number' && exitCode !== 0) {
          const note = document.createElement('p');
          note.className = 'ai-step-danger';
          note.textContent = `命令退出码 ${exitCode}`;
          body.append(note);
          if (card.dataset.state === 'running') setState('error', '执行失败', `退出码 ${exitCode}`);
        } else if (card.dataset.state === 'running') {
          setState('done', '已执行', '完成');
        }
        // 执行完就自动折叠：卡片只保留一行「第 N 步 · 命令 · 完成」，
        // 需要看输出时点一下标题即可。否则一张张全展开会把对话挤没。
        body.hidden = true;
        head.setAttribute('aria-expanded', 'false');
        this.clearOpenCard(card);
      },
      markSkipped: () => this.markCardSkipped(card, label, stateEl, head, body),
      markStopped: () => this.markCardStopped(card, label, stateEl, head, body),
      markError: (message: string) => {
        setState('error', '执行失败', '失败');
        const note = document.createElement('p');
        note.className = 'ai-step-danger';
        note.textContent = message;
        body.append(note);
      },
      markDone: () => {
        if (card.dataset.state === 'running') setState('done', '已执行', '完成');
        // 执行完就自动折叠：卡片只保留一行「第 N 步 · 命令 · 完成」，
        // 需要看输出时点一下标题即可。否则一张张全展开会把对话挤没。
        body.hidden = true;
        head.setAttribute('aria-expanded', 'false');
        this.clearOpenCard(card);
      },
    };

    return { view, answer, auto };
  }

  /** 一条系统提示（错误、超时、被中断等）。 */
  addNotice(text: string, kind: 'info' | 'error' = 'info'): void {
    this.ensureThread();
    this.endAssistant();
    const el = document.createElement('p');
    el.className = kind === 'error' ? 'ai-notice error' : 'ai-notice';
    el.textContent = text;
    this.thread.append(el);
    this.maybeScrollToEnd();
  }

  /** 任务结束（成功或失败）时把状态收回待命。 */
  finish(status: 'idle' | 'error' = 'idle'): void {
    this.endAssistant();
    this.setStatus(status);
  }

  /** 当前输入框里的文字（供测试判断是否清空）。 */
  get draft(): string {
    return this.input.value;
  }

  /** 让输入框拿到焦点。 */
  focusInput(): void {
    this.input.focus();
  }

  // ------------------------------------------------------------------ 内部

  private submit(): void {
    // 正在跑任务时不允许再发：否则同一个问题会被提交两遍，
    // 两条流同时往同一个 PTY 里写命令，界面会乱成一团。
    const busy = this.status === 'thinking' || this.status === 'waiting' || this.status === 'running';
    if (busy) return;
    const text = this.input.value.trim();
    if (!text) return;
    if (!this.ready) {
      this.onOpenSettings?.();
      return;
    }
    this.input.value = '';
    this.autoGrow();
    this.onSubmit?.(text);
  }

  private updateComposer(): void {
    const busy = this.status === 'thinking' || this.status === 'waiting' || this.status === 'running';
    this.stopBtn.hidden = !busy;
    this.sendBtn.hidden = busy;
    this.input.placeholder = busy
      ? 'AI 正在处理上一条请求…'
      : this.ready
        ? '在下方输入，或直接在终端里说中文…'
        : '尚未配置模型，先打开设置';
    this.root.dataset.busy = busy ? '1' : '0';
  }

  private autoGrow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight)}px`;
  }

  private bindResize(grip: HTMLElement): void {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;

    const width = (): number => this.root.getBoundingClientRect().width;
    const height = (): number => this.root.getBoundingClientRect().height;

    const move = (e: PointerEvent): void => {
      if (!dragging) return;
      const w = Math.max(MIN_W, Math.min(window.innerWidth - 32, startW - (e.clientX - startX)));
      const h = Math.max(MIN_H, Math.min(window.innerHeight - 100, startH - (e.clientY - startY)));
      document.documentElement.style.setProperty('--bubble-w', `${Math.round(w)}px`);
      document.documentElement.style.setProperty('--bubble-h', `${Math.round(h)}px`);
    };
    const stop = (): void => {
      if (!dragging) return;
      dragging = false;
      this.root.classList.remove('resizing');
      try {
        localStorage.setItem(
          SIZE_KEY,
          JSON.stringify({ w: Math.round(width()), h: Math.round(height()) }),
        );
      } catch {
        /* 忽略 */
      }
    };

    grip.addEventListener('pointerdown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = width();
      startH = height();
      this.root.classList.add('resizing');
      grip.setPointerCapture(e.pointerId);
    });
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', stop);
    grip.addEventListener('pointercancel', stop);
  }

  private restoreSize(): void {
    try {
      const raw = localStorage.getItem(SIZE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { w?: number; h?: number };
      if (Number.isFinite(parsed.w)) {
        const w = Math.max(MIN_W, Math.min(720, Number(parsed.w)));
        document.documentElement.style.setProperty('--bubble-w', `${w}px`);
      }
      if (Number.isFinite(parsed.h)) {
        const h = Math.max(MIN_H, Math.min(window.innerHeight - 100, Number(parsed.h)));
        document.documentElement.style.setProperty('--bubble-h', `${h}px`);
      }
    } catch {
      /* 忽略 */
    }
  }

  private markCardSkipped(
    card: HTMLElement,
    label: HTMLElement,
    stateEl: HTMLElement,
    head: HTMLButtonElement,
    body: HTMLElement,
  ): void {
    card.dataset.state = 'skipped';
    label.textContent = '已跳过';
    stateEl.textContent = '跳过';
    body.hidden = true;
    head.setAttribute('aria-expanded', 'false');
    this.clearOpenCard(card);
    this.setStatus('thinking');
  }

  private markCardStopped(
    card: HTMLElement,
    label: HTMLElement,
    stateEl: HTMLElement,
    head: HTMLButtonElement,
    body: HTMLElement,
  ): void {
    card.dataset.state = 'stopped';
    label.textContent = '已停止';
    stateEl.textContent = '停止';
    body.hidden = true;
    head.setAttribute('aria-expanded', 'false');
    this.clearOpenCard(card);
  }

  private actionButton(text: string, kind: 'primary' | 'ghost' | 'danger'): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `ai-btn ${kind}`;
    btn.textContent = text;
    return btn;
  }

  private sendButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'ai-send';
    btn.title = '发送（Enter）';
    btn.setAttribute('aria-label', '发送');
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 12.8V3.6M4.2 7.2 8 3.4l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return btn;
  }

  private stopButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-stop';
    btn.title = '停止';
    btn.setAttribute('aria-label', '停止');
    btn.hidden = true;
    btn.innerHTML =
      '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" fill="currentColor"/></svg>';
    return btn;
  }

  private iconButton(id: string, title: string, paths: string[]): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-icon';
    btn.id = id;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    for (const d of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('stroke-linecap', 'round');
      svg.append(p);
    }
    btn.append(svg);
    return btn;
  }

  private ensureThread(): void {
    if (this.emptyEl) {
      this.emptyEl.remove();
      this.emptyEl = null;
    }
    if (!this.thread.isConnected) this.root.append(this.thread);
  }

  /**
   * 空状态：只留一句话，不再堆建议词卡片。
   * 没有配置模型时给一个直接可点的入口。
   */
  private renderEmpty(): void {
    const wrap = document.createElement('div');
    wrap.className = 'ai-empty';
    const line = document.createElement('p');
    if (this.ready) {
      line.textContent = '在下方输入，或直接在终端里说中文。';
      wrap.append(line);
    } else {
      line.textContent = '还没有配置模型。';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-btn primary';
      btn.textContent = '打开设置';
      btn.addEventListener('click', () => this.onOpenSettings?.());
      wrap.append(line, btn);
    }
    this.thread.replaceChildren(wrap);
    this.emptyEl = wrap;
  }

  private scheduleRender(): void {
    if (this.raf) return;
    this.raf = window.requestAnimationFrame(() => {
      this.raf = 0;
      this.flushRender();
    });
  }

  private flushRender(): void {
    if (this.raf) {
      window.cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (!this.assistantEl) return;
    // 双保险：即使流式过滤器在极端分片下漏了协议标签，也不会渲染到界面上
    this.assistantEl.innerHTML = renderMarkdown(stripProtocolTags(this.assistantRaw));
    this.maybeScrollToEnd();
  }

  /**
   * 记录「当前展开的卡片」。
   *
   * 卡片展开时，如果后面还有大段流式文本进来，自动贴底滚动会把这张卡片
   * 顶出视口、只剩一条标题线。所以只要有一张卡片展开着，就不再自动滚动；
   * 用户把它收起来（或改展开另一张）后恢复跟随。
   */
  private setOpenCard(card: HTMLElement | null): void {
    this.openCard = card;
    if (card) this.keepCardVisible(card);
  }

  /** 收起指定卡片（如果它就是当前展开的那张）。 */
  private clearOpenCard(card: HTMLElement): void {
    if (this.openCard === card) this.openCard = null;
  }

  /**
   * 让折叠面板只有一个展开：新卡片出现时收起上一张。
   *
   * 展开的卡片是「用户正在看的东西」，同一时刻只该有一张——否则两张卡都
   * 展开、又都在长高，谁也看不清。
   */
  private collapseOpenCard(): void {
    const prev = this.openCard;
    this.openCard = null;
    if (!prev) return;
    const head = prev.querySelector<HTMLButtonElement>('.ai-step-head');
    const body = prev.querySelector<HTMLElement>('.ai-step-body');
    if (head && body && !body.hidden) {
      body.hidden = true;
      head.setAttribute('aria-expanded', 'false');
    }
  }

  /**
   * 把展开的卡片放进可视区域。
   *
   * 不够高的时候把卡片顶部对齐到视口顶部（留 6px 余量）；够高就只保证
   * 标题行可见——用户至少能看见它叫什么、状态是什么，而不是只剩一条缝。
   */
  private keepCardVisible(card: HTMLElement): void {
    window.requestAnimationFrame(() => {
      const head = card.querySelector<HTMLElement>('.ai-step-head');
      const box = (head ?? card).getBoundingClientRect();
      const view = this.thread.getBoundingClientRect();
      const topGap = box.top - view.top;
      if (topGap < 0) {
        this.thread.scrollTop += topGap - 6;
        this.stick = false;
      }
      // 卡片整体比视口还高：标题行贴顶就行，别把标题滚出去
      const cardBox = card.getBoundingClientRect();
      if (cardBox.bottom > view.bottom && cardBox.top >= view.top) {
        this.thread.scrollTop += cardBox.bottom - view.bottom + 6;
        this.stick = this.thread.scrollTop + this.thread.clientHeight >= this.thread.scrollHeight - 8;
      }
      this.updateJump();
    });
  }

  /**
   * 新内容到达后是否要贴底。
   *
   * 两个条件：用户本来就在底部（stick），且没有展开的卡片。
   */
  private maybeScrollToEnd(): void {
    if (this.openCard || !this.stick) {
      this.updateJump();
      return;
    }
    this.scrollToEnd();
  }

  /** 「跳到最新」只在没跟随、且离底部有明显距离时出现。 */
  private updateJump(): void {
    const el = this.thread;
    const away = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.jumpEl.hidden = away < 40;
  }

  private scrollToEnd(): void {
    this.thread.scrollTop = this.thread.scrollHeight;
    this.stick = true;
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
