import { TerminalSession, type ConnState } from './terminal';

interface Tab {
  id: number;
  session: TerminalSession;
  el: HTMLElement;
  panel: HTMLElement;
  titleEl: HTMLElement;
  dotEl: HTMLElement;
  title: string;
  cmd: string | null;
}

interface PersistedTab {
  sid: string | null;
  cmd: string | null;
  title: string;
}

const STORAGE_KEY = 'nas-webterm.tabs.v1';
const MAX_RESTORE = 8;
const FONT_MIN = 9;
const FONT_MAX = 28;

export interface AppOptions {
  base: string;
  fontSize?: number;
  startupCommand?: string;
}

export class App {
  private base: string;
  private fontSize: number;
  private startupCommand: string;
  private tabs: Tab[] = [];
  private activeIndex = -1;
  private seq = 0;
  private persistTimer: number | null = null;
  private maxSessions = 0;

  private tabstrip = document.getElementById('tabstrip') as HTMLElement;
  private panes = document.getElementById('panes') as HTMLElement;
  private connEl = document.getElementById('conn') as HTMLElement;
  private menuEl = document.getElementById('menu') as HTMLElement;

  constructor(opts: AppOptions) {
    this.base = opts.base;
    this.fontSize = opts.fontSize ?? 14;
    this.startupCommand = opts.startupCommand ?? '';
  }

  start(): void {
    this.bindGlobalEvents();
    // 暴露给自动化验证脚本（页面本身仅管理员可见）
    (window as unknown as { __webterm__?: App }).__webterm__ = this;
    void this.loadServerConfig();
    const restored = this.restore();
    if (restored.length === 0) {
      this.createTab(this.defaultCommand());
    } else {
      for (const t of restored) this.createTab(t.cmd, t.sid, t.title);
    }
    const wanted = this.tabFromHash();
    const idx = wanted >= 0 ? wanted : 0;
    this.activate(Math.min(idx, this.tabs.length - 1));
    window.setTimeout(() => this.tabs[this.activeIndex]?.session.focus(), 60);
  }

  // ------------------------------------------------------------------ 标签页

  /** 读取服务端配置（会话上限等），用于新建前的预检。 */
  private async loadServerConfig(): Promise<void> {
    try {
      const res = await fetch(`${this.base}api/config`, { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.ok) this.maxSessions = Number(json.data?.maxSessions ?? 0);
    } catch {
      /* 拿不到就不做上限预检 */
    }
  }

  /** 新建标签页前检查会话数是否已达上限，避免服务端拒绝后前端一直重连。 */
  private async atSessionLimit(): Promise<boolean> {
    if (!this.maxSessions) return false;
    try {
      const res = await fetch(`${this.base}api/sessions`, { credentials: 'same-origin' });
      const json = await res.json();
      const count = Array.isArray(json?.data) ? json.data.length : 0;
      return count >= this.maxSessions;
    } catch {
      return false;
    }
  }

  private createTab(cmd: string | null, sid: string | null = null, title?: string): Tab {
    const id = ++this.seq;
    const el = document.createElement('div');
    el.className = 'tab';
    const defaultLabel = cmd ?? `终端 ${id}`;
    el.title = defaultLabel;

    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = title ?? defaultLabel;

    const dotEl = document.createElement('span');
    dotEl.className = 'dot';
    dotEl.title = '会话已结束，点击重新启动';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭标签页';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(this.tabs.findIndex((t) => t.id === id));
    });

