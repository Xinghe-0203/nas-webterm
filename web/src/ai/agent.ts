/**
 * AI Agent 的前端驱动。
 *
 * 只负责「发请求、解析 SSE、把事件交给面板」；界面全部在 ai-panel.ts。
 * 与 1.0.x 的终端内渲染相比，最大的变化是 **AI 的文字不再写进 xterm**：
 * 终端只留给 shell 命令与命令输出，AI 的说明、命令卡片、执行结果都在右侧面板里，
 * 两者在视觉上彻底分开，不会再叠在一起。
 */

import { AiPanel, type Answer, type PendingCommand, type StepView } from './panel';
import { ToolFilter } from './tool-filter';
import { getConversation, type Conversation } from './history';

export interface AgentHooks {
  /** 网关前缀，末尾带斜杠 */
  base: string;
  /** 当前会话 id */
  getSid: () => string;
  /** 右侧面板 */
  panel: AiPanel;
  /** 状态变化（顶栏按钮呼吸 / 面板头部状态） */
  onState?: (state: 'idle' | 'running') => void;
  /** 任务结束后回调（用于在终端里补一个干净的空行） */
  onFinished?: () => void;
}

const MAX_HISTORY = 12;
/** 当前会话 id 记在这里：刷新页面后自动恢复上一次聊到一半的对话。 */
const CONV_KEY = 'nas-webterm.aiConversation';

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

