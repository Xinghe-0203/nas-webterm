import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

/** 帧类型：与服务端 Rust 实现一一对应 */
const C_INPUT = 0x01;
const C_RESIZE = 0x02;
const C_TERM_RESPONSE = 0x05;
const S_OUTPUT = 0x01;
const S_EXIT = 0x02;
const S_READY = 0x03;
const S_ERROR = 0x04;

/**
 * xterm.js 对 OSC 4/10/11/12 与 DA 查询的自动应答。
 *
 * 这些应答是终端模拟器“替用户”生成的，不是键盘输入；必须在 onData
 * 里单独识别出来，走 C_TERM_RESPONSE 控制帧，而不是混进普通输入。
 * 后端会再核对发起查询的前台进程是否还在读，核对不通过就丢弃——
 * 这样程序查询后立即退出时，rgb:... / 1;2c 不会灌进 Shell 输入框。
 */
const TERMINAL_RESPONSE_RE =
  /^(?:\x1b\[(?:[?>]?[0-9;]*c|[0-9]+n|[?>]?[0-9]+;[0-9]+R|[?>]?[0-9]+;[0-9]+\$y|[0-9]+(?:;[0-9]+)+t)|\x1b\](?:4;\d+;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}|10;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}|11;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}|12;rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4})(?:\x07|\x1b\\))+$/;

function isTerminalResponse(data: string): boolean {
  return data.length > 2 && data.charCodeAt(0) === 0x1b && TERMINAL_RESPONSE_RE.test(data);
}

export type ConnState = 'connecting' | 'online' | 'offline';

export interface ReadyInfo {
  sid: string;
  shell: string;
  cwd: string;
  pid: number | null;
  cols: number;
  rows: number;
  version: string;
  appName: string;
  /** 会话处于备用屏幕（全屏 TUI） */
  altScreen?: boolean;
  /** 回放里没有备用屏幕入口，客户端需要自己先切进去 */
  needAltEnter?: boolean;
}

export interface TerminalSessionOpts {
  base: string;
  sid?: string | null;
  cmd?: string | null;
  fontSize?: number;
  onReady?: (info: ReadyInfo) => void;
  onExit?: (info: { code: number; signal: number | null }) => void;
  onTitle?: (title: string) => void;
  onState?: (state: ConnState) => void;
  /** 终端行列数变化（底部状态栏用） */
  onSize?: (cols: number, rows: number) => void;
  /** 服务端明确拒绝（会话数超限等）时回调：提示用户，且不再自动重连 */
  onError?: (message: string, code: string) => void;
  /**
   * 键盘输入拦截器。返回 true 表示这次输入已被上层消费（AI 模式），
   * 不再写进 PTY。普通命令必须原样返回 false，否则终端就没法用了。
   */
  interceptInput?: (data: string) => boolean;
  /**
   * Shift+Enter：强制把当前行当自然语言交给 AI（xterm 默认会把它变成普通回车）。
   * 返回 true 表示已处理。
   */
  onShiftEnter?: () => boolean;
  /** 右键粘贴（Windows Terminal 的默认行为）；返回 true 表示已处理 */
  onPasteRequest?: () => boolean;
  /** Ctrl+Shift+C；返回 true 表示已处理（没有选中内容时返回 false） */
  onCopyRequest?: () => boolean;
}

/** 终端未挂载时的输出缓冲上限（字节） */
const MAX_PENDING_BYTES = 1024 * 1024;

/**
 * 终端配色：Windows Terminal 的 Campbell（深色）/ Campbell 浅色变体。
 *
 * 这是 PowerShell 7 / Windows Terminal 的出厂配色，蓝、青、黄、绿的饱和度
 * 与终端里常见的 ls / systemctl 输出更协调；比之前那套纯灰阶更容易分辨
 * 错误（红）、警告（黄）、目录（蓝）。
 */
const DARK_THEME = {
  background: '#0C0C0C',
  foreground: '#CCCCCC',
  cursor: '#FFFFFF',
  cursorAccent: '#0C0C0C',
  selectionBackground: 'rgba(255,255,255,0.28)',
  black: '#0C0C0C',
  red: '#C50F1F',
  green: '#13A10E',
  yellow: '#C19C00',
  blue: '#0037DA',
  magenta: '#881798',
  cyan: '#3A96DD',
  white: '#CCCCCC',
  brightBlack: '#767676',
  brightRed: '#E74856',
  brightGreen: '#16C60C',
  brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF',
  brightMagenta: '#B4009E',
  brightCyan: '#61D6D6',
  brightWhite: '#F2F2F2',
};

