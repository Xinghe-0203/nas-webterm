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
  /** 终端行列数变化（底部状态栏用） */
  onSize?: (cols: number, rows: number) => void;
  /** 服务端明确拒绝（会话数超限等）时回调：提示用户，且不再自动重连 */
  onError?: (message: string, code: string) => void;
}

/** 终端未挂载时的输出缓冲上限（字节） */
const MAX_PENDING_BYTES = 1024 * 1024;

const DARK_THEME = {
  background: '#090c11',
  foreground: '#e6edf7',
  cursor: '#4da3ff',
  cursorAccent: '#090c11',
  selectionBackground: 'rgba(77,163,255,0.30)',
  black: '#171d27',
  red: '#ff6b81',
  green: '#3ddc97',
  yellow: '#f5c451',
  blue: '#4da3ff',
  magenta: '#b98cff',
  cyan: '#3fd0d4',
  white: '#c8d3e2',
  brightBlack: '#5d6a7d',
  brightRed: '#ff8a9b',
  brightGreen: '#6cf0b6',
  brightYellow: '#ffd97a',
  brightBlue: '#7dbcff',
  brightMagenta: '#d0b0ff',
  brightCyan: '#6ee7e7',
  brightWhite: '#f3f8ff',
};

const LIGHT_THEME = {
  background: '#fcfdff',
  foreground: '#1a2230',
  cursor: '#0b74d1',
  cursorAccent: '#fcfdff',
  selectionBackground: 'rgba(11,116,209,0.22)',
  black: '#1a2230',
  red: '#d32f2f',
  green: '#0f9d6e',
  yellow: '#a16207',
  blue: '#0b74d1',
  magenta: '#7c3aed',
  cyan: '#0e7490',
  white: '#5f6b7c',
  brightBlack: '#8a94a4',
  brightRed: '#dc2626',
  brightGreen: '#10b981',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#8b5cf6',
  brightCyan: '#0891b2',
  brightWhite: '#94a3b8',
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
      this.opts.onSize?.(cols, rows);
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
    const sid = this.sid;
    this.sid = null;
    if (sid) {
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
