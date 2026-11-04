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
  /** 服务端 PTY 的进程号（状态栏显示用） */
  pid: number | null;
}

interface PersistedTab {
  sid: string | null;
  cmd: string | null;
  title: string;
}

const STORAGE_KEY = 'nas-webterm.tabs.v1';
const THEME_KEY = 'nas-webterm.theme';
const FONT_KEY = 'nas-webterm.fontSize';
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
  /** 初始字号：Ctrl+0 复位到这里（而不是写死的 14） */
  private initialFontSize: number;
  private startupCommand: string;
  private tabs: Tab[] = [];
  private activeIndex = -1;
  private seq = 0;
  private persistTimer: number | null = null;
  private maxSessions = 0;
  private shell = '';
  private cwd = '';

  private tabstrip = document.getElementById('tabstrip') as HTMLElement;
  private panes = document.getElementById('panes') as HTMLElement;
  private connEl = document.getElementById('conn') as HTMLElement;
  private menuEl = document.getElementById('menu') as HTMLElement;
  private statEls = {
    shell: document.getElementById('stat-shell'),
    cwd: document.getElementById('stat-cwd'),
    size: document.getElementById('stat-size'),
    font: document.getElementById('stat-font'),
    session: document.getElementById('stat-session'),
  };

  constructor(opts: AppOptions) {
    this.base = opts.base;
    this.fontSize = this.readSavedFontSize(opts.fontSize ?? 14);
    this.initialFontSize = opts.fontSize ?? 14;
    this.startupCommand = opts.startupCommand ?? '';
  }

  start(): void {
    // 先把主题应用到 <html>，避免终端/标签栏出现一帧旧配色
    this.applyTheme(this.readSavedTheme(), false);
    this.bindGlobalEvents();
    // 暴露给自动化验证脚本（页面本身仅管理员可见）
    (window as unknown as { __webterm__?: App }).__webterm__ = this;
    void this.bootstrap();
  }

  /**
   * 启动流程：先拿到服务端的会话上限和现存会话，再恢复标签页。
   *
   * 顺序很重要：恢复标签页时如果带着一个**已经不存在的 sid**，
   * 服务端的 WS 处理会当成「新建会话」，于是每恢复一个标签页就多占一个
   * 会话名额；恢复 8 个标签页就能把 max_sessions 撑爆，新标签页全部失败。
   */
  private async bootstrap(): Promise<void> {
    await this.loadServerConfig();
    const live = await this.loadServerSessions();

    const restored = this.restore();
    // 只有「还挂着客户端」的会话才真正占着名额：没有客户端的残留会被服务端回收。
    let busy = 0;
    for (const clients of live.values()) if (clients > 0) busy += 1;
    let skipped = 0;

    for (const t of restored) {
      if (t.sid && live.has(t.sid)) {
        // 会话还在：直接接回去（复用已有会话，不占新名额）
        this.createTab(t.cmd, t.sid, t.title);
        continue;
      }
      // 会话已经没了：要重新开一个，但先看还有没有名额
      if (this.maxSessions && busy >= this.maxSessions) {
        skipped += 1;
        continue;
      }
      this.createTab(t.cmd, null, t.title);
      busy += 1;
    }

    if (this.tabs.length === 0) {
      this.createTab(this.defaultCommand());
    }
    const wanted = this.tabFromHash();
    const idx = wanted >= 0 ? wanted : 0;
    this.activate(Math.min(idx, this.tabs.length - 1));

    // 提示要等标签页激活之后再写：
    // 上面 activate() 之前 activeIndex 还是 -1，写过去等于写进了虚空。
    if (skipped > 0) {
      this.writeSystem(
        this.activeIndex,
        `\r\n\x1b[33m有 ${skipped} 个标签页因会话数已达上限（${this.maxSessions} 个）未能恢复。\x1b[0m\r\n`,
      );
    }
    window.setTimeout(() => this.tabs[this.activeIndex]?.session.focus(), 60);
  }

  // ------------------------------------------------------------------ 标签页

  /** 读取服务端配置（会话上限等），用于新建前的预检。 */
  private async loadServerConfig(): Promise<void> {
    try {
      const res = await fetch(`${this.base}api/config`, { credentials: 'same-origin' });
      const json = await res.json();
      if (json?.ok) {
        this.maxSessions = Number(json.data?.maxSessions ?? 0);
        this.shell = String(json.data?.shell ?? '');
        this.cwd = String(json.data?.cwd ?? '');
        this.updateStatusBar();
      }
    } catch {
      /* 拿不到就不做上限预检 */
    }
  }

  /** 读取服务端现存的会话：会话 id → 当前客户端数。 */
  private async loadServerSessions(): Promise<Map<string, number>> {
    try {
      const res = await fetch(`${this.base}api/sessions`, { credentials: 'same-origin' });
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : [];
      const map = new Map<string, number>();
      for (const s of list as Array<{ id?: string; alive?: boolean; clients?: number }>) {
        if (s?.alive === false) continue;
        if (!s?.id) continue;
        map.set(s.id, Number(s.clients ?? 0));
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * 新建标签页前检查会话数是否已达上限，避免服务端拒绝后前端一直重连。
   *
   * 注意别只数总数：服务端现在会优先回收「没有任何客户端连接」的残留会话
   * （页面刷新、浏览器被关、重启标签页没删旧会话都会留下这种），
   * 只有所有会话都还挂着客户端时，新会话才会真的被拒绝。
   */
  private async atSessionLimit(): Promise<boolean> {
    if (!this.maxSessions) return false;
    try {
      const res = await fetch(`${this.base}api/sessions`, { credentials: 'same-origin' });
      const json = await res.json();
      const list: Array<{ clients?: number }> = Array.isArray(json?.data) ? json.data : [];
      if (list.length < this.maxSessions) return false;
      const busy = list.filter((s) => Number(s?.clients ?? 0) > 0).length;
      return busy >= this.maxSessions;
    } catch {
      return false;
    }
  }

  private createTab(cmd: string | null, sid: string | null = null, title?: string): Tab {
    const id = ++this.seq;
    const el = document.createElement('div');
    el.className = 'tab';
    const defaultLabel = cmd ?? `终端 ${id}`;
    // 标签页标题：恢复已有会话时用服务端保存的标题，新建时用命令或「终端 N」
    const label = title ?? defaultLabel;
    el.title = label;

    const iconEl = document.createElement('span');
    iconEl.className = 'tab-icon';
    iconEl.textContent = '>_';
    iconEl.setAttribute('aria-hidden', 'true');

    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = label;

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

    el.append(iconEl, titleEl, dotEl, closeBtn);
    el.addEventListener('mousedown', (e) => {
      // 中键关闭，浏览器标签页的经典操作
      if (e.button === 1) {
        e.preventDefault();
        this.closeTab(this.tabs.findIndex((t) => t.id === id));
      }
    });
    el.addEventListener('click', () => this.activate(this.tabs.findIndex((t) => t.id === id)));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.showTabMenu(e, this.tabs.findIndex((t) => t.id === id));
    });
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
        const cur = this.tabs.find((t) => t.id === id);
        if (cur) cur.pid = info.pid ?? null;
        this.updateStatusBar();
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
      onSize: () => {
        if (this.tabs[this.activeIndex]?.id === id) this.updateStatusBar();
      },
      onError: (message, code) => {
        // 服务端明确拒绝（例如会话数已达上限）：把原因显示出来，
        // 并点亮状态点提示这个标签页当前不可用。
        this.dotElOf(id)?.classList.add('on');
        const idx = this.tabs.findIndex((t) => t.id === id);
        if (idx >= 0) {
          this.writeSystem(
            idx,
            `\r\n\x1b[31m${message}\x1b[0m\r\n` +
              (code === 'session_limit'
                ? '\x1b[90m可关闭不用的标签页后重试，或点击标签页上的圆点重启。\x1b[0m\r\n'
                : ''),
          );
        }
      },
    });

    const tab: Tab = {
      id,
      session,
      el,
      panel,
      titleEl,
      dotEl,
      title: titleEl.textContent ?? '终端',
      cmd,
      pid: null,
    };
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
      this.updateStatusBar();
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
    // 旧会话已经没了，pid 也要清掉：否则状态栏会一直显示上一个进程的 pid，
    // 新会话就绪后（onReady）再写回真实的 pid。
    tab.pid = null;
    this.updateStatusBar();
    void tab.session.restart();
    this.activate(index);
  }

  private setTitle(id: number, title: string): void {
    const tab = this.tabs.find((t) => t.id === id);
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
    this.connEl.classList.remove('online', 'connecting', 'offline');
    let text = '未连接';
    if (state === 'online') {
      this.connEl.classList.add('online');
      text = '已连接';
    } else if (state === 'connecting') {
      this.connEl.classList.add('connecting');
      text = '连接中';
    } else {
      this.connEl.classList.add('offline');
    }
    const label = this.connEl.querySelector('.conn-text');
    if (label) label.textContent = text;
  }

  /** 刷新底部状态栏：shell / cwd / 会话 id / 尺寸 / 字号。 */
  private updateStatusBar(): void {
    if (this.statEls.shell) this.statEls.shell.textContent = this.shell || '—';
    if (this.statEls.cwd) this.statEls.cwd.textContent = this.cwd || '—';
    if (this.statEls.font) this.statEls.font.textContent = `${this.fontSize}px`;

    const tab = this.tabs[this.activeIndex];
    const size = tab?.session.size;
    if (this.statEls.size) {
      this.statEls.size.textContent =
        size && size.cols > 0 && size.rows > 0 ? `${size.cols}×${size.rows}` : '—';
    }
    if (this.statEls.session) {
      const sid = tab?.session.sid ?? '';
      if (!tab) {
        this.statEls.session.textContent = '';
      } else if (!sid) {
        this.statEls.session.textContent = '未建立会话';
      } else {
        // 会话 id 很长（128 位随机），状态栏只显示前 12 个字符
        const short = sid.length > 14 ? `${sid.slice(0, 14)}…` : sid;
        const pid = tab.pid ? ` · pid ${tab.pid}` : '';
        this.statEls.session.textContent = `${short}${pid}`;
      }
    }
  }

  // ------------------------------------------------------------------ 主题

  private readSavedTheme(): 'dark' | 'light' {
    try {
      const v = localStorage.getItem(THEME_KEY);
      if (v === 'light' || v === 'dark') return v;
    } catch {
      /* 隐私模式下 localStorage 不可用 */
    }
    return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }

  private readSavedFontSize(fallback: number): number {
    try {
      const v = Number(localStorage.getItem(FONT_KEY));
      if (Number.isFinite(v) && v >= FONT_MIN && v <= FONT_MAX) return v;
    } catch {
      /* 忽略 */
    }
    return fallback;
  }

  private applyTheme(theme: 'dark' | 'light', save = true): void {
    document.documentElement.dataset.theme = theme;
    for (const t of this.tabs) t.session.setTheme(theme);
    if (save) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch {
        /* 忽略 */
      }
    }
  }

  private openHelp(): void {
    this.hideMenu();
    const dlg = document.getElementById('help-dialog') as HTMLDialogElement | null;
    if (!dlg) return;
    if (typeof dlg.showModal === 'function') {
      if (!dlg.open) dlg.showModal();
    } else {
      dlg.setAttribute('open', '');
    }
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

    // 深浅色切换：覆盖飞牛桌面下发的主题，并记住用户的选择
    const themeBtn = document.getElementById('theme-toggle');
    themeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      this.applyTheme(current === 'light' ? 'dark' : 'light');
    });

    // 帮助弹窗：顶栏 ? 按钮、状态栏「快捷键」、以及新建菜单里的入口
    const helpBtn = document.getElementById('help');
    helpBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openHelp();
    });
    const statusHelp = document.getElementById('status-help');
    statusHelp?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openHelp();
    });
    const helpDialog = document.getElementById('help-dialog') as HTMLDialogElement | null;
    document.getElementById('help-close')?.addEventListener('click', () => {
      if (helpDialog && typeof helpDialog.close === 'function') helpDialog.close();
      else helpDialog?.removeAttribute('open');
    });
    // 点遮罩关闭（dialog 自身区域之外的点击目标是 dialog 元素本身）
    helpDialog?.addEventListener('click', (e) => {
      if (e.target === helpDialog && typeof helpDialog.close === 'function') helpDialog.close();
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
            // 复位到初始字号，而不是写死的 14
            this.setFontSize(this.initialFontSize);
          }
        }
      },
      true,
    );

    // 飞牛桌面切换深浅色。
    // 只接受同源消息，或来自父窗口/ opener 的消息（fnOS 桌面就是父窗口），
    // 避免被任意第三方页面 postMessage 改掉配色。
    window.addEventListener('message', (event) => {
      const trusted =
        event.origin === location.origin ||
        event.source === window.parent ||
        event.source === window.opener;
      if (!trusted) return;
      const data = event?.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'theme' || data.type === 'themeChange') {
        const theme = data.theme ?? data.value;
        if (theme === 'light' || theme === 'dark') {
          // 桌面主题变化只影响本次显示，不覆盖用户手动选择的偏好
          this.applyTheme(theme, false);
        }
      }
    });

    // 标签页重新可见：把积压的输出刷出来，并同步一次尺寸
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      for (const t of this.tabs) t.session.onVisible();
    });

    window.addEventListener('beforeunload', () => {
      // 关闭页面不结束 PTY，服务端会保留会话，刷新后可续上
    });
  }

  private setFontSize(size: number): void {
    this.fontSize = Math.max(FONT_MIN, Math.min(FONT_MAX, size));
    for (const t of this.tabs) t.session.setFontSize(this.fontSize);
    this.updateStatusBar();
    try {
      localStorage.setItem(FONT_KEY, String(this.fontSize));
    } catch {
      /* 忽略 */
    }
  }

  /** 菜单项：左侧文案，右侧灰色提示（快捷键等）。 */
  private addMenuItem(
    label: string,
    hint: string,
    action: () => void,
    danger = false,
  ): void {
    const btn = document.createElement('button');
    btn.textContent = label;
    if (danger) btn.classList.add('danger');
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

  private addMenuSeparator(): void {
    this.menuEl.appendChild(document.createElement('hr'));
  }

  /** 把菜单摆到视口内的合适位置（右下角会自动往回收，避免出界）。 */
  private placeMenu(x: number, y: number): void {
    this.menuEl.style.maxWidth = `${Math.max(160, window.innerWidth - 16)}px`;
    this.menuEl.hidden = false;
    const rect = this.menuEl.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    this.menuEl.style.left = `${Math.max(8, left)}px`;
    this.menuEl.style.top = `${Math.max(8, top)}px`;
  }

  private showMenu(anchor: HTMLElement): void {
    this.menuEl.replaceChildren();
    this.addMenuItem('默认命令', this.startupCommand || '普通 Shell', () => {
      void this.newTab(this.defaultCommand());
    });
    this.addMenuItem('空白 Shell', '', () => {
      void this.newTab(null);
    });
    this.addMenuSeparator();
    this.addMenuItem('快捷键与帮助', '?', () => this.openHelp());
    const rect = anchor.getBoundingClientRect();
    this.placeMenu(rect.left, rect.bottom + 6);
  }

  /** 标签页右键菜单：重启、复制会话 ID、关闭。 */
  private showTabMenu(e: MouseEvent, index: number): void {
    const tab = this.tabs[index];
    if (!tab) return;
    this.menuEl.replaceChildren();
    this.addMenuItem('重启会话', '重新申请 PTY', () => this.restartTab(index));
    this.addMenuItem('复制会话 ID', tab.session.sid ? '' : '尚未建立', () => {
      const sid = tab.session.sid;
      if (sid) void this.copyText(sid);
    });
    this.addMenuSeparator();
    this.addMenuItem('关闭标签页', 'Alt+Shift+W', () => void this.closeTab(index), true);
    this.placeMenu(e.clientX, e.clientY);
  }

  private async copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 浏览器不给剪贴板权限时静默忽略 */
    }
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
      // 只持久化**已经拿到 sid** 的标签页。
      // 刚建好、还没收到 S_READY 的标签页 sid 是 null：如果这时候刷新页面，
      // 恢复时会新建一个会话，原来那个没人认领、也不会被回收，成了孤儿会话。
      const data: PersistedTab[] = this.tabs
        .filter((t) => !!t.session.sid)
        .map((t) => ({
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