/** 浅色：Campbell 的浅色变体（Windows Terminal 里 "Campbell Powershell" 的思路）。 */
const LIGHT_THEME = {
  background: '#F9F9F9',
  foreground: '#1A1A1A',
  cursor: '#000000',
  cursorAccent: '#F9F9F9',
  selectionBackground: 'rgba(0,0,0,0.22)',
  black: '#1A1A1A',
  red: '#B01818',
  green: '#107C10',
  yellow: '#8A6A00',
  blue: '#0037DA',
  magenta: '#7A1474',
  cyan: '#1E6FAF',
  white: '#767676',
  brightBlack: '#767676',
  brightRed: '#C50F1F',
  brightGreen: '#13A10E',
  brightYellow: '#9C7500',
  brightBlue: '#2554C7',
  brightMagenta: '#881798',
  brightCyan: '#0E7B8B',
  brightWhite: '#4A4A4A',
};

/**
 * 终端字体栈。
 *
 * 第一项是内置的 Nerd Font 子集：普通等宽字体没有 Nerd Font 的私有区码点，
 * 终端里跑 oh-my-posh / starship 这类带图标的提示符时，那些字符会被浏览器
 * 画成彩色方块（tofu）。内置一份子集后这些图标能正常显示。
 *
 * Nerd Font 只覆盖图标区，ASCII 与中文仍由后面的等宽字体渲染。
 */
const FONT_STACK =
  '"NasWebTermNerd","Sarasa Mono SC","Noto Sans Mono CJK SC","Source Han Mono SC",' +
  '"WenQuanYi Micro Hei",Menlo,Monaco,"DejaVu Sans Mono","Microsoft YaHei Mono",' +
  'Consolas,monospace';

/**
 * 一个标签页 = 一个服务端 PTY 会话。
 *
 * 终端实例延迟创建：标签页第一次被激活时才挂载 DOM，
 * 这样隐藏的标签页不占显存，激活后立刻 fit 到正确尺寸。
 */
export class TerminalSession {
  sid: string | null;
  cmd: string | null;
  title = '';

  private opts: TerminalSessionOpts;
  private ws: WebSocket | null = null;
  private term: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private ro: ResizeObserver | null = null;
  private outQueue: Uint8Array[] = [];
  private outQueueBytes = 0;
  /** 服务端说这是全屏 TUI，客户端要先进入备用屏幕再回放 */
  private pendingAltEnter = false;
  private flushPending = false;
  private flushTimer: number | null = null;
  private flushUsesTimeout = false;
  private retry = 0;
  private retryTimer: number | null = null;
  private disposed = false;
  /** 服务端明确拒绝（如会话数超限）：不再自动重连，等用户处理 */
  private fatal = false;
  private state: ConnState = 'offline';
  private lastCols = 0;
  private lastRows = 0;
  /** 当前字号（终端未挂载时也保留，mount 时使用） */
  private fontSizeValue: number;
  private exited = false;

  constructor(opts: TerminalSessionOpts) {
    this.opts = opts;
    this.sid = opts.sid ?? null;
    this.cmd = opts.cmd ?? null;
    this.fontSizeValue = opts.fontSize ?? 14;
  }

  get connState(): ConnState {
    return this.state;
  }

  get isExited(): boolean {
    return this.exited;
  }

  /** 当前终端行列数（尚未挂载时退回最近一次同步值）。 */
  get size(): { cols: number; rows: number } {
    return {
      cols: this.term?.cols ?? this.lastCols,
      rows: this.term?.rows ?? this.lastRows,
    };
  }

