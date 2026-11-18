import { TerminalSession, type ConnState } from './terminal';
import { AI_BRIDGE, createAiBridge } from './variant-bridge';
import type { AiBridge } from './ai/bridge';

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

/** 服务端 /api/sessions 返回的会话信息。 */
interface SessionInfo {
  id: string;
  shell: string;
  cwd: string;
  pid: number | null;
  cols: number;
  rows: number;
  clients: number;
  alive: boolean;
  alt_screen: boolean;
  /** 会话已运行的秒数（服务端 elapsed，不是 Unix 时间戳）。 */
  created: number;
}

const STORAGE_KEY = 'nas-webterm.tabs.v1';
const BLANK_KEY = 'nas-webterm.blank';
const THEME_KEY = 'nas-webterm.theme';
const FONT_KEY = 'nas-webterm.fontSize';
/** 会话列表轮询间隔：保证别的设备新开的会话能自动出现在本窗口的标签栏。 */
const SESSION_SYNC_MS = 2500;
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
  /** 会话列表轮询定时器。 */
  private syncTimer: number | null = null;
  /** 正在同步会话列表，避免定时器重入。 */
  private syncing = false;
  /** 正在关闭的会话 id：避免 DELETE 还没返回时轮询又把标签页加回来。 */
  private closingSids = new Set<string>();
  /** 当前服务端会话快照，状态栏显示 cwd / 连接数用。 */
  private sessionMeta = new Map<string, SessionInfo>();

  /**
   * AI 桥接。普通版是空实现（bridge-null.ts），AI 版是真实现。
   * 终端主体只认这个接口，不认识任何 AI 细节。
   */
  private ai: AiBridge = AI_BRIDGE;
  /** 状态栏临时提示的定时器 */
  private noticeTimer: number | null = null;

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
    void this.initAi();
  }

    // ------------------------------------------------------------------ AI

  /**
   * 初始化 AI 桥接。
   *
   * 普通版这里是空实现（bridge-null.ts）：没有面板、不读配置、不拦输入。
   * AI 版才是真实现（bridge-ai.ts）。
   */
  private async initAi(): Promise<void> {
    // AI 版：这里拿到真实现（面板 DOM 由 bridge 自己去页面里找）；
    // 普通版：createAiBridge 是空实现，什么都不发生。
    this.ai = createAiBridge({
      base: this.base,
      getSid: () => this.tabs[this.activeIndex]?.session.sid ?? '',
      sendRaw: (text: string) => this.writeActiveInput(text),
      onBlocked: (message: string) => {
        this.writeSystem(this.activeIndex, `\r\n\x1b[33m${message}\x1b[0m\r\n`);
      },
      onState: () => undefined,
    });
    await this.ai.init();
    // AI 版默认展开面板（终端里已经不再拦截自然语言，面板是唯一入口）；
    // 普通版的 bridge 是空实现，这里什么也不会发生。
    this.ai.setVisible(this.ai.enabled, false);
    this.updateClipboardNotice();
  }

  /**
   * 粘贴调用次数：供自动化测试断言「一次按键只粘贴一次」。
   */
  pasteCallCount = 0;

  /** 打开 AI 设置窗（供自动化验证使用）。 */
  openAiSettings(): void {
    this.ai.openSettings();
  }

  /** 关闭 AI 设置窗（供自动化验证使用）。 */
  closeAiSettings(): void {
    this.ai.closeSettings();
  }

  /** 往当前活动标签页的 PTY 直接写输入（AI 执行命令时用）。 */
  private writeActiveInput(text: string): void {
    const tab = this.tabs[this.activeIndex];
    tab?.session.writeInput(text);
  }

  /**
   * 剪贴板可用性提示。
   *
   * 浏览器只在**安全上下文**（HTTPS / localhost）下提供 navigator.clipboard。
   * fnOS 默认用 http://<IP>:5666 访问，此时 navigator.clipboard 整个不存在，
   * Ctrl+Shift+V 读不到内容（Chrome 也禁止 execCommand('paste')）。
   * 这时给出明确提示，并指出 Ctrl+V（浏览器原生粘贴）任何环境下都能用。
   */
  private updateClipboardNotice(): void {
    const note = document.querySelector('[data-clipboard-note]');
    if (!note) return;
    const usable = !!(navigator.clipboard && navigator.clipboard.readText);
    (note as HTMLElement).hidden = usable;
    const hint = document.getElementById('clipboard-hint');
    if (!usable && hint) {
      hint.textContent = 'HTTP 访问下请用 Ctrl+V 粘贴（Ctrl+Shift+V 需要 HTTPS）';
      hint.hidden = false;
    }
  }

  // ------------------------------------------------------------------ 布局

  // ------------------------------------------------------------------ 启动

  /**
   * 启动流程：把服务端所有存活会话都恢复成标签页。
   *
   * 不要拿 localStorage 里的旧 sid 直接重连：服务端的 WS 处理在找不到
   * 该 sid 时会把它当新建会话，每刷新一次就多一个孤儿 PTY。这里先拿
   * `/api/sessions` 的权威列表，只恢复仍然存在的 sid；列表中多出来的
   * 会话（其他设备/其他用户开的）也会全部补成标签页。
   */
  private async bootstrap(): Promise<void> {
    await this.loadServerConfig();
    const live = await this.loadServerSessions();
    if (!live) {
      // 网关/接口暂时不可用：保持空白并交给轮询重试，绝不先新建一个
      // 默认会话——否则接口恢复后会和已有会话一起变成多余标签。
      this.sessionMeta = new Map();
      this.showEmpty(true);
      this.updateStatusBar();
      this.startSessionSync();
      return;
    }
    this.sessionMeta = live;

    // 1) 先按本浏览器上次的标签顺序恢复「服务端还活着」的会话。
    //    已经不存在的 sid 直接丢弃：绝不能拿旧 sid 去新建会话，
    //    否则刷新一次就多一个没人认领的孤儿 PTY。
    const restored = this.restore();
    const seen = new Set<string>();
    for (const t of restored) {
      if (!t.sid || !live.has(t.sid) || seen.has(t.sid)) continue;
      this.createTab(t.cmd, t.sid, t.title);
      seen.add(t.sid);
    }

    // 2) 服务端所有存活会话都必须出现在标签栏里——不管它是哪个设备、
    //    哪个用户、哪个浏览器开的。这样旧窗口不会“隐身”在后台吃内存，
    //    用户可以像普通标签页一样直接关掉它。
    const sessions = Array.from(live.values()).sort((a, b) => a.created - b.created);
    for (const s of sessions) {
      if (seen.has(s.id)) continue;
      this.createTab(null, s.id, this.sessionTitle(s));
      seen.add(s.id);
    }

    // 3) 首次使用（没有任何会话、也没主动关光过）才自动开一个 shell。
    //    用户把最后一个标签页关掉后，刷新页面应该保持空白，而不是又偷偷
    //    建一个会话——这正是后台残留越积越多的来源。
    if (this.tabs.length === 0 && !this.readBlankFlag()) {
      this.createTab(this.defaultCommand());
    }

    if (this.tabs.length > 0) {
      const wanted = this.tabFromHash();
      const idx = wanted >= 0 ? wanted : 0;
      this.activate(Math.min(idx, this.tabs.length - 1));
      window.setTimeout(() => this.tabs[this.activeIndex]?.session.focus(), 60);
    } else {
      this.showEmpty(true);
      this.updateStatusBar();
    }

    // 4) 持续发现新会话：别的设备新开一个窗口，这里最多 2.5 秒后
    //    就会出现对应标签页；会话被关掉，标签页也会自动消失。
    this.startSessionSync();
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

  /** 读取服务端当前所有会话。失败时返回空数组（调用方按“本轮不动”处理）。 */
  private async fetchSessions(): Promise<SessionInfo[]> {
    const res = await fetch(`${this.base}api/sessions`, {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json?.ok) throw new Error(String(json?.error ?? '读取会话失败'));
    return Array.isArray(json.data) ? (json.data as SessionInfo[]) : [];
  }

  /** 只取存活会话：会话 id → 会话信息；接口失败返回 null（不要当成“没有会话”）。 */
  private async loadServerSessions(): Promise<Map<string, SessionInfo> | null> {
    const map = new Map<string, SessionInfo>();
    try {
      const list = await this.fetchSessions();
      for (const s of list) {
        if (s?.alive === false || !s?.id) continue;
        map.set(s.id, s);
      }
    } catch {
      return null;
    }
    return map;
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
      const list = await this.fetchSessions();
      if (list.length < this.maxSessions) return false;
      const busy = list.filter((s) => Number(s?.clients ?? 0) > 0).length;
      return busy >= this.maxSessions;
    } catch {
      return false;
    }
  }

  /** 会话标签的显示名：当前目录名 + 会话 id 短号，方便区分不同窗口。 */
  private sessionTitle(s: SessionInfo): string {
    const trimmed = (s.cwd || '').replace(/\/+$/, '');
    const base = trimmed && trimmed !== '/' ? trimmed.split('/').pop() : 'root';
    const short = s.id.length > 18 ? `${s.id.slice(0, 15)}…` : s.id;
    return `${base || '会话'} · ${short}`;
  }

  private readBlankFlag(): boolean {
    try {
      return localStorage.getItem(BLANK_KEY) === '1';
    } catch {
      return false;
    }
  }

  private setBlankFlag(blank: boolean): void {
    try {
      if (blank) localStorage.setItem(BLANK_KEY, '1');
      else localStorage.removeItem(BLANK_KEY);
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  /** 没有标签页时显示空白页，而不是偷偷新建一个 shell。 */
  private showEmpty(show: boolean): void {
    const empty = document.getElementById('empty-state');
    if (empty) empty.hidden = !show;
  }

  /**
   * 定时同步服务端会话列表。
   *
   * 这是“所有窗口都能被看到”的核心：
   *   - 服务端多出来的会话（别的设备、别的用户、刷新后遗留的）→ 自动加标签；
   *   - 服务端没有的会话 → 自动移除标签，避免显示已死会话；
   *   - 关闭标签页时放进 closingSids，防止 DELETE 尚未完成时又被加回来。
   */
  private startSessionSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setInterval(() => {
      // 页面在后台（切到其它标签、手机锁屏）时不做轮询：
      // 这时用户看不到标签栏，每 2.5 秒一次的 HTTP 请求纯属浪费，
      // NAS 上还活着几十个终端，前台页面越多越明显。
      // 回到前台时由 visibilitychange 立刻补一次，不会漏掉新会话。
      if (document.hidden) return;
      void this.syncSessions();
    }, SESSION_SYNC_MS);
  }

  private async syncSessions(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const list = await this.fetchSessions();
      const live = new Map<string, SessionInfo>();
      for (const s of list) {
        if (s?.alive === false || !s?.id || this.closingSids.has(s.id)) continue;
        live.set(s.id, s);
      }
      this.sessionMeta = live;

      // 服务端已不存在的会话：移除对应标签页（不重复 DELETE）。
      for (let i = this.tabs.length - 1; i >= 0; i -= 1) {
        const sid = this.tabs[i].session.sid;
        if (sid && !live.has(sid) && !this.closingSids.has(sid)) {
          await this.removeTab(i, false);
        }
      }

      // 别的设备新开的会话：自动出现标签页。
      // 新建会话有 1~2 秒的“服务端已建、前端还没收到 S_READY”窗口，
      // 这段时间先不加，避免同一个会话出现两个标签页。
      const before = this.tabs.length;
      for (const s of live.values()) {
        if (s.created < 2) continue;
        if (this.tabs.some((t) => t.session.sid === s.id)) continue;
        this.createTab(null, s.id, this.sessionTitle(s));
      }
      if (before === 0 && this.tabs.length > 0) this.activate(0);

      this.updateStatusBar();
    } catch {
      // 网络抖动/网关重启：本轮保持现状，下一轮再同步，绝不误删标签页。
    } finally {
      this.syncing = false;
    }
  }

  private createTab(
    cmd: string | null,
    sid: string | null = null,
    title?: string,
  ): Tab {
    // 同一个服务端会话只能有一个标签页。
    // 启动恢复、2.5 秒轮询、切回前台补同步可能同时跑到这里（例如 bootstrap
    // 还没结束就触发了 visibilitychange），没有这道闸就会出现两个标签抢同一个
    // PTY、关掉一个另一个变成僵尸标签。
    if (sid) {
      const existing = this.tabs.find((t) => t.session.sid === sid);
      if (existing) return existing;
    }
    const id = ++this.seq;
    const el = document.createElement('div');
    el.className = 'tab';
    const defaultLabel = cmd ?? `终端 ${id}`;
    const label = title ?? defaultLabel;
    el.title = label;

    const iconEl = document.createElement('span');
    iconEl.className = 'tab-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.innerHTML =
      '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M3.2 4.4 6.4 8l-3.2 3.6M8 11.8h4.8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = label;

    const dotEl = document.createElement('span');
    dotEl.className = 'dot';
    dotEl.title = '会话已结束，点击重新启动';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭标签页并结束会话';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeTab(this.tabs.findIndex((t) => t.id === id));
    });

    el.append(iconEl, titleEl, dotEl, closeBtn);
    el.addEventListener('mousedown', (e) => {
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
      // 普通命令原样进 PTY；自然语言交给 AI 面板
      // 终端就是纯终端：输入一律交给 shell，不再做「说中文转给 AI」的拦截。
      // 要用 AI 请在右侧助手面板的输入框里说。
      interceptInput: () => false,
      onShiftEnter: () => false,
      onPasteRequest: () => {
        // 返回 false 表示「这次按键不该被吃掉」——让浏览器的原生粘贴照常发生。
        // 剪贴板 API 只在安全上下文（HTTPS / localhost）下存在，
        // HTTP 访问时返回 false，浏览器自己的粘贴就能用了。
        if (!navigator.clipboard?.readText) return false;
        void this.pasteFromClipboard();
        return true;
      },
      onCopyRequest: () => this.copySelection(),
      onError: (message, code) => {
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
    this.showEmpty(false);
    this.setBlankFlag(false);
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
    await this.removeTab(index, true);
  }

  /**
   * 移除标签页。
   *
   * deleteSession = true：普通关闭/同步清理时调用，DELETE 服务端会话，
   * PTY 子进程会被 socket 关闭 + SIGKILL 链带下去，内存立即释放。
   * deleteSession = false：会话已经不在服务端了（例如服务重启），
   * 只清理本地 DOM/WS，不再发一次无意义的 DELETE。
   */
  private async removeTab(index: number, deleteSession: boolean): Promise<void> {
    if (index < 0 || index >= this.tabs.length) return;
    const tab = this.tabs[index];
    const wasActive = index === this.activeIndex;
    const sid = tab.session.sid;
    if (sid) this.closingSids.add(sid);
    this.tabs.splice(index, 1);
    tab.el.remove();
    tab.panel.remove();
    try {
      await tab.session.close(deleteSession);
    } finally {
      if (sid) {
        // 给 DELETE 请求留一点完成时间，避免 2.5s 后的轮询把会话又加回来。
        window.setTimeout(() => this.closingSids.delete(sid), 5000);
      }
    }
    if (this.tabs.length === 0) {
      this.activeIndex = -1;
      this.showEmpty(true);
      this.setBlankFlag(true);
    } else if (wasActive) {
      this.activate(Math.min(index, this.tabs.length - 1));
    } else {
      if (index < this.activeIndex) this.activeIndex -= 1;
      this.updateStatusBar();
    }
    this.persist();
  }

  private restartTab(index: number): void {
    const tab = this.tabs[index];
    if (!tab) return;
    // 重启会先删旧会话、再建新会话。旧 sid 在 DELETE 完成前也可能被轮询看到，
    // 先放进 closingSids，避免标签栏闪出一个重复标签。
    const oldSid = tab.session.sid;
    if (oldSid) {
      this.closingSids.add(oldSid);
      window.setTimeout(() => this.closingSids.delete(oldSid), 5000);
    }
    tab.dotEl.classList.remove('on');
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
    const tab = this.tabs[this.activeIndex];
    const meta = tab?.session.sid ? this.sessionMeta.get(tab.session.sid) : undefined;
    if (this.statEls.cwd) this.statEls.cwd.textContent = meta?.cwd || this.cwd || '—';
    if (this.statEls.font) this.statEls.font.textContent = `${this.fontSize}px`;

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
        const short = sid.length > 14 ? `${sid.slice(0, 14)}…` : sid;
        const pid = tab.pid ? ` · pid ${tab.pid}` : '';
        const clients = meta && meta.clients > 1 ? ` · ${meta.clients} 个客户端` : '';
        this.statEls.session.textContent = `${short}${pid}${clients}`;
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

    const emptyNew = document.getElementById('empty-new');
    emptyNew?.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.newTab(this.defaultCommand());
    });

    const menuBtn = document.getElementById('newtab-menu') as HTMLButtonElement;
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showMenu(menuBtn);
    });

    const themeBtn = document.getElementById('theme-toggle');
    themeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      this.applyTheme(current === 'light' ? 'dark' : 'light');
    });

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
    helpDialog?.addEventListener('click', (e) => {
      if (e.target === helpDialog && typeof helpDialog.close === 'function') helpDialog.close();
    });

    document.addEventListener('click', () => this.hideMenu());

    document.addEventListener(
      'keydown',
      (e) => {
        // Ctrl+Alt+K：AI 面板开关；Ctrl+Alt+A：AI 设置（普通版没有这两项）
        if (this.ai.enabled && e.ctrlKey && e.altKey) {
          if (e.key === 'k' || e.key === 'K') {
            e.preventDefault();
            this.ai.toggle();
            return;
          }
          if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            this.ai.openSettings();
            return;
          }
        }

        // 焦点在输入框 / 弹窗里时，除了上面两个，不要再抢按键：
        // 在聊天框里按 Ctrl+Shift+W 应该只是输入，不能把标签页关掉。
        const target = e.target as HTMLElement | null;
        // 注意：xterm 用一个隐藏 <textarea> 接收键盘输入，它的 target 也是 TEXTAREA。
        // 不能把它当成普通输入框，否则在终端里按 Ctrl+Shift+T/W/C/V 会被这里直接跳过。
        const inTerminal = !!target?.closest('.xterm');
        const inInput =
          !inTerminal &&
          !!target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            !!target.closest('dialog'));
        if (inInput) return;

        // Windows Terminal 风格：Ctrl+Shift+T / W / C / V
        if (e.ctrlKey && e.shiftKey && !e.altKey) {
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
          // 复制 / 粘贴由终端自己处理（web/src/terminal.ts 的自定义键处理）。
          // 这里再处理一遍会导致一次按键被响应两次 —— 粘贴出来是双份内容。
        }

        // Ctrl+Tab / Ctrl+Shift+Tab：切换标签页
        if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
          e.preventDefault();
          const dir = e.shiftKey ? -1 : 1;
          this.activate((this.activeIndex + dir + this.tabs.length) % this.tabs.length);
          return;
        }

        // Alt+Shift 组合：旧版快捷键保留，避免打断已有习惯
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
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            this.setFontSize(this.fontSize + 1);
          } else if (e.key === '-') {
            e.preventDefault();
            this.setFontSize(this.fontSize - 1);
          } else if (e.key === '0') {
            e.preventDefault();
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
          this.applyTheme(theme, false);
        }
      }
    });

    // 拖拽面板 / 窗口尺寸变化后让 xterm 重新 fit
    window.addEventListener('resize', () => {
      this.tabs[this.activeIndex]?.session.refreshSize();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      // 回到前台：先补一次会话同步（后台期间可能别的设备新建/关闭了会话），
      // 再把每个终端的积压输出刷出去并重新 fit 尺寸。
      void this.syncSessions();
      for (const t of this.tabs) t.session.onVisible();
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

  /** 复制当前终端里选中的文字；没有选中内容时返回 false（让快捷键落回浏览器）。 */
  private copySelection(): boolean {
    const tab = this.tabs[this.activeIndex];
    const text = tab?.session.getSelection() ?? '';
    if (!text) return false;
    void this.copyText(text).then((ok) => {
      if (!ok) {
        const bar = document.getElementById('stat-session');
        if (bar) {
          bar.textContent = '复制失败：浏览器拒绝了剪贴板访问';
          bar.classList.add('stat-warn');
          window.setTimeout(() => {
            bar.textContent = '';
            bar.classList.remove('stat-warn');
          }, 4000);
        }
      }
    });
    return true;
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
    if (this.ai.enabled) {
      this.addMenuItem('AI 助手', this.ai.isVisible() ? '已打开' : 'Ctrl+Alt+K', () => this.ai.toggle());
      this.addMenuItem('AI 设置', 'Ctrl+Alt+A', () => this.ai.openSettings());
    }
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
    this.addMenuItem('关闭标签页（结束会话）', 'Ctrl+Shift+W', () => void this.closeTab(index), true);
    this.placeMenu(e.clientX, e.clientY);
  }

  /**
   * 复制文本到剪贴板。
   *
   * 浏览器只在**安全上下文**（HTTPS / localhost）下提供 navigator.clipboard；
   * 通过 http://192.168.x.x 访问时 navigator.clipboard 整个不存在（fnOS 默认就是 HTTP），
   * 只读 API 写不进去。但 document.execCommand('copy') 在任何环境下都还能用
   * （Chrome 允许复制、只禁粘贴），所以用它兜底。
   */
  private async copyText(text: string): Promise<boolean> {
    if (!text) return false;
    // 1) 标准剪贴板 API（HTTPS / localhost）
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        /* 焦点/权限问题 → 继续降级 */
      }
    }
    // 2) execCommand('copy')：把文本放进临时节点再选中复制
    try {
      const holder = document.createElement('textarea');
      holder.value = text;
      holder.setAttribute('readonly', '');
      holder.style.position = 'fixed';
      holder.style.top = '-1000px';
      holder.style.opacity = '0';
      document.body.appendChild(holder);
      const previous = holder.style.display;
      holder.style.display = '';
      holder.select();
      holder.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      holder.style.display = previous;
      holder.remove();
      if (ok) return true;
    } catch {
      /* 忽略 */
    }
    return false;
  }

  /**
   * 把剪贴板内容粘进终端。
   *
   * 三级降级：
   *   1. navigator.clipboard.readText() —— HTTPS / localhost 才可用；
   *   2. document.execCommand('paste') —— 会触发 xterm 自己的 paste 处理器，
   *      Firefox 与部分 WebView 允许；Chrome 在普通页面里禁掉；
   *   3. 都不行就**明确告诉用户**改用 Ctrl+V（浏览器的原生粘贴，
   *      走 textarea 的 paste 事件，不需要任何权限，HTTP 下照样能用）。
   */
  private async pasteFromClipboard(): Promise<boolean> {
    this.pasteCallCount += 1;
    // 1) 标准剪贴板 API（需要用户手势 + 安全上下文）
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          this.tabs[this.activeIndex]?.session.paste(text);
          return true;
        }
      } catch {
        /* 没有权限/不在安全上下文 → 继续降级 */
      }
    }
    // 2) execCommand('paste')：由浏览器触发真实 paste 事件，xterm 会接管
    try {
      const textarea = this.activeTerminalTextarea();
      textarea?.focus();
      if (document.execCommand('paste')) return true;
    } catch {
      /* 忽略 */
    }
    // 3) 都不行：提示改用 Ctrl+V（浏览器原生粘贴，不需要任何权限）
    this.notifyClipboardUnavailable();
    return false;
  }

  /** 当前终端的隐藏输入框（浏览器原生粘贴靠它接收）。 */
  private activeTerminalTextarea(): HTMLTextAreaElement | null {
    const tab = this.tabs[this.activeIndex];
    return (tab?.session.textarea ?? null) as HTMLTextAreaElement | null;
  }

  /**
   * 剪贴板不可用提示。
   *
   * 用**独立元素**而不是状态栏的会话信息位——后者每秒都在刷新，
   * 提示会被立刻冲掉。
   */
  private notifyClipboardUnavailable(): void {
    const hint = document.getElementById('clipboard-hint');
    if (!hint) return;
    hint.textContent = 'HTTP 访问下请用 Ctrl+V 粘贴（Ctrl+Shift+V 需要 HTTPS）';
    hint.hidden = false;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      hint.hidden = true;
      this.noticeTimer = null;
    }, 8000);
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
      // 不再限制恢复数量：服务端有多少存活会话，标签栏就要显示多少。
      return parsed;
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
      const message = `已达会话上限（${this.maxSessions} 个）。请先关闭不用的标签页再新建。`;
      if (this.activeIndex >= 0) {
        this.writeSystem(this.activeIndex, `\r\n\x1b[33m${message}\x1b[0m\r\n`);
      } else {
        window.alert(message);
      }
      return;
    }
    this.setBlankFlag(false);
    this.showEmpty(false);
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

  /** AI 面板当前是否可见（供自动化验证使用）。 */
  get aiVisible(): boolean {
    return this.ai.isVisible();
  }

  /** 显示 / 收起 AI 面板（供自动化验证与快捷键复用）。 */
  toggleDock(): void {
    this.ai.toggle();
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
