import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';

/** 帧类型：与服务端 Rust 实现一一对应 */
const C_INPUT = 0x01;
const C_RESIZE = 0x02;
const S_OUTPUT = 0x01;
const S_EXIT = 0x02;
const S_READY = 0x03;
const S_ERROR = 0x04;

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
}

/** 终端未挂载时的输出缓冲上限（字节） */
const MAX_PENDING_BYTES = 1024 * 1024;

const DARK_THEME = {
  background: '#0c0d11',
  foreground: '#d8dce3',
  cursor: '#d8dce3',
  cursorAccent: '#0c0d11',
  selectionBackground: 'rgba(76,141,255,0.35)',
  black: '#20242c',
  red: '#e5534b',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#4c8dff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#c9d1d9',
  brightBlack: '#6e7681',
  brightRed: '#ff7b72',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79b8ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc',
};

const LIGHT_THEME = {
  background: '#fbfbfc',
  foreground: '#1e2128',
  cursor: '#1e2128',
  cursorAccent: '#fbfbfc',
  selectionBackground: 'rgba(76,141,255,0.25)',
};

const FONT_STACK =
  '"Sarasa Mono SC","Noto Sans Mono CJK SC","Source Han Mono SC","WenQuanYi Micro Hei",' +
  'Menlo,Monaco,"DejaVu Sans Mono","Microsoft YaHei Mono",Consolas,monospace';

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
  private retry = 0;
  private retryTimer: number | null = null;
  private disposed = false;
  private suppressRetry = false;
  private state: ConnState = 'offline';
  private lastCols = 0;
  private lastRows = 0;
  private exited = false;

  constructor(opts: TerminalSessionOpts) {
    this.opts = opts;
    this.sid = opts.sid ?? null;
    this.cmd = opts.cmd ?? null;
  }

  get connState(): ConnState {
    return this.state;
  }

  get isExited(): boolean {
    return this.exited;
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
      fontSize: this.opts.fontSize ?? 14,
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

    term.onData((data) => this.sendInput(data));
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
    }
  }

  setFontSize(size: number): void {
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
    if (this.disposed || this.ws) return;
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

    ws.onopen = () => {
      this.retry = 0;
      this.setState('online');
      if (this.lastCols) this.sendResize(this.lastCols, this.lastRows);
    };

    ws.onmessage = (ev: MessageEvent) => {
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
      } else if (kind === S_ERROR) {
        this.writeSystemLine(`服务端错误: ${new TextDecoder().decode(payload)}\n`);
      }
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.disposed || this.suppressRetry) return;
      this.setState('offline');
      if (!this.exited) this.scheduleRetry();
    };
  }

  /** 关闭会话（服务端会杀掉 PTY 进程）。 */
  async close(): Promise<void> {
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
    if (this.sid) {
      try {
        await fetch(`${this.opts.base}api/sessions/${encodeURIComponent(this.sid)}`, {
          method: 'DELETE',
          credentials: 'same-origin',
        });
      } catch {
        /* ignore */
      }
    }
    // 完整释放：观察器、终端实例、未写出的输出缓冲
    this.release();
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    if (this.ws) {
      try {
        this.ws.close();
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
  }

  /** 重启会话：丢弃旧 PTY，向服务端申请一个新的。 */
  restart(): void {
    this.suppressRetry = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.suppressRetry = false;
    this.sid = null;
    this.exited = false;
    this.release();
    this.connect();
  }

  /** 往终端写一行系统提示（不经过 PTY）。 */
  writeSystemLine(text: string): void {
    this.pushOutput(new TextEncoder().encode(text));
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
    if (this.disposed || this.retryTimer !== null) return;
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
    requestAnimationFrame(() => {
      this.flushPending = false;
      if (!this.term || this.outQueue.length === 0) return;
      const batch = this.outQueue;
      this.outQueue = [];
      this.outQueueBytes = 0;
      for (const chunk of batch) this.term.write(chunk);
    });
  }

  private sendInput(data: string): void {
    if (!data) return;
    const bytes = new TextEncoder().encode(data);
    this.sendFrame(C_INPUT, bytes);
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
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame = new Uint8Array(payload.length + 1);
    frame[0] = kind;
    frame.set(payload, 1);
    ws.send(frame);
  }
}