function readStoredConversation(): string {
  try {
    return localStorage.getItem(CONV_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeConversation(id: string): void {
  try {
    if (id) localStorage.setItem(CONV_KEY, id);
    else localStorage.removeItem(CONV_KEY);
  } catch {
    /* 隐私模式下不可用 */
  }
}

export class AgentRunner {
  private hooks: AgentHooks;
  private turns: ChatTurn[] = [];
  /** 服务端聊天记录的会话 id（空 = 还没开始聊 / 新对话） */
  private convId = readStoredConversation();
  private busy = false;
  private abort: AbortController | null = null;
  private runId = '';
  /** 本轮累积的原始回复（含工具标签，只用于历史，不显示） */
  private acc = '';
  private filter = new ToolFilter();
  /** 按 step 记录卡片，用于把 observed 事件对回正确的卡片 */
  private steps = new Map<number, StepView>();

  constructor(hooks: AgentHooks) {
    this.hooks = hooks;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  /** 当前正在聊的会话 id（聊天记录列表用它高亮）。 */
  get conversationId(): string {
    return this.convId;
  }

  /** 清空对话历史（面板清空由调用方负责），并开始一段新对话。 */
  reset(): void {
    this.turns = [];
    this.steps.clear();
    this.convId = '';
    storeConversation('');
  }

  /** 忘掉当前会话但不清面板（删除记录时用）。 */
  forgetConversation(): void {
    this.turns = [];
    this.steps.clear();
    this.convId = '';
    storeConversation('');
  }

  /** 从历史里打开一段对话：回显到面板，并接着它继续聊。 */
  openConversation(conv: Conversation): void {
    this.turns = [];
    for (const turn of conv.turns) {
      if (turn.user) this.turns.push({ role: 'user', content: turn.user });
      if (turn.assistant) this.turns.push({ role: 'assistant', content: turn.assistant });
    }
    this.steps.clear();
    this.convId = conv.id;
    storeConversation(conv.id);
    this.hooks.panel.renderConversation(conv);
  }

  /**
   * 页面加载时恢复上一次的会话。
   *
   * 只负责把面板画出来；之后发消息时服务端会用存好的历史做上下文，
   * 所以模型也「记得」之前聊过什么。
   */
  async restoreLast(): Promise<void> {
    const id = this.convId;
    if (!id) return;
    const conv = await getConversation(this.hooks.base, id);
    if (conv === undefined) {
      // 网络抖动 / 服务暂时不可用：保留 id，下次打开页面再试，
      // 不要因为一次请求失败就把用户正在聊的会话忘掉。
      return;
    }
    if (conv === null) {
      // 记录被删了 / 服务端换了数据：静默当作新对话
      this.convId = '';
      storeConversation('');
      return;
    }
    this.openConversation(conv);
  }

  /** 打断正在进行的任务。 */
  stop(): void {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    if (this.runId) {
      void this.decide(this.runId, 'stop');
      this.runId = '';
    }
    if (this.busy) {
      this.busy = false;
      for (const view of this.steps.values()) view.markStopped();
      this.steps.clear();
      this.hooks.panel.finish();
      this.hooks.panel.addNotice('已停止。');
      this.hooks.onState?.('idle');
    }
  }

  /** 执行一次自然语言任务。返回时任务已经结束（成功、失败或被中断）。 */
  async run(text: string): Promise<void> {
    if (this.busy) {
      this.hooks.panel.addNotice('上一条任务还在进行，先停止它再发新的请求。', 'error');
      return;
    }
    const sid = this.hooks.getSid();
    if (!sid) {
      this.hooks.panel.addNotice('当前标签页没有活动会话，无法执行。', 'error');
      return;
    }

    this.busy = true;
    this.acc = '';
    this.filter = new ToolFilter();
    this.steps.clear();
    this.runId = '';
    this.hooks.onState?.('running');
    this.abort = new AbortController();
    // 本次请求由服务端单独拼进 messages；历史里只带之前的轮次，
    // 否则同一句话会出现两次（一次裸文本、一次带终端上下文），模型容易重复执行。
    const history = this.turns.slice(-MAX_HISTORY);
    this.turns.push({ role: 'user', content: text });

    const { panel } = this.hooks;
    panel.addUser(text);
    panel.startAssistant();
    panel.setStatus('thinking');

    try {
      await this.stream_(sid, text, history, this.abort.signal);
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        panel.finish('error');
        panel.addNotice(`AI 请求失败：${err.message}`, 'error');
      }
    } finally {
      this.busy = false;
      this.abort = null;
      this.runId = '';
      this.acc = '';
      panel.finish();
      this.hooks.onState?.('idle');
      this.hooks.onFinished?.();
    }
  }

  private async stream_(
    sid: string,
    text: string,
    history: ChatTurn[],
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`${this.hooks.base}api/ai/agent`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sid,
        text,
        messages: history,
        // 服务端据此把这一轮追加到同一条聊天记录里；空 = 新会话
        conversationId: this.convId,
      }),
      signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`);
    }
    this.runId = res.headers.get('x-run-id') ?? '';
    // 新会话由服务端分配 id，记下来供下一轮和「聊天记录」使用
    const conv = res.headers.get('x-conversation-id') ?? '';
    if (conv) {
      this.convId = conv;
      storeConversation(conv);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          await this.handleEvent(ev);
        }
        idx = buf.indexOf('\n\n');
      }
    }
  }

  private async handleEvent(ev: Record<string, unknown>): Promise<void> {
    const type = String(ev.type ?? '');
    const { panel } = this.hooks;

    if (type === 'md') {
      const delta = String(ev.text ?? '');
      if (!delta) return;
      this.acc += delta;
      // 工具标签（<execute_command>…</execute_command>）是协议，不显示给用户
      const safe = this.filter.push(delta);
      if (safe) {
        panel.startAssistant();
        panel.appendMarkdown(safe);
      }
      return;
    }

    if (type === 'command') {
      const cmd: PendingCommand = {
        command: String(ev.command ?? ''),
        purpose: String(ev.purpose ?? ''),
        danger: Boolean(ev.danger),
        reason: String(ev.reason ?? ''),
        needsApproval: Boolean(ev.needsApproval ?? !ev.auto),
      };
      // auto = 服务端判定「不涉及删除/改写文件」，会直接写进 PTY，不需要用户点确认
      const auto = Boolean(ev.auto);
      const step = Number(ev.step ?? 0);
      if (ev.runId) this.runId = String(ev.runId);

      // 命令卡片之前的说明文字先收尾
      const tail = this.filter.finish();
      if (tail) {
        panel.startAssistant();
        panel.appendMarkdown(tail);
      }
      this.filter = new ToolFilter();
      panel.endAssistant();

      const { view, answer } = panel.addCommand(cmd, step, auto);
      this.steps.set(step, view);

      const decided: Answer = await answer;
      if (auto) {
        // 服务端已经直接放行，不需要回传决定
        view.markRunning();
        return;
      }
      if (decided.decision === 'stop') {
        view.markStopped();
        void this.decide(this.runId, 'stop');
        this.abort?.abort();
        return;
      }
      if (decided.decision === 'skip') {
        view.markSkipped();
      } else {
        view.markRunning();
      }
      await this.decide(this.runId, decided.decision, decided.command);
      return;
    }

    if (type === 'exec') {
      // PTY 自己会回显命令，终端里不重复打印；面板卡片标题已经显示命令。
      const step = Number(ev.step ?? 0);
      this.steps.get(step)?.markRunning();
      return;
    }

    if (type === 'observed') {
      const step = Number(ev.step ?? 0);
      const output = String(ev.output ?? '');
      const timedOut = Boolean(ev.timedOut);
      const exitCode = typeof ev.exitCode === 'number' ? ev.exitCode : null;
      this.steps.get(step)?.setOutput(output, timedOut, exitCode);
      if (timedOut) panel.addNotice('命令执行超时，只读到了部分输出。');
      else if (exitCode !== null && exitCode !== 0) {
        panel.addNotice(`上一条命令退出码 ${exitCode}，模型会据此调整下一步。`);
      }
      panel.setStatus('thinking');
      return;
    }

    if (type === 'error') {
      panel.endAssistant();
      panel.addNotice(String(ev.error ?? '未知错误'), 'error');
      return;
    }

    if (type === 'done') {
      const raw = typeof ev.text === 'string' && ev.text ? ev.text : this.acc;
      const tail = this.filter.finish();
      if (tail) {
        panel.startAssistant();
        panel.appendMarkdown(tail);
      }
      panel.endAssistant();
      for (const view of this.steps.values()) view.markDone();
      this.turns.push({ role: 'assistant', content: raw });
      return;
    }
  }

  private async decide(runId: string, decision: string, command?: string): Promise<void> {
    if (!runId) return;
    try {
      await fetch(`${this.hooks.base}api/ai/agent/decide`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, decision, command }),
      });
    } catch {
      /* 送不到服务端时会等到审批超时，不算致命 */
    }
  }
}
