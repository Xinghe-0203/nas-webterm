/**
 * AI 版的 AI 桥接：把面板、agent、设置窗串起来。
 *
 * 只有 AI 版会 import 这个文件，普通版用 bridge-null.ts，
 * 所以这里的代码不会进普通版的 bundle。
 */

import { AiPanel } from './panel';
import { InlineAi } from './inline';
import type { AiPublicConfig } from './config';
import type { AiBridge } from './bridge';
import {
  clearConversations,
  deleteConversation,
  formatTime,
  getConversation,
  listConversations,
  type ConversationSummary,
} from './history';

export interface AiBridgeDeps {
  base: string;
  /** 取当前标签页的服务端会话 id */
  getSid: () => string;
  /** 往当前标签页的 PTY 写输入 */
  sendRaw: (text: string) => void;
  /** 在终端里写一行系统提示 */
  onBlocked: (message: string) => void;
  /** 面板所在容器（可选，缺省由 locate() 找） */
  panelRoot?: HTMLElement;
  /** AI 设置弹窗（可选，缺省由 locate() 找） */
  settingsEl?: HTMLDialogElement | null;
  /** 状态回调：running 时更新状态点 */
  onState: (state: 'idle' | 'running') => void;
}

export class AiBridgeImpl implements AiBridge {
  readonly enabled = true;

  private panel: AiPanel;
  private runner: InlineAi | null = null;
  private cfg: AiPublicConfig | null = null;
  private deps: AiBridgeDeps & {
    panelRoot: HTMLElement;
    settingsEl: HTMLDialogElement | null;
    historyEl: HTMLDialogElement | null;
  };

  constructor(deps: AiBridgeDeps) {
    const located = AiBridgeImpl.locate();
    this.deps = {
      ...deps,
      panelRoot: deps.panelRoot ?? located.panelRoot,
      settingsEl: deps.settingsEl ?? located.settingsEl ?? null,
      historyEl: located.historyEl ?? null,
    };
    this.panel = new AiPanel(this.deps.panelRoot as HTMLElement);
  }