  /** 把终端挂到容器里（第一次激活时调用）。 */
  mount(container: HTMLElement): void {
    if (this.term) {
      this.refreshSize();
      return;
    }
    // 重新挂载前先断开旧的观察器，否则会越叠越多
    this.ro?.disconnect();
    this.ro = null;
    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      fontFamily: FONT_STACK,
      fontSize: this.fontSizeValue,
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: 8000,
      convertEol: false,
      drawBoldTextInBrightColors: true,
      smoothScrollDuration: 0,
      minimumContrastRatio: 1,
      theme: document.documentElement.dataset.theme === 'light' ? LIGHT_THEME : DARK_THEME,
    });

    // 中日韩全角字符宽度（wcwidth 11）——中文界面下对齐才正确
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    if (term.unicode) {
      term.unicode.activeVersion = '11';
    }

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(container);
    this.term = term;
    this.fitAddon = fitAddon;

    // WebGL 渲染：全屏 TUI 重绘频繁，DOM 渲染容易掉帧
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* 浏览器不支持 WebGL 时回落到 DOM/Canvas 渲染 */
    }

    // Shift+Enter 在 xterm 里等同于普通回车，没法直接分辨。
    // 这里在 keydown 阶段先截住它：交给上层决定要不要当成「对 AI 说话」。
    // Ctrl+Shift+C / V 同理：Windows Terminal 的复制粘贴快捷键，
    // 但没有选中内容时要让浏览器自己处理（否则用户复制不了页面上的字）。
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const handled = this.opts.onShiftEnter?.() ?? false;
        if (handled) {
          e.preventDefault();
          return false;
        }
      }
      // Ctrl+Shift+C：复制选中内容。终端焦点在这里，所以由这一层统一处理，
      // 文档级的全局快捷键不要再管 C/V，否则一次按键会被处理两遍（粘贴两次）。
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'c' || e.key === 'C')) {
        if (this.opts.onCopyRequest?.()) {
          e.preventDefault();
          return false;
        }
      }
      // Ctrl+Shift+V：Windows Terminal 风格的粘贴，走剪贴板 API。
      //
      // API 不可用（HTTP 访问）时**不要**吃掉这个按键：放它过去，
      // 浏览器的原生粘贴就会照常发生（和单独 Ctrl+V 一样能粘）。
      if (e.ctrlKey && e.shiftKey && !e.altKey && (e.key === 'v' || e.key === 'V')) {
        if (this.opts.onPasteRequest?.()) {
          e.preventDefault();
          return false;
        }
        // 没粘成 → 交给浏览器做原生粘贴（不 preventDefault）
        return false;
      }
      // 单独的 Ctrl+V：交给浏览器做**原生粘贴**。
      //
      // xterm 默认把 Ctrl+V 当成「引号插入」（真实终端就是这样，屏幕上会显示 ^V），
      // 并且会 preventDefault 掉按键的默认动作——连带把浏览器的原生粘贴也挡掉了。
      // 这里返回 false 让 xterm 提前退出、不再 preventDefault，
      // 浏览器的 paste 事件就会照常触发，xterm 自己会把它转成 PTY 输入
      // （bracketed paste 也照常处理）。
      // 好处：这条路径不依赖剪贴板 API，HTTP 访问下也能粘。
      if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'v' || e.key === 'V')) {
        return false;
      }
      return true;
    });

    // 右键 = 粘贴（有选中内容时先复制）
    //
    // 剪贴板 API 不可用时（HTTP 访问）**不能**吃掉右键菜单：
    // 浏览器的原生菜单里有「粘贴」，那是 HTTP 下唯一能粘贴的办法。
    term.element?.addEventListener('contextmenu', (e) => {
      const selection = this.getSelection().trim();
      const canUseApi = !!navigator.clipboard?.writeText;
      if (!canUseApi) {
        // 让浏览器弹出原生菜单（复制 / 粘贴）
        return;
      }
      e.preventDefault();
      if (selection) {
        void navigator.clipboard.writeText(selection).catch(() => undefined);
        this.clearSelection();
        return;
      }
      this.opts.onPasteRequest?.();
    });

    term.onData((data) => {
      // xterm.js 的查询应答（DA / OSC 颜色）走控制帧，不能当键盘输入。
      if (isTerminalResponse(data)) {
        this.sendTerminalResponse(data);
        return;
      }
      if (this.opts.interceptInput?.(data)) return;
      this.sendInput(data);
    });
    term.onBinary((data) => this.sendBinary(data));
    term.onTitleChange((title) => {
      if (title) {
        this.title = title;
        this.opts.onTitle?.(title);
      }
    });
    term.onResize(({ cols, rows }) => this.sendResize(cols, rows));

    this.ro = new ResizeObserver(() => this.refreshSize());
    this.ro.observe(container);

    // 首次布局：容器刚可见，立刻 fit 一次
    requestAnimationFrame(() => this.refreshSize());
    this.enterAltScreen();
    this.flush();
  }

  focus(): void {
    this.term?.focus();
  }

  /** 标签页重新可见时重新计算尺寸并同步给服务端。 */
  refreshSize(): void {
    if (!this.term || !this.fitAddon) return;
    try {
      this.fitAddon.fit();
    } catch {
      return;
    }
    const { cols, rows } = this.term;
    if (cols !== this.lastCols || rows !== this.lastRows) {
      this.lastCols = cols;
      this.lastRows = rows;
      this.sendResize(cols, rows);
      this.opts.onSize?.(cols, rows);
    }
  }

  setFontSize(size: number): void {
    // 记住字号，即使终端还没挂载。
    // 否则「先调字号、后打开标签页」的那个标签页会退回创建时的旧字号。
    this.fontSizeValue = size;
    if (!this.term) return;
    this.term.options.fontSize = size;
    this.refreshSize();
  }

  get fontSize(): number {
    return this.term?.options.fontSize ?? this.opts.fontSize ?? 14;
  }

  setTheme(theme: 'dark' | 'light'): void {
    if (!this.term) return;
    this.term.options.theme = theme === 'light' ? LIGHT_THEME : DARK_THEME;
  }

  /** 建立（或重建）WebSocket 连接。 */
  connect(): void {
    if (this.disposed || this.fatal || this.ws) return;
    this.setState('connecting');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams();
    if (this.sid) params.set('sid', this.sid);
    if (this.cmd) params.set('cmd', this.cmd);
    if (this.lastCols) params.set('cols', String(this.lastCols));
    if (this.lastRows) params.set('rows', String(this.lastRows));

    const url = `${proto}//${location.host}${this.opts.base}api/ws?${params.toString()}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    // 下面每个回调都要确认「我还是当前这条连接」。
    // 否则旧连接的 onclose 迟到触发时会把**新**连接的引用置空：
    // sendFrame 直接 return，键盘输入被静默丢弃，终端看起来就卡死了。
    const isCurrent = (): boolean => this.ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      // 注意：**这里不重置退避计数**。
      // 只有真正收到 S_READY（服务端认了这个会话）才算一次成功的连接。
      // 如果握手成功就归零，遇到「服务端接受后立刻断开」的情况
      // 退避会永远停在 500ms，多个标签页就是每秒两次的握手风暴。
      this.setState('online');
      if (this.lastCols) this.sendResize(this.lastCols, this.lastRows);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (!isCurrent()) return;
      const buf = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : null;
      if (!buf || buf.length === 0) return;
      const kind = buf[0];
      const payload = buf.subarray(1);
      if (kind === S_OUTPUT) {
        this.pushOutput(payload);
      } else if (kind === S_READY) {
        try {
          const info = JSON.parse(new TextDecoder().decode(payload)) as ReadyInfo;
          this.sid = info.sid;
          this.exited = false;
          // 真的连上了（服务端认了这个会话）：退避归零
          this.retry = 0;
          // 重连到全屏 TUI：回放里如果没带「进入备用屏幕」那个起点，
          // 客户端要先切进去，否则 TUI 的重绘会画到主屏上，画面全乱。
          if (info.needAltEnter) {
            this.pendingAltEnter = true;
            this.enterAltScreen();
          }
          this.opts.onReady?.(info);
        } catch {
          /* 忽略坏帧 */
        }
      } else if (kind === S_EXIT) {
        let code = 0;
        let signal: number | null = null;
        try {
          const info = JSON.parse(new TextDecoder().decode(payload));
          code = Number(info.code ?? 0);
          signal = info.signal ?? null;
        } catch {
          /* 忽略 */
        }
        this.exited = true;
        this.opts.onExit?.({ code, signal });
        // 进程已经退出：主动断开。
        // 服务端此时也会释放这个会话的客户端连接，
        // 不主动断开的话，这个死会话会一直占着服务端的名额。
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      } else if (kind === S_ERROR) {
        this.handleServerError(payload);
      }
    };

    ws.onerror = () => {
      if (!isCurrent()) return;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      // 只有当前连接才有资格改动状态：旧连接迟到的 onclose 一律忽略
      if (!isCurrent()) return;
      this.ws = null;
      if (this.disposed || this.fatal) return;
      this.setState('offline');
      if (!this.exited) this.scheduleRetry();
    };
  }

  /**
   * 处理服务端的错误帧。
   *
   * 服务端拒绝（比如会话数已达上限）时，浏览器拿不到 HTTP 状态码，
   * 只能靠这一帧知道原因。收到后**停止重连**：否则会无限指数重试，
   * 终端永远处于 offline，用户也看不到任何原因。
   */
  private handleServerError(payload: Uint8Array): void {
    let code = 'error';
    let message = new TextDecoder().decode(payload);
    try {
      const info = JSON.parse(message) as { code?: string; error?: string };
      code = info.code ?? 'error';
      message = info.error ?? message;
    } catch {
      /* 不是 JSON 就原样显示 */
    }
    this.fatal = true;
    this.setState('offline');
    this.writeSystemLine(`\x1b[31m${message}\x1b[0m\n`);
    this.opts.onError?.(message, code);
  }

  /**
   * 关闭会话。
   *
   * deleteSession = true 时同时 DELETE 服务端会话：服务端会杀掉 PTY 里的
   * shell 及其子进程，内存/进程立即释放。只有会话已经明确不在服务端
   * （例如服务重启后同步清理）才传 false，避免一次无意义的 404 请求。
   */
  async close(deleteSession = true): Promise<void> {
    this.disposed = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    const sid = this.sid;
    this.sid = null;
    if (sid && deleteSession) {
      await this.deleteSession(sid);
    }
    // 完整释放：观察器、终端实例、未写出的输出缓冲
    this.release();
  }

  /**
   * 删除服务端会话（关掉标签页 / 重启时用）。
   *
   * 会话删不掉是有代价的：服务端只在「有空闲回收时间」或者「客户端都断开
   * 且会话已结束」时才会回收它。删不掉就会一直占着 max_sessions 的名额，
   * 几个标签页就能把名额占满，整个应用变成 429。
   * 所以这里失败要重试；404 说明会话本来就不存在，同样算成功。
   */
  private async deleteSession(sid: string): Promise<boolean> {
    const url = `${this.opts.base}api/sessions/${encodeURIComponent(sid)}`;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        if (res.ok || res.status === 404) return true;
      } catch {
        /* 网络抖动，退避后重试 */
      }
      await new Promise((r) => window.setTimeout(r, 300 * (attempt + 1)));
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.release();
  }

  /** 释放本地资源：观察器、终端实例、输出缓冲。 */
  private release(): void {
    this.ro?.disconnect();
    this.ro = null;
    this.term?.dispose();
    this.term = null;
    this.fitAddon = null;
    this.outQueue = [];
    this.outQueueBytes = 0;
    this.pendingAltEnter = false;
    if (this.flushTimer !== null) {
      if (this.flushUsesTimeout) {
        window.clearTimeout(this.flushTimer);
      } else {
        cancelAnimationFrame(this.flushTimer);
      }
      this.flushTimer = null;
      this.flushPending = false;
    }
  }

  /** 重启会话：丢弃旧 PTY，向服务端申请一个新的。 */
  restart(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // 先把引用摘掉再关：旧连接迟到的 onclose 会发现「自己已经不是当前连接」，
    // 于是直接忽略，不会把新连接的状态搅乱。
    const old = this.ws;
    this.ws = null;
    if (old) {
      try {
        old.close();
      } catch {
        /* ignore */
      }
    }
    // 旧会话必须删掉。
    // 只把 sid 置空然后重连的话，旧会话会留在服务端没人认领：
    // 服务端的空闲回收要靠 idle-minutes（默认 0 = 不回收），
    // 点几次「重启」就把 max_sessions 的名额占满，之后谁也建不了会话。
    const oldSid = this.sid;
    this.sid = null;
    if (oldSid) {
      void this.deleteSession(oldSid);
    }
    // 用户主动重启 = 重新给一次机会（之前可能是被服务端拒绝的）
    this.fatal = false;
    this.exited = false;
    this.retry = 0;
    this.release();
    this.connect();
  }

  /** 往终端写一行系统提示（不经过 PTY）。 */
  writeSystemLine(text: string): void {
    this.pushOutput(new TextEncoder().encode(text));
  }

  /** 直接往 PTY 写一段输入（AI 用来清行 / 回填命令）。 */
  writeInput(data: string): void {
    if (data) this.sendInput(data);
  }

  /** 当前选中的文字（右键复制 / Ctrl+Shift+C 用）。 */
  getSelection(): string {
    return this.term?.getSelection() ?? '';
  }

  /** 选中全部（供自动化测试与「全选复制」用）。 */
  selectAll(): void {
    this.term?.selectAll();
  }

  clearSelection(): void {
    this.term?.clearSelection();
  }

  /**
   * 粘贴一段文本。
   *
   * 走 xterm 的 paste 而不是直接写 PTY：xterm 会按 bracketed paste 模式
   * 包裹内容，多行粘贴不会被 shell 逐行当成回车执行。
   */
  paste(text: string): void {
    if (!this.term || !text) return;
    this.term.paste(text);
  }

  /**
   * 进入备用屏幕（全屏 TUI 用的那块屏幕）。
   *
   * 必须在回放内容之前执行：如果 TUI 的重绘字节被灌到主屏上，
   * 光标定位会画到错误的位置，整个界面就是乱的。
   */
  private enterAltScreen(): void {
    if (!this.pendingAltEnter || !this.term) return;
    if (this.term.buffer.active.type === 'alternate') {
      // 已经在备用屏幕里了，不用再切
      this.pendingAltEnter = false;
      return;
    }
    this.pendingAltEnter = false;
    this.term.write('\x1b[?1049h');
  }

  /**
   * xterm 的隐藏输入框。
   *
   * 浏览器的原生粘贴（Ctrl+V）是把内容 paste 到这个 textarea 上、xterm 再转发给 PTY，
   * 这条路**不需要任何权限**，HTTP 下照样能用。execCommand('paste') 也依赖它。
   */
  get textarea(): HTMLTextAreaElement | null {
    return (this.term?.element?.querySelector('textarea') as HTMLTextAreaElement | null) ?? null;
  }

  /** 当前可见区域的纯文本内容（供自动化验证使用）。 */
  bufferText(): string {
    if (!this.term) return '';
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i += 1) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    return lines.join('\n');
  }

  // ---------------------------------------------------------------- internals

  private setState(state: ConnState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onState?.(state);
  }

  private scheduleRetry(): void {
    if (this.disposed || this.fatal || this.retryTimer !== null) return;
    const delay = Math.min(8000, 500 * Math.pow(2, this.retry));
    this.retry += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private pushOutput(data: Uint8Array): void {
    this.outQueue.push(data);
    this.outQueueBytes += data.length;
    // 终端尚未挂载（例如标签页还没被激活）时，缓冲必须有上限，
    // 否则长时间不打开的标签页会把内存吃满。
    while (this.outQueueBytes > MAX_PENDING_BYTES && this.outQueue.length > 0) {
      this.outQueueBytes -= this.outQueue.shift()!.length;
    }
    this.flush();
  }

  /** 合并输出批次：一帧一次写入，减少 xterm 的解析开销。 */
  private flush(): void {
    if (this.flushPending) return;
    this.flushPending = true;
    const run = () => {
      this.flushPending = false;
      this.flushTimer = null;
      this.flushUsesTimeout = false;
      if (!this.term || this.outQueue.length === 0) return;
      const batch = this.outQueue;
      this.outQueue = [];
      this.outQueueBytes = 0;
      for (const chunk of batch) this.term.write(chunk);
    };
    // 标签页隐藏时 requestAnimationFrame 不会触发，输出会一直堆在队列里，
    // 堆到 MAX_PENDING_BYTES 后只能丢掉最旧的部分——TUI 的画面就花掉了。
    // 所以隐藏时改用 setTimeout 兜底，保证输出照常被消费。
    if (typeof document !== 'undefined' && document.hidden) {
      this.flushUsesTimeout = true;
      this.flushTimer = window.setTimeout(run, 16);
    } else {
      this.flushUsesTimeout = false;
      this.flushTimer = requestAnimationFrame(run);
    }
  }

  /** 标签页重新可见：把积压的输出尽快刷出去，并同步一次尺寸。 */
  onVisible(): void {
    this.flush();
    this.refreshSize();
  }

  private sendInput(data: string): void {
    if (!data) return;
    const bytes = new TextEncoder().encode(data);
    this.sendFrame(C_INPUT, bytes);
  }

  /** 发送终端自动应答（DA/OSC 查询），由后端校验接收者后决定是否写 PTY。 */
  private sendTerminalResponse(data: string): void {
    if (!data) return;
    const bytes = new TextEncoder().encode(data);
    this.sendFrame(C_TERM_RESPONSE, bytes);
  }

  /** 8 位鼠标等原始字节流（xterm 的 onBinary 给的是 latin1 字符串）。 */
  private sendBinary(data: string): void {
    if (!data) return;
    const bytes = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) bytes[i] = data.charCodeAt(i) & 0xff;
    this.sendFrame(C_INPUT, bytes);
  }

  private sendResize(cols: number, rows: number): void {
    this.sendFrame(C_RESIZE, new TextEncoder().encode(JSON.stringify({ cols, rows })));
  }

  private sendFrame(kind: number, payload: Uint8Array): void {
    if (this.disposed) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    try {
      ws.send(frame);
    } catch {
      // 发送失败说明这条连接已经废了：关掉它，让 onclose 触发重连。
      // 不这么做的话输入会被静默丢弃，用户只会觉得「终端卡住了」。
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}