    el.append(titleEl, dotEl, closeBtn);
    el.addEventListener('mousedown', (e) => {
      // 中键关闭，浏览器标签页的经典操作
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(this.tabs.findIndex((t) => t.id === id));
      }
    });
    el.addEventListener('click', () => this.activate(this.tabs.findIndex((t) => t.id === id)));
    dotEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.restartTab(this.tabs.findIndex((t) => t.id === id));
    });

    const panel = document.createElement('div');
    panel.className = 'pane';
    this.panes.appendChild(panel);

    const session = new TerminalSession({
      base: this.base,
      sid,
      cmd,
      fontSize: this.fontSize,
      onReady: (info) => {
        if (!title && titleEl.textContent === defaultLabel) {
          // shell 会通过 OSC 设置标题；拿不到时退回到「终端 N」
          this.setTitle(id, cmd ?? defaultLabel);
        }
        void info;
        this.persist();
      },
      onTitle: (t) => this.setTitle(id, t),
      onExit: (info) => {
        this.dotElOf(id)?.classList.add('on');
        const idx = this.tabs.findIndex((t) => t.id === id);
        if (idx >= 0) {
          this.writeSystem(idx, `\r\n\x1b[90m[会话已结束，退出码 ${info.code}]\x1b[0m\r\n`);
        }
      },
      onState: (state) => this.onStateChange(id, state),
    });

    const tab: Tab = { id, session, el, panel, titleEl, dotEl, title: titleEl.textContent ?? '终端', cmd };
    this.tabs.push(tab);
    this.tabstrip.appendChild(el);
    session.connect();
    this.persist();
    return tab;
  }

  private activate(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    this.activeIndex = index;
    this.tabs.forEach((t, i) => {
      const on = i === index;
      t.el.classList.toggle('active', on);
      t.panel.classList.toggle('active', on);
    });
    const active = this.tabs[index];
    if (active) {
      active.session.mount(active.panel);
      active.session.refreshSize();
      active.session.focus();
      this.updateHash(active);
      this.updateConnIndicator(active.session.connState);
    }
  }

  private async closeTab(index: number): Promise<void> {
    if (index < 0 || index >= this.tabs.length) return;
    const tab = this.tabs[index];
    this.tabs.splice(index, 1);
    tab.el.remove();
    tab.panel.remove();
    await tab.session.close();
    if (this.tabs.length === 0) {
      this.createTab(this.defaultCommand());
    }
    if (index >= this.tabs.length) index = this.tabs.length - 1;
    this.activeIndex = -1;
    this.activate(index);
    this.persist();
  }

  private restartTab(index: number): void {
    const tab = this.tabs[index];
    if (!tab) return;
    tab.dotEl.classList.remove('on');
    void tab.session.restart();
    this.activate(index);
  }

  private setTitle(id: number, title: string): void {    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.title = title;
    tab.titleEl.textContent = title;
    tab.el.title = title;
    this.persist();
  }

  private dotElOf(id: number): HTMLElement | undefined {
    return this.tabs.find((t) => t.id === id)?.dotEl;
  }

  /** 向指定下标的标签页终端写一行系统提示（不经过 PTY）。 */
  private writeSystem(index: number, text: string): void {
    const tab = this.tabs[index];
    tab?.session.writeSystemLine(text);
  }

  private onStateChange(id: number, state: ConnState): void {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.id === this.tabs[this.activeIndex]?.id) this.updateConnIndicator(state);
  }

  private updateConnIndicator(state: ConnState): void {
    this.connEl.classList.remove('online', 'connecting');
    const led = document.createElement('span');
    led.className = 'led';
    let text = '未连接';
    if (state === 'online') {
      this.connEl.classList.add('online');
      text = '已连接';
    } else if (state === 'connecting') {
      this.connEl.classList.add('connecting');
      text = '连接中';
    }
    this.connEl.replaceChildren(led, document.createTextNode(text));
  }

  // ------------------------------------------------------------------ 快捷键

  private bindGlobalEvents(): void {
    const newBtn = document.getElementById('newtab') as HTMLButtonElement;
    newBtn.addEventListener('click', () => {
      void this.newTab(this.defaultCommand());
    });

    const menuBtn = document.getElementById('newtab-menu') as HTMLButtonElement;
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showMenu(menuBtn);
    });

    document.addEventListener('click', () => this.hideMenu());

    document.addEventListener(
      'keydown',
      (e) => {
        // Alt+Shift 组合：浏览器不会占用，shell 里也少用
        if (e.altKey && e.shiftKey) {
          const key = e.key.toLowerCase();
          if (key === 't') {
            e.preventDefault();
            void this.newTab(this.defaultCommand());
            return;
          }
          if (key === 'w') {
            e.preventDefault();
            void this.closeTab(this.activeIndex);
            return;
          }
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            this.activate((this.activeIndex + 1) % this.tabs.length);
            return;
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            this.activate((this.activeIndex - 1 + this.tabs.length) % this.tabs.length);
            return;
          }
          if (/^[1-9]$/.test(e.key)) {
            e.preventDefault();
            const idx = Number(e.key) - 1;
            if (idx < this.tabs.length) this.activate(idx);
            return;
          }
        }
        // 字号调整
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            this.setFontSize(this.fontSize + 1);
          } else if (e.key === '-') {
            e.preventDefault();
            this.setFontSize(this.fontSize - 1);
          } else if (e.key === '0') {
            e.preventDefault();
            this.setFontSize(14);
          }
        }
      },
      true,
    );

    // 飞牛桌面切换深浅色
    window.addEventListener('message', (event) => {
      const data = event?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'theme' || data.type === 'themeChange') {
        const theme = data.theme ?? data.value;
        if (theme === 'light' || theme === 'dark') {
          document.documentElement.dataset.theme = theme;
          for (const t of this.tabs) t.session.setTheme(theme);
        }
      }
    });

    window.addEventListener('beforeunload', () => {
      // 关闭页面不结束 PTY，服务端会保留会话，刷新后可续上
    });
  }

  private setFontSize(size: number): void {
    this.fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    for (const t of this.tabs) t.session.setFontSize(this.fontSize);
  }

  private showMenu(anchor: HTMLElement): void {
    this.menuEl.replaceChildren();
    const items: Array<[string, string, () => void]> = [
      [
        '默认命令',
        this.startupCommand || '普通 Shell',
        () => {
          void this.newTab(this.defaultCommand());
        },
      ],
      [
        '空白 Shell',
        '',
        () => {
          void this.newTab(null);
        },
      ],
    ];
    for (const [label, hint, action] of items) {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (hint) {
        const small = document.createElement('small');
        small.textContent = hint;
        btn.appendChild(small);
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideMenu();
        action();
      });
      this.menuEl.appendChild(btn);
    }
    const rect = anchor.getBoundingClientRect();
    this.menuEl.hidden = false;
    this.menuEl.style.left = `${Math.max(4, rect.left)}px`;
    this.menuEl.style.top = `${rect.bottom + 4}px`;
  }

  private hideMenu(): void {
    this.menuEl.hidden = true;
  }

  // ------------------------------------------------------------------ 持久化

  private defaultCommand(): string | null {
    const cmd = this.startupCommand.trim();
    return cmd.length > 0 ? cmd : null;
  }

  private persist(): void {
    if (this.persistTimer !== null) window.clearTimeout(this.persistTimer);
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      const data: PersistedTab[] = this.tabs.map((t) => ({
        sid: t.session.sid,
        cmd: t.cmd,
        title: t.title,
      }));
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      } catch {
        /* 隐私模式下可能不可用 */
      }
    }, 400);
  }

  private restore(): PersistedTab[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as PersistedTab[];
      if (!Array.isArray(parsed)) return [];
      return parsed.slice(-MAX_RESTORE);
    } catch {
      return [];
    }
  }

  /** 当前活动标签页终端的可见文本（供自动化验证使用）。 */
  activeBufferText(): string {
    const tab = this.tabs[this.activeIndex];
    return tab ? tab.session.bufferText() : '';
  }

  /** 聚焦当前活动终端。 */
  focusActive(): void {
    this.tabs[this.activeIndex]?.session.focus();
  }

  /** 新建一个标签页（带上限预检）。 */
  async newTab(cmd: string | null): Promise<void> {
    if (await this.atSessionLimit()) {
      this.writeSystem(
        this.activeIndex,
        `\r\n\x1b[33m已达会话上限（${this.maxSessions} 个）。请先关闭不用的标签页再新建。\x1b[0m\r\n`,
      );
      return;
    }
    this.createTab(cmd);
    this.activate(this.tabs.length - 1);
  }

  /** 标签页数量。 */
  get tabCount(): number {
    return this.tabs.length;
  }

  /** 当前活动标签页的服务端会话 id（供自动化验证使用）。 */
  get activeSid(): string {
    const tab = this.tabs[this.activeIndex];
    return tab?.session.sid ?? '';
  }

  private updateHash(tab: Tab): void {
    const sid = tab.session.sid;
    if (!sid) return;
    const next = `#${sid}`;
    if (location.hash !== next) {
      history.replaceState(null, '', next);
    }
  }

  private tabFromHash(): number {
    const sid = location.hash.replace(/^#/, '');
    if (!sid) return -1;
    return this.tabs.findIndex((t) => t.session.sid === sid);
  }
}