  /** AI 版的 DOM 都在这里找，普通版的 app.ts 不需要知道它们的 id。 */
  static locate(): {
    panelRoot: HTMLElement;
    settingsEl: HTMLDialogElement | null;
    historyEl: HTMLDialogElement | null;
  } {
    return {
      panelRoot: document.getElementById('ai-dock') as HTMLElement,
      settingsEl: document.getElementById('ai-settings-dialog') as HTMLDialogElement | null,
      historyEl: document.getElementById('ai-history-dialog') as HTMLDialogElement | null,
    };
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  async init(): Promise<void> {
    const { base, getSid, sendRaw, onBlocked, panelRoot, settingsEl, onState } = this.deps;

    this.panel.bindHeader(
      () => this.reset(),
      () => this.openSettings(),
      () => this.setVisible(false),
    );
    this.panel.bindHistory(() => this.openHistory());
    this.panel.bindComposer(
      (text) => this.submitText(text),
      () => this.runner?.stop(),
    );

    // InlineAi 负责「面板 → agent → 往终端里执行命令」这条链路，
    // 但不参与终端输入判定：终端里敲什么都原样交给 shell。
    this.runner = new InlineAi({
      base,
      getSid,
      sendRaw,
      isReady: () => Boolean(this.cfg?.enabled && this.cfg?.hasKey),
      openSettings: () => this.openSettings(),
      onBlocked,
      ensureVisible: () => this.setVisible(true),
      onState,
      panel: this.panel,
    });

    this.bindSettingsUi(settingsEl);
    this.bindHistoryUi();
    await this.refreshConfig();
    // 上次关页面时正在聊的会话，重新打开后接着显示（不必再问一遍）。
    void this.runner?.restoreLast();
    void panelRoot;
  }

  /** 拉一次 AI 配置（面板状态与是否可用都依赖它）。 */
  private async refreshConfig(): Promise<void> {
    try {
      const res = await fetch(`${this.deps.base}api/ai/config`, { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.ok) this.cfg = json.data as AiPublicConfig;
    } catch {
      /* 拉不到就当未配置 */
    }
    this.panel.setModel(this.cfg?.model ?? '');
    this.panel.setReady(Boolean(this.cfg?.enabled && this.cfg?.hasKey));
    this.deps.onState('idle');
  }

  setVisible(visible: boolean, remember = true): void {
    this.panel.setVisible(visible);
    if (remember) {
      try {
        localStorage.setItem('nas-webterm.dock', visible ? '1' : '0');
      } catch {
        /* 隐私模式下不可用 */
      }
    }
    if (visible) this.panel.focusInput();
  }

  toggle(): void {
    this.setVisible(!this.panel.visible);
  }

  submitText(text: string): void {
    if (!this.cfg?.enabled || !this.cfg?.hasKey) {
      this.setVisible(true);
      this.openSettings();
      return;
    }
    this.setVisible(true);
    this.runner?.submitText(text);
  }

  stop(): void {
    this.runner?.stop();
  }

  reset(): void {
    this.runner?.stop();
    this.runner?.reset();
    this.panel.reset();
    this.panel.addNotice('已开始新的对话。');
  }

  /** 打开「聊天记录」：列出服务端保存的所有会话。 */
  openHistory(): void {
    const el = this.deps.historyEl;
    if (!el) return;
    this.bindHistoryUi();
    void this.renderHistoryList();
    if (typeof el.showModal === 'function') {
      el.showModal();
    } else {
      el.setAttribute('open', '');
    }
  }

  private bindHistoryUi(): void {
    const el = this.deps.historyEl;
    if (!el || el.dataset.bound === '1') return;
    el.dataset.bound = '1';
    document.getElementById('ai-history-close')?.addEventListener('click', () => {
      this.closeHistory();
    });
    const clearBtn = document.getElementById(
      'ai-history-clear',
    ) as HTMLButtonElement | null;
    clearBtn?.addEventListener('click', () => {
      // 清空不可恢复：第一次点只是「上膛」，4 秒内再点一次才真的清。
      if (clearBtn.dataset.armed !== '1') {
        clearBtn.dataset.armed = '1';
        clearBtn.textContent = '再点一次确认清空';
        window.setTimeout(() => {
          if (clearBtn.dataset.armed === '1') {
            clearBtn.dataset.armed = '';
            clearBtn.textContent = '清空全部记录';
          }
        }, 4000);
        return;
      }
      clearBtn.dataset.armed = '';
      clearBtn.textContent = '清空全部记录';
      void this.clearHistory();
    });
    el.addEventListener('click', (e) => {
      // 点遮罩关闭
      if (e.target === el) this.closeHistory();
    });
  }

  private closeHistory(): void {
    const el = this.deps.historyEl;
    if (!el) return;
    if (typeof el.close === 'function') el.close();
    else el.removeAttribute('open');
  }

  /** 渲染会话列表。 */
  private async renderHistoryList(): Promise<void> {
    const listEl = document.getElementById('ai-history-list');
    const statusEl = document.getElementById('ai-history-status');
    if (!listEl) return;
    if (statusEl) {
      statusEl.textContent = '加载中…';
      statusEl.className = 'ai-cfg-status';
    }
    const items = await listConversations(this.deps.base);
    listEl.replaceChildren();
    if (statusEl) {
      statusEl.textContent = items.length ? '' : '还没有聊天记录。';
      statusEl.className = 'ai-cfg-status';
    }
    for (const item of items) {
      listEl.append(this.renderHistoryRow(item));
    }
  }

  private renderHistoryRow(item: ConversationSummary): HTMLElement {
    const row = document.createElement('div');
    row.className = 'ai-history-item';
    row.setAttribute('role', 'listitem');
    // 当前正在聊的那条高亮
    if (this.runner?.conversationId === item.id) row.dataset.active = '1';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ai-history-open';
    open.title = '打开这段对话继续聊';

    const title = document.createElement('span');
    title.className = 'ai-history-title';
    title.textContent = item.title || '（未命名对话）';

    const meta = document.createElement('span');
    meta.className = 'ai-history-meta';
    meta.textContent = `${formatTime(item.updatedAt)} · ${item.turns} 轮`;

    const preview = document.createElement('span');
    preview.className = 'ai-history-preview';
    preview.textContent = item.preview;

    open.append(title, meta, preview);
    open.addEventListener('click', () => {
      void this.openConversation(item.id);
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ai-history-delete';
    del.title = '删除这条记录';
    del.setAttribute('aria-label', '删除');
    del.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      del.disabled = true;
      const ok = await deleteConversation(this.deps.base, item.id);
      if (ok) {
        if (this.runner?.conversationId === item.id) {
          // 删掉的是当前正在聊的 → 面板一起清掉，避免继续往一条不存在的记录里写
          this.runner.forgetConversation();
          this.panel.reset();
          this.panel.addNotice('这条聊天记录已删除。');
        }
        void this.renderHistoryList();
      } else {
        del.disabled = false;
      }
    });

    row.append(open, del);
    return row;
  }

  /** 打开某条历史会话：回显到面板，并把会话 id 设为当前会话。 */
  private async openConversation(id: string): Promise<void> {
    const conv = await getConversation(this.deps.base, id);
    if (!conv) {
      const statusEl = document.getElementById('ai-history-status');
      if (statusEl) {
        statusEl.textContent =
          conv === null ? '这条记录已经不存在了。' : '加载失败，请稍后再试。';
        statusEl.className = 'ai-cfg-status err';
      }
      if (conv === null) void this.renderHistoryList();
      return;
    }
    this.runner?.stop();
    this.runner?.openConversation(conv);
    this.setVisible(true);
    this.panel.focusInput();
    this.closeHistory();
  }

  /** 清空全部聊天记录。 */
  private async clearHistory(): Promise<void> {
    const statusEl = document.getElementById('ai-history-status');
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'ai-cfg-status';
    }
    const ok = await clearConversations(this.deps.base);
    if (!ok) {
      if (statusEl) {
        statusEl.textContent = '清空失败，请稍后再试。';
        statusEl.className = 'ai-cfg-status err';
      }
      return;
    }
    this.runner?.forgetConversation();
    this.panel.reset();
    this.panel.addNotice('聊天记录已清空。');
    void this.renderHistoryList();
  }

  openSettings(): void {
    const el = this.deps.settingsEl;
    if (!el) return;
    this.bindWindowHint();
    if (typeof el.showModal === 'function') {
      el.showModal();
    } else {
      el.setAttribute('open', '');
    }
    // 先把最新配置拉回来，再回填表单。
    // 只 refresh 不回填的话，用户看到的永远是空表单。
    void (async () => {
      await this.refreshConfig();
      await this.fillAiSettings();
    })();
  }

  isVisible(): boolean {
    return this.panel.visible;
  }

  writeActiveInput(text: string): void {
    this.deps.sendRaw(text);
  }

  /** 设置弹窗的绑定（保存 / 关闭 / 点遮罩关闭）。 */
  private bindSettingsUi(el: HTMLDialogElement | null): void {
    if (!el) return;
    const form = document.getElementById('ai-settings-form') as HTMLFormElement | null;
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.saveSettingsUi();
    });
    document.getElementById('ai-cfg-clear-key')?.addEventListener('click', () => {
      void this.clearAiKeyUi();
    });
    document.getElementById('ai-cfg-close')?.addEventListener('click', () => {
      this.closeSettingsUi();
    });
    el.addEventListener('click', (e) => {
      if (e.target === el) this.closeSettingsUi();
    });
  }

  /**
   * 「模型上下文」输入框改动时，本地先按同样公式预览一遍预算，
   * 不用等保存来回跑一趟（保存后仍以服务端返回的 derived 为准）。
   */
  private bindWindowHint(): void {
    const input = document.getElementById('ai-cfg-window') as HTMLInputElement | null;
    if (!input || input.dataset.bound === '1') return;
    input.dataset.bound = '1';
    const preview = (): void => {
      const w = Number(input.value) || 1000000;
      const chars = (pct: number): number => Math.round(((w * pct) / 100) * 3);
      const d = {
        contextChars: Math.min(Math.max(chars(60), 8000), 1_500_000),
        observeChars: Math.min(Math.max(chars(10), 4000), 120_000),
        memoryMaxChars: Math.min(Math.max(chars(8), 4000), 60_000),
        historyTurns: Math.min(Math.max(Math.round(chars(12) / 2000), 4), 40),
        maxSteps: w >= 800000 ? 64 : w >= 400000 ? 56 : w >= 200000 ? 48 : w >= 100000 ? 36 : w >= 32000 ? 24 : 16,
      };
      this.renderDerived({ ...(this.cfg as AiPublicConfig), derived: d });
    };
    input.addEventListener('input', preview);
  }

  /** 关闭设置窗（供自动化验证使用）。 */
  closeSettings(): void {
    this.closeSettingsUi();
  }

  private closeSettingsUi(): void {
    const el = this.deps.settingsEl;
    if (!el) return;
    if (typeof el.close === 'function') el.close();
    else el.removeAttribute('open');
  }

  /**
   * 保存设置。
   *
   * 字段 id 必须和 index.html 里的表单一一对应：
   * 接口地址是 `ai-cfg-base`（不是 `ai-cfg-url`）——写错的话会传空串，
   * 服务端整包拒绝，用户看到的就是「模型保存不了」。
   */
  private async saveSettingsUi(): Promise<void> {
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const status = $('ai-cfg-status');
    const patch: Record<string, unknown> = {
      enabled: ($('ai-cfg-enabled') as HTMLInputElement).checked,
      baseUrl: ($('ai-cfg-base') as HTMLInputElement).value.trim(),
      model: ($('ai-cfg-model') as HTMLInputElement).value.trim(),
      temperature: Number(($('ai-cfg-temp') as HTMLInputElement).value),
      reasoningEffort: ($('ai-cfg-effort') as HTMLSelectElement).value,
      maxTokens: Number(($('ai-cfg-tokens') as HTMLInputElement).value),
      includeContext: ($('ai-cfg-context') as HTMLInputElement).checked,
      stream: ($('ai-cfg-stream') as HTMLInputElement).checked,
      contextWindow: Number(($('ai-cfg-window') as HTMLInputElement).value),
      memoryEnabled: ($('ai-cfg-memory') as HTMLInputElement).checked,
    };
    const key = ($('ai-cfg-key') as HTMLInputElement).value.trim();
    if (key) patch.apiKey = key;

    const btn = $('ai-cfg-save') as HTMLButtonElement;
    btn.disabled = true;
    status.textContent = '保存中…';
    status.className = 'ai-cfg-status';
    try {
      const res = await fetch(`${this.deps.base}api/ai/config`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json().catch(() => null);
      if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);

      // 长期记忆是独立的一份文件，走单独的接口
      const mem = ($('ai-cfg-memory-text') as HTMLTextAreaElement | null)?.value ?? '';
      try {
        await fetch(`${this.deps.base}api/ai/memory`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: mem }),
        });
      } catch {
        /* 记忆保存失败不影响其它配置 */
      }
      status.textContent = '已保存';
      status.className = 'ai-cfg-status ok';
      await this.refreshConfig();
      await this.fillAiSettings();
      window.setTimeout(() => {
        status.textContent = '';
        this.closeSettingsUi();
      }, 500);
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = 'ai-cfg-status err';
    } finally {
      btn.disabled = false;
    }
  }

  /** 填表（打开设置窗时调用）。 */
  private async fillAiSettings(): Promise<void> {
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const cfg = this.cfg;
    if (!cfg) {
      $('ai-cfg-status').textContent = '无法读取配置';
      $('ai-cfg-status').className = 'ai-cfg-status err';
      return;
    }
    ($('ai-cfg-enabled') as HTMLInputElement).checked = cfg.enabled;
    ($('ai-cfg-base') as HTMLInputElement).value = cfg.baseUrl;
    ($('ai-cfg-key') as HTMLInputElement).value = '';
    ($('ai-cfg-key') as HTMLInputElement).placeholder = cfg.hasKey
      ? `已配置（${cfg.keyMask}），留空不修改`
      : 'sk-…';
    ($('ai-cfg-model') as HTMLInputElement).value = cfg.model;
    ($('ai-cfg-temp') as HTMLInputElement).value = String(cfg.temperature);
    ($('ai-cfg-effort') as HTMLSelectElement).value = cfg.reasoningEffort ?? '';
    ($('ai-cfg-tokens') as HTMLInputElement).value = String(cfg.maxTokens);
    ($('ai-cfg-context') as HTMLInputElement).checked = cfg.includeContext;
    ($('ai-cfg-stream') as HTMLInputElement).checked = cfg.stream;
    ($('ai-cfg-window') as HTMLInputElement).value = String(cfg.contextWindow ?? 1000000);
    ($('ai-cfg-memory') as HTMLInputElement).checked = cfg.memoryEnabled ?? true;
    this.renderDerived(cfg);
    void this.loadMemoryText();
    const hint = $('ai-cfg-key-hint');
    hint.textContent = cfg.hasKey
      ? `当前 Key：${cfg.keyMask}（保存在服务端）`
      : '保存在服务端，不会回传到浏览器';
    const status = $('ai-cfg-status');
    status.textContent = '';
    status.className = 'ai-cfg-status';
  }

  /**
   * 渲染「按模型上下文自动分配」的只读预算。
   *
   * 这些数字以前是一堆可编辑输入框（终端上下文长度、步数上限、记忆容量…），
   * 用户很容易配出「窗口 200k、上下文 6k」这种畸形组合。现在只在后端
   * 按 contextWindow 的比例算一次，前端原样展示。
   */
  private renderDerived(cfg: AiPublicConfig | null): void {
    const el = document.getElementById('ai-cfg-derived');
    if (!el || !cfg) return;
    const d = cfg.derived;
    // 中文习惯：上万用「万」，几千用「k」，避免出现「1500k 字符」这种别扭写法
    const fmt = (n: number): string => {
      if (n >= 100_000) return `${(n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1)} 万`;
      if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
      return String(n);
    };
    if (!d) {
      el.textContent = '按模型上下文自动分配：终端上下文 60%、长期记忆 8%、对话 12%、单条命令输出 10%。';
      return;
    }
    el.innerHTML =
      '<span class="ai-derived-title">按模型上下文自动分配（只读）</span>' +
      `<span>终端上下文 <b>${fmt(d.contextChars)}</b> 字符</span>` +
      `<span>单条命令输出 <b>${fmt(d.observeChars)}</b> 字符</span>` +
      `<span>长期记忆 <b>${fmt(d.memoryMaxChars)}</b> 字符</span>` +
      `<span>对话历史 <b>${d.historyTurns}</b> 轮</span>` +
      `<span>单次任务 <b>${d.maxSteps}</b> 步</span>`;
  }

  /** 读取长期记忆内容，填进文本框。 */
  private async loadMemoryText(): Promise<void> {
    const el = document.getElementById('ai-cfg-memory-text') as HTMLTextAreaElement | null;
    if (!el) return;
    try {
      const res = await fetch(`${this.deps.base}api/ai/memory`, { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.ok) el.value = String(json.data?.text ?? '');
    } catch {
      /* 拉不到就保持原样 */
    }
  }

  /** 清除 API Key。 */
  private async clearAiKeyUi(): Promise<void> {
    const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    const status = $('ai-cfg-status');
    try {
      const res = await fetch(`${this.deps.base}api/ai/config`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: '-' }),
      });
      const json = await res.json().catch(() => null);
      if (!json?.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
      status.textContent = 'Key 已清除';
      status.className = 'ai-cfg-status ok';
      await this.refreshConfig();
      await this.fillAiSettings();
    } catch (e) {
      status.textContent = (e as Error).message;
      status.className = 'ai-cfg-status err';
    }
  }
}

/**
 * 创建 AI 版桥接。
 *
 * AI 版的 DOM（面板容器、设置弹窗）由本模块自己定位，
 * app.ts 里不会出现任何 AI 相关的 id 字符串。
 */
export function createAiBridge(
  deps: Omit<AiBridgeDeps, 'panelRoot' | 'settingsEl'>,
): AiBridge {
  const located = AiBridgeImpl.locate();
  return new AiBridgeImpl({ ...deps, ...located });
}

/** AI 版默认桥接（构造前用）。 */
export const AI_BRIDGE: AiBridge = {
  enabled: true,
  visible: false,
  async init() {},
  setVisible() {},
  toggle() {},
  submitText() {},
  stop() {},
  reset() {},
  openSettings() {},
  closeSettings() {},
  isVisible: () => false,
  writeActiveInput() {},
};
