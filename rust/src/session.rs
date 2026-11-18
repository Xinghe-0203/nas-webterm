//! PTY 会话管理：一个会话 = 一个真实伪终端进程。
//!
//! 设计要点：
//! - 输出走「会话 → 每客户端一条有界队列」，慢客户端会被踢掉而不是拖垮服务端；
//! - 保留最近 1MB 输出用于断线重连后回放（也是 AI 终端上下文的来源），刷新页面不丢屏；
//! - 空闲会话按 TTL 回收，避免长期占用 root 进程；
//! - 结束会话时按「会话 id + 环境标记」清理整棵进程树，不留后台作业；
//! - 读线程用 poll 带超时，会话结束后即使还有进程占着 PTY 也能退出，不泄漏线程。

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use tokio::sync::mpsc;

use crate::config::Config;
use crate::proto;

/// 断线重连回放缓冲区上限
/// 回放缓冲区软上限（超出后尽量裁剪）
const REPLAY_CAP: usize = 1024 * 1024;
/// 回放缓冲区裁剪的滞后量。超过「软上限 + 滞后量」才裁剪一次，
/// 避免每读到 16KB 就 memmove 整个 1MB 缓冲区（高频输出时会被放大几十倍）。
const REPLAY_TRIM_SLACK: usize = 64 * 1024;
/// 回放缓冲区硬上限。处于备用屏幕时，为了保住「进入备用屏幕」那个起点，
/// 允许在软上限之上继续保留，直到硬上限。
const REPLAY_HARD_CAP: usize = 4 * 1024 * 1024;
/// 进入备用屏幕（全屏 TUI）的序列
const ALT_ENTER: [&[u8]; 2] = [b"\x1b[?1049h", b"\x1b[?47h"];
/// 离开备用屏幕的序列
const ALT_LEAVE: [&[u8]; 2] = [b"\x1b[?1049l", b"\x1b[?47l"];
/// 单客户端输出队列容量（块，每块最大 16KB）。
/// 512 块 = 每客户端 8MB 最坏情况，多个标签页 + 多个浏览器就会把内存吃满；
/// 256 块（4MB）仍然足以吸收正常的网络抖动，消费不过来就断开重连（走回放）。
const CLIENT_QUEUE: usize = 256;
/// PTY 读取块大小
const READ_BUF: usize = 16 * 1024;
/// 读线程等待 PTY 可读的超时。超时只用于检查「会话是否已被结束」，
/// 有数据时 poll 会立刻返回，不影响吞吐；空闲时每个会话每秒最多醒一次。
const READ_POLL_MS: i32 = 1000;
/// 从未被任何客户端连接过的会话，超过这个时长就回收。
///
/// 正常流程里会话一建好（WS upgrade 后）客户端马上就 attach，所以「从来没被
/// 连接过」只可能是异常情况：页面在握手瞬间被关掉、客户端进程被强杀、
/// 或者有人直接 POST /api/sessions 建了却没用。这类会话永远不会有人来认领，
/// 不清掉就会一直占着 root shell + 回放缓冲（默认不按空闲时间回收）。
const ORPHAN_GRACE: Duration = Duration::from_secs(5 * 60);
/// 会话进程树的环境标记：子孙进程即使 setsid 也能被找出来清掉。
const SESSION_ENV: &str = "NAS_WEBTERM_SESSION";
/// 应用名标记：服务重启时用来清理上一次运行留下的孤儿 shell。
const APP_ENV: &str = "NAS_WEBTERM_APP";
/// PTY 尺寸上下界：防止畸形请求把行列数设成几万，把 TUI 与内核终端缓冲拖垮。
pub const MAX_COLS: u16 = 1000;
pub const MAX_ROWS: u16 = 1000;
/// 输入队列容量
const INPUT_QUEUE: usize = 1024;
/// 备用屏幕序列的最大长度（`ESC[?1049h` = 8 字节）。
/// 跨读块边界时要把上一块尾部这么多字节带过来拼接。
const MAX_ALT_SEQ_LEN: usize = 8;
/// 会话数超限错误的固定前缀。
///
/// HTTP 层靠它区分「容量满」和其它错误：容量满要给 429 + 明确文案，
/// 前端据此停止重连（否则会无限指数重试，终端永远 offline）。
pub const LIMIT_ERR_PREFIX: &str = "会话数已达上限";

/// 终端查询应答的等待窗口。
///
/// xterm.js 在解析到查询后几乎立即生成应答（毫秒级）；给 5 秒是照顾
/// 高延迟链路/浏览器卡顿。超过窗口的应答一律视为过期，不能再写进 PTY，
/// 否则程序已经退出、Shell 已经接管时就会把 rgb:... / 1;2c 当成输入。
const TERMINAL_QUERY_TTL: Duration = Duration::from_secs(5);
/// 单个会话最多保留多少条待应答查询（防止恶意程序刷屏撑爆内存）。
const MAX_PENDING_QUERIES: usize = 64;

/// 会触终端自动应答的查询类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TerminalQueryKind {
    /// CSI c / CSI 0 c：主设备属性（xterm.js 回 `ESC[?1;2c`）
    Da1,
    /// CSI > c / CSI > 0 c：次设备属性（回 `ESC[>0;276;0c`）
    Da2,
    /// CSI 5 n：设备状态报告（回 `ESC[0n`）
    DsrStatus,
    /// CSI 6 n / CSI ? 6 n：光标位置报告（回 `ESC[row;colR` / `ESC[?row;colR`）
    DsrCursor { private: bool },
    /// CSI Ps $ p / CSI ? Ps $ p：DECRQM 模式查询（回 `ESC[?Ps;V$y`）
    DecRqm { ansi: bool, mode: u16 },
    /// CSI 18 t：字符尺寸窗口报告（回 `ESC[8;rows;colst`）
    WindowChars,
    /// CSI 14 t：像素尺寸窗口报告（回 `ESC[4;height;widtht`）
    WindowPixels,
    /// CSI 16 t：单元格像素尺寸报告（回 `ESC[6;height;widtht`）
    CellPixels,
    /// OSC 4 ; index ; ?：索引色查询
    Osc4(u16),
    /// OSC 10 ; ?：默认前景色
    Osc10,
    /// OSC 11 ; ?：默认背景色
    Osc11,
    /// OSC 12 ; ?：光标色
    Osc12,
}

impl TerminalQueryKind {
    fn label(self) -> String {
        match self {
            TerminalQueryKind::Da1 => "DA1".to_string(),
            TerminalQueryKind::Da2 => "DA2".to_string(),
            TerminalQueryKind::DsrStatus => "DSR-5".to_string(),
            TerminalQueryKind::DsrCursor { private } => {
                if private { "DECDSR-6".to_string() } else { "DSR-6".to_string() }
            }
            TerminalQueryKind::DecRqm { ansi, mode } => {
                format!("DECRQM-{}{}", if ansi { "ANSI-" } else { "DEC-" }, mode)
            }
            TerminalQueryKind::WindowChars => "CSI-18t".to_string(),
            TerminalQueryKind::WindowPixels => "CSI-14t".to_string(),
            TerminalQueryKind::CellPixels => "CSI-16t".to_string(),
            TerminalQueryKind::Osc4(i) => format!("OSC4[{i}]"),
            TerminalQueryKind::Osc10 => "OSC10".to_string(),
            TerminalQueryKind::Osc11 => "OSC11".to_string(),
            TerminalQueryKind::Osc12 => "OSC12".to_string(),
        }
    }
}

/// 查询发出时，谁有能力读取这个应答。
#[derive(Debug, Clone, PartialEq, Eq)]
enum QueryRecipient {
    /// 普通前台进程组：记录 pgid 与进程组组长的 /proc starttime，
    /// 防止进程退出后 pid/pgid 被复用导致误放行。
    Foreground { pgid: i32, start: u64 },
    /// 前台是 shell 本身，但 shell 下有同进程组的子进程（命令替换、
    /// 提示符主题工具等）——它们可能正是查询者。记录这些子进程身份，
    /// 只有至少一个还活着时才允许应答。
    ShellChildren {
        shell_pgid: i32,
        children: Vec<(u32, u64)>,
    },
}

/// 一条待匹配的终端查询。
#[derive(Debug, Clone)]
struct PendingTerminalQuery {
    kind: TerminalQueryKind,
    recipient: QueryRecipient,
    at: Instant,
}

/// PTY 输出流的轻量状态机：跨读块拼接 OSC / CSI 查询。
///
/// 只解析查询，不改变、不 buffer 终端输出本身；扫描失败也不会影响显示。
struct TerminalQueryScanner {
    state: ScanState,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    Ground,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

impl TerminalQueryScanner {
    fn new() -> Self {
        Self {
            state: ScanState::Ground,
            payload: Vec::with_capacity(64),
        }
    }

    /// 喂一段 PTY 输出；每发现一个查询就回调一次。
    fn feed(&mut self, data: &[u8], mut on_query: impl FnMut(TerminalQueryKind)) {
        for &byte in data {
            match self.state {
                ScanState::Ground => {
                    if byte == 0x1b {
                        self.state = ScanState::Esc;
                    }
                }
                ScanState::Esc => match byte {
                    b'[' => {
                        self.payload.clear();
                        self.state = ScanState::Csi;
                    }
                    b']' => {
                        self.payload.clear();
                        self.state = ScanState::Osc;
                    }
                    0x1b => { /* 连续 ESC：保持 Esc 状态 */ }
                    _ => self.state = ScanState::Ground,
                },
                ScanState::Csi => {
                    if byte == 0x1b {
                        self.state = ScanState::Esc;
                        self.payload.clear();
                    } else if (0x40..=0x7e).contains(&byte) {
                        // final byte：查我们关心的几类终端查询
                        if let Some(kind) = parse_csi_query(&self.payload, byte) {
                            on_query(kind);
                        }
                        self.state = ScanState::Ground;
                        self.payload.clear();
                    } else if self.payload.len() < 64 {
                        self.payload.push(byte);
                    } else {
                        // 超长 CSI：不可能是我们关心的查询，丢弃并回到地面状态
                        self.state = ScanState::Ground;
                        self.payload.clear();
                    }
                }
                ScanState::Osc => match byte {
                    0x07 => {
                        let mut payload = std::mem::take(&mut self.payload);
                        parse_osc_query(&payload, &mut on_query);
                        payload.clear();
                        self.payload = payload;
                        self.state = ScanState::Ground;
                    }
                    0x1b => self.state = ScanState::OscEsc,
                    _ => {
                        if self.payload.len() < 512 {
                            self.payload.push(byte);
                        }
                    }
                },
                ScanState::OscEsc => match byte {
                    b'\\' => {
                        let mut payload = std::mem::take(&mut self.payload);
                        parse_osc_query(&payload, &mut on_query);
                        payload.clear();
                        self.payload = payload;
                        self.state = ScanState::Ground;
                    }
                    0x1b => {
                        // ESC ESC：前一个 ESC 算 payload 的一部分，继续等 ST
                    }
                    _ => {
                        if self.payload.len() < 510 {
                            self.payload.push(0x1b);
                            self.payload.push(byte);
                        }
                        self.state = ScanState::Osc;
                    }
                },
            }
        }
    }
}

/// 解析 CSI 参数（不含 final byte）。
fn parse_csi_query(payload: &[u8], final_byte: u8) -> Option<TerminalQueryKind> {
    let text = std::str::from_utf8(payload).ok()?;
    match final_byte {
        b'c' => {
            if let Some(rest) = text.strip_prefix('>') {
                let first = rest.split(';').next().unwrap_or("");
                if first.is_empty() || first == "0" {
                    return Some(TerminalQueryKind::Da2);
                }
                return None;
            }
            // DA1：CSI c / CSI 0 c；带 ? 的是应答而不是查询。
            if text.starts_with('?') {
                return None;
            }
            let first = text.split(';').next().unwrap_or("");
            if first.is_empty() || first == "0" {
                return Some(TerminalQueryKind::Da1);
            }
            None
        }
        b'n' => {
            let (private, body) = match text.strip_prefix('?') {
                Some(rest) => (true, rest),
                None => (false, text),
            };
            let first = body.split(';').next().unwrap_or("");
            match first {
                "5" => Some(TerminalQueryKind::DsrStatus),
                "6" => Some(TerminalQueryKind::DsrCursor { private }),
                _ => None,
            }
        }
        b'p' => {
            // DECRQM：CSI Ps $ p（ANSI）或 CSI ? Ps $ p（DEC private）
            let (ansi, body) = match text.strip_prefix('?') {
                Some(rest) => (false, rest),
                None => (true, text),
            };
            let body = body.strip_suffix('$')?;
            let mode = body.split(';').next()?.parse::<u16>().ok()?;
            Some(TerminalQueryKind::DecRqm { ansi, mode })
        }
        b't' => match text.split(';').next().unwrap_or("") {
            "14" => Some(TerminalQueryKind::WindowPixels),
            "16" => Some(TerminalQueryKind::CellPixels),
            "18" => Some(TerminalQueryKind::WindowChars),
            _ => None,
        },
        _ => None,
    }
}

/// 解析 OSC payload（不含 OSC 引导符与结束符）。
fn parse_osc_query(payload: &[u8], on_query: &mut impl FnMut(TerminalQueryKind)) {
    let Ok(text) = std::str::from_utf8(payload) else { return };
    let mut parts = text.split(';');
    let Some(ident) = parts.next().and_then(|s| s.parse::<u16>().ok()) else {
        return;
    };
    match ident {
        4 => {
            let rest: Vec<&str> = parts.collect();
            for pair in rest.chunks_exact(2) {
                let Ok(index) = pair[0].parse::<u16>() else { continue };
                if index <= 255 && pair[1] == "?" {
                    on_query(TerminalQueryKind::Osc4(index));
                }
            }
        }
        10 => {
            if parts.next() == Some("?") {
                on_query(TerminalQueryKind::Osc10);
            }
        }
        11 => {
            if parts.next() == Some("?") {
                on_query(TerminalQueryKind::Osc11);
            }
        }
        12 => {
            if parts.next() == Some("?") {
                on_query(TerminalQueryKind::Osc12);
            }
        }
        _ => {}
    }
}

/// 从 xterm.js 发回来的应答中拆出每一条可路由的序列。
///
/// xterm.js 的 `onData` 可能把多条应答串在同一个字符串里，所以这里按
/// 转义序列逐条解析，分别与查询匹配；任何无法识别的片段都不会写进 PTY。
fn parse_terminal_response(data: &[u8]) -> Vec<(TerminalQueryKind, Vec<u8>)> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < data.len() {
        if data[i] != 0x1b || i + 1 >= data.len() {
            i += 1;
            continue;
        }
        match data[i + 1] {
            b'[' => {
                let start = i;
                // CSI: 参数/前缀直到 final byte
                let mut j = i + 2;
                while j < data.len() && !(0x40..=0x7e).contains(&data[j]) {
                    j += 1;
                }
                if j >= data.len() {
                    break;
                }
                let text = String::from_utf8_lossy(&data[i + 2..j]).to_string();
                match data[j] {
                    b'c' => {
                        if let Some(rest) = text.strip_prefix('>') {
                            let first = rest.split(';').next().unwrap_or("");
                            if first == "0" || first.is_empty() {
                                out.push((TerminalQueryKind::Da2, data[start..=j].to_vec()));
                            }
                        } else if text.starts_with('?') {
                            // DA1 应答固定是 ESC[?...c
                            out.push((TerminalQueryKind::Da1, data[start..=j].to_vec()));
                        }
                    }
                    b'n' => {
                        if text == "0" {
                            out.push((TerminalQueryKind::DsrStatus, data[start..=j].to_vec()));
                        }
                    }
                    b'R' => {
                        let (private, body) = match text.strip_prefix('?') {
                            Some(rest) => (true, rest),
                            None => (false, text.as_str()),
                        };
                        let values: Vec<&str> = body.split(';').collect();
                        if values.len() == 2
                            && values[0].parse::<u32>().is_ok()
                            && values[1].parse::<u32>().is_ok()
                        {
                            out.push((
                                TerminalQueryKind::DsrCursor { private },
                                data[start..=j].to_vec(),
                            ));
                        }
                    }
                    b'y' => {
                        let (ansi, body) = match text.strip_prefix('?') {
                            Some(rest) => (false, rest),
                            None => (true, text.as_str()),
                        };
                        let Some(body) = body.strip_suffix('$') else {
                            i = j + 1;
                            continue;
                        };
                        let mut values = body.split(';');
                        let mode = values.next().and_then(|s| s.parse::<u16>().ok());
                        let value = values.next().and_then(|s| s.parse::<u16>().ok());
                        if let (Some(mode), Some(_value)) = (mode, value) {
                            out.push((
                                TerminalQueryKind::DecRqm { ansi, mode },
                                data[start..=j].to_vec(),
                            ));
                        }
                    }
                    b't' => {
                        let first = text.split(';').next().unwrap_or("");
                        let kind = match first {
                            "4" => Some(TerminalQueryKind::WindowPixels),
                            "6" => Some(TerminalQueryKind::CellPixels),
                            "8" => Some(TerminalQueryKind::WindowChars),
                            _ => None,
                        };
                        if let Some(kind) = kind {
                            out.push((kind, data[start..=j].to_vec()));
                        }
                    }
                    _ => {}
                }
                i = j + 1;
            }
            b']' => {
                let start = i;
                let mut j = i + 2;
                let mut terminated = false;
                while j < data.len() {
                    if data[j] == 0x07 {
                        j += 1;
                        terminated = true;
                        break;
                    }
                    if data[j] == 0x1b && j + 1 < data.len() && data[j + 1] == b'\\' {
                        j += 2;
                        terminated = true;
                        break;
                    }
                    j += 1;
                }
                if !terminated {
                    break;
                }
                let payload = &data[i + 2..j];
                // payload 末尾含 BEL 或 ESC\，解析时先剥掉
                let body = if payload.ends_with(&[0x07]) {
                    &payload[..payload.len() - 1]
                } else {
                    &payload[..payload.len().saturating_sub(2)]
                };
                let text = String::from_utf8_lossy(body);
                let mut parts = text.split(';');
                let ident = parts.next().and_then(|s| s.parse::<u16>().ok());
                if let Some(ident) = ident {
                    let kind = match ident {
                        4 => parts.next().and_then(|s| s.parse::<u16>().ok()).map(TerminalQueryKind::Osc4),
                        10 => Some(TerminalQueryKind::Osc10),
                        11 => Some(TerminalQueryKind::Osc11),
                        12 => Some(TerminalQueryKind::Osc12),
                        _ => None,
                    };
                    if let Some(kind) = kind {
                        out.push((kind, data[start..j].to_vec()));
                    }
                }
                i = j;
            }
            _ => i += 2,
        }
    }
    out
}

/// 生成「会话数已达上限」错误。
pub fn limit_error(max: usize) -> String {
    format!(
        "{}（{} 个），请先关闭一个标签页再新建",
        LIMIT_ERR_PREFIX, max
    )
}

/// 判断错误是不是「会话数已达上限」。
pub fn is_limit_error(e: &str) -> bool {
    e.starts_with(LIMIT_ERR_PREFIX)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ExitInfo {
    pub code: i32,
    pub signal: Option<i32>,
}

/// 客户端挂载信息
pub struct AttachInfo {
    pub cid: u64,
    pub rx: mpsc::Receiver<Bytes>,
    /// 需要回放给客户端的输出
    pub replay: Vec<u8>,
    /// 会话当前是否处于备用屏幕
    pub alt_screen: bool,
    /// 回放里没有备用屏幕入口，客户端需要自己先切进去
    pub need_alt_enter: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub cols: u16,
    pub rows: u16,
    pub clients: usize,
    pub alive: bool,
    /// 是否处于备用屏幕（全屏 TUI）
    pub alt_screen: bool,
    pub created: u64,
    /// 回放缓冲区占用字节数（长期挂着的会话可以据此判断内存占用）
    pub replay_bytes: usize,
}

pub struct Session {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<u32>,
    /// 环境标记值（写进所有子孙进程的 environ，用于结束会话时清理整棵进程树）
    marker: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    input_tx: mpsc::Sender<Vec<u8>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    size: Mutex<PtySize>,
    /// 每个客户端一条队列，队列里放的是**已经打包好的完整帧**（含类型字节），
    /// 直接投递给 WebSocket 即可，避免二次包帧。
    clients: Mutex<Vec<(u64, mpsc::Sender<Bytes>)>>,
    replay: Mutex<Vec<u8>>,
    exit: Mutex<Option<ExitInfo>>,
    /// 当前是否处于备用屏幕（全屏 TUI 会切到备用屏幕）
    alt_screen: AtomicBool,
    /// 最近一次进入备用屏幕的位置（回放缓冲区内的下标）
    alt_enter_idx: AtomicUsize,
    /// 上一次读块尾部残留的字节（用于跨块识别转义序列）
    alt_tail: Mutex<Vec<u8>>,
    alive: AtomicBool,
    /// 会话已被显式结束（关闭标签页 / 回收 / 服务停止）。
    /// 读线程靠它退出：即使还有进程占着 PTY slave 导致 read 永不返回，
    /// 也能在 poll 超时后自己收尾，不会永久占着一个阻塞线程。
    shutdown: AtomicBool,
    /// kill() 是否已经执行过（幂等，避免重复写日志 / 重复扫描 /proc）
    killed: AtomicBool,
    first_output: AtomicBool,
    /// 有没有客户端成功挂载过（用于识别「建了但没人连」的孤儿会话）
    ever_attached: AtomicBool,
    last_active: Mutex<Instant>,
    created: Instant,
    client_seq: AtomicU64,
    /// 会话自创建以来累计写出的字节数（单调递增，不因回放缓冲裁剪而回退）。
    /// AI agent 用它标记「这条命令之前/之后的输出分界」。
    total_out: AtomicU64,
    /// 回放缓冲区头部已经丢弃的字节数（= total_out - replay.len() 的近似）。
    replay_dropped: AtomicU64,
    /// 跨读块的终端查询扫描器（OSC/DA）。
    query_scanner: Mutex<TerminalQueryScanner>,
    /// 已看到查询、但还没有收到应答的记录。
    pending_queries: Mutex<Vec<PendingTerminalQuery>>,
}

impl Session {
    fn spawn(
        cfg: &Config,
        id: String,
        cols: u16,
        rows: u16,
        startup: Option<String>,
    ) -> Result<Arc<Session>, String> {
        let shell = resolve_shell(&cfg.shell);
        let cwd = resolve_cwd(&cfg.cwd);
        // 尺寸必须在这里再钳一次：HTTP / WebSocket 传进来的值未必经过校验，
        // 65535x65535 的 PTY 会让 TUI 程序按巨大的行列数分配缓冲区。
        let size = PtySize {
            rows: rows.clamp(2, MAX_ROWS),
            cols: cols.clamp(2, MAX_COLS),
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("创建 PTY 失败: {}", e))?;

        // 会话标记：128 位随机 id 本身就唯一，直接复用。
        // 所有子孙进程都会继承这个环境变量（environ 在 exec 时固定），
        // 结束会话时据此扫描 /proc，把 setsid / nohup 出去的后台进程也找出来。
        let marker = format!("{}-{}", cfg.instance_tag(), id);
        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        for (k, v) in child_env(&shell, &cwd, &cfg.instance_tag(), &marker, &id) {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动 shell 失败: {}", e))?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("读取 PTY 失败: {}", e))?;
        // 从 master 侧取写入端：写入 master 的内容就是终端程序的输入。
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("写入 PTY 失败: {}", e))?;

        let (input_tx, mut input_rx) = mpsc::channel::<Vec<u8>>(INPUT_QUEUE);
        // 读线程要用的 master fd：poll 用它等待「有数据可读」。
        // 注：reader 自己持有一份 dup，所以即使这里拿不到 fd 也不影响读取。
        let master_fd = pair.master.as_raw_fd().unwrap_or(-1);

        let session = Arc::new(Session {
            id: id.clone(),
            shell: shell.clone(),
            cwd: cwd.clone(),
            pid,
            marker,
            master: Mutex::new(pair.master),
            input_tx,
            killer: Mutex::new(Some(killer)),
            size: Mutex::new(size),
            clients: Mutex::new(Vec::new()),
            replay: Mutex::new(Vec::new()),
            exit: Mutex::new(None),
            alt_screen: AtomicBool::new(false),
            alt_enter_idx: AtomicUsize::new(usize::MAX),
            alt_tail: Mutex::new(Vec::new()),
            alive: AtomicBool::new(true),
            shutdown: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            first_output: AtomicBool::new(false),
            ever_attached: AtomicBool::new(false),
            last_active: Mutex::new(Instant::now()),
            created: Instant::now(),
            total_out: AtomicU64::new(0),
            replay_dropped: AtomicU64::new(0),
            client_seq: AtomicU64::new(0),
            query_scanner: Mutex::new(TerminalQueryScanner::new()),
            pending_queries: Mutex::new(Vec::new()),
        });

        // 写入线程：把输入队列的字节真正写进 PTY。
        let weak_write = Arc::downgrade(&session);
        tokio::task::spawn_blocking(move || {
            while let Some(data) = input_rx.blocking_recv() {
                if writer.write_all(&data).is_err() {
                    // 写失败说明 PTY 已经不可用了（主程序退出 / master 被关闭）。
                    // 必须把会话标记成结束，否则后续输入会被静默吞掉，
                    // 页面还一直显示「运行中」。
                    crate::log_warn!("会话的 PTY 写入失败，标记为已结束");
                    if let Some(s) = weak_write.upgrade() {
                        s.on_child_exit(ExitInfo {
                            code: -1,
                            signal: None,
                        });
                    }
                    break;
                }
            }
        });

        // 子进程回收线程：与 PTY 读取线程**解耦**。
        //
        // 旧实现把 Child 句柄放在读取线程里，等「PTY 读到 EOF」才 wait 回收。
        // 但 EOF 依赖所有持有 slave fd 的进程都退出：终端里跑 `sleep 999 &`
        // 再退出 shell 时，后台进程仍持有 slave fd，master 永远读不到 EOF，
        // 于是 shell 变成僵尸进程、客户端收不到退出通知、会话一直占着名额。
        //
        // 现在由独立的线程阻塞 wait：子进程一退出就立刻回收并通知客户端，
        // 与 PTY 是否还有输出无关。
        let weak_child = Arc::downgrade(&session);
        let mut child = child;
        tokio::task::spawn_blocking(move || {
            let info = match child.wait() {
                Ok(st) => ExitInfo {
                    code: st.exit_code() as i32,
                    signal: exit_signal(&st),
                },
                Err(e) => {
                    crate::log_warn!("等待子进程退出失败: {}", e);
                    ExitInfo {
                        code: -1,
                        signal: None,
                    }
                }
            };
            if let Some(s) = weak_child.upgrade() {
                s.on_child_exit(info);
            }
        });

        // 读取线程：只负责把 PTY 输出推给所有客户端。
        //
        // 用 poll 等可读而不是直接阻塞 read：如果终端里跑的进程自己 setsid / nohup
        // 逃出了会话、并且一直占着 PTY slave，read 永远不会返回，这个线程就会
        // 永久卡住（每关一个这样的标签页就漏一个线程 + fd + 栈内存）。
        // poll 每秒醒一次，发现会话已被结束就退出，同时不影响正常读取延迟。
        let weak = Arc::downgrade(&session);
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                if master_fd >= 0 {
                    let Some(s) = weak.upgrade() else { break };
                    if s.shutting_down() {
                        break;
                    }
                    let mut pfd = libc::pollfd {
                        fd: master_fd,
                        events: libc::POLLIN,
                        revents: 0,
                    };
                    let rc = unsafe { libc::poll(&mut pfd, 1, READ_POLL_MS) };
                    drop(s);
                    if rc == 0 {
                        continue; // 超时：回到循环顶部检查会话状态
                    }
                    if rc < 0 {
                        let err = std::io::Error::last_os_error();
                        if err.kind() == std::io::ErrorKind::Interrupted {
                            continue;
                        }
                        break;
                    }
                    if pfd.revents & libc::POLLNVAL != 0 {
                        break;
                    }
                }
                let n = match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                match weak.upgrade() {
                    Some(s) => {
                        s.first_output.store(true, Ordering::Relaxed);
                        s.push_output(Arc::new(buf[..n].to_vec()));
                    }
                    None => break,
                }
            }
            // 子进程的 wait 由上面那个独立的回收线程负责，这里不重复 wait。
        });

        // 新会话自动键入的命令：等 shell 吐出第一段输出（提示符）后再发送，
        // 这样即使命令不存在，shell 也只是报一行错，不会连提示符一起吃掉。
        if let Some(command) = startup.filter(|c| !c.trim().is_empty()) {
            if !command_available(&command) {
                crate::log_warn!(
                    "启动命令的第一段在 PATH 中找不到，仍会照常键入: {}",
                    command
                );
            }
            let weak = Arc::downgrade(&session);
            tokio::spawn(async move {
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    match weak.upgrade() {
                        Some(s) => {
                            if s.first_output.load(Ordering::Relaxed) {
                                break;
                            }
                        }
                        None => return,
                    }
                    if Instant::now() > deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
                if let Some(s) = weak.upgrade() {
                    let mut payload = command.trim().to_string().into_bytes();
                    payload.push(b'\n');
                    let _ = s.input_tx.send(payload).await;
                }
            });
        }

        Ok(session)
    }

    /// 输出分发给所有客户端，并写入回放缓冲区。
    fn push_output(self: &Arc<Self>, data: Arc<Vec<u8>>) {
        let base = {
            let mut replay = self.replay.lock().unwrap_or_else(|e| e.into_inner());
            replay.extend_from_slice(&data);
            // 只在超过「软上限 + 滞后量」时裁剪一次，并裁回软上限附近。
            // 旧实现每读一块（16KB）就 drain 一次 16KB，等于每次都 memmove
            // 整个 1MB 缓冲区；大文件 cat / 编译输出时白烧几十倍 CPU。
            if replay.len() > REPLAY_CAP + REPLAY_TRIM_SLACK {
                let excess = replay.len() - (REPLAY_CAP + REPLAY_TRIM_SLACK);
                let alt_idx = self.alt_enter_idx.load(Ordering::Relaxed);
                // 裁掉就会丢掉「进入备用屏幕」那个起点：客户端就进不了备用屏幕，
                // TUI 的重绘会画到主屏上，画面就乱了。
                // 所以在硬上限之前先不裁，保留完整的一次 TUI 会话。
                let alt_would_be_cut = alt_idx != usize::MAX && alt_idx < excess;
                if !(alt_would_be_cut && replay.len() < REPLAY_HARD_CAP) {
                    // 裁剪点必须落在转义序列边界上，否则客户端会把半条序列
                    // 当成普通文本打印出来（README §7 承诺按序列边界裁剪）。
                    // 判断不出来时退回按字节裁，保证缓冲区不会无限增长。
                    // 裁剪点要落在序列边界上，所以可能比 excess 稍大；
                    // 但绝不能裁到刚写进来的这一块里（否则下面算 start 会下溢 panic，
                    // release 是 panic = abort，一次就越界把服务打死）。
                    let max_cut = replay.len().saturating_sub(data.len());
                    let cut = match safe_cut_point(&replay, excess) {
                        Some(c) => c,
                        None => {
                            crate::log_warn!(
                                "会话 {} 的回放缓冲区头部存在无法识别的转义序列，按字节裁剪",
                                self.id
                            );
                            excess
                        }
                    }
                    .min(max_cut);
                    replay.drain(..cut);
                    let idx = self.alt_enter_idx.load(Ordering::Relaxed);
                    let new_idx = if idx == usize::MAX {
                        usize::MAX
                    } else {
                        idx.saturating_sub(cut)
                    };
                    self.alt_enter_idx.store(new_idx, Ordering::Relaxed);
                }
            }
            let start = replay.len().saturating_sub(data.len());
            // 记录累计输出量：AI agent 用它给「命令执行前后的输出」打边界
            self.total_out
                .fetch_add(data.len() as u64, Ordering::Relaxed);
            self.replay_dropped.store(
                self.total_out
                    .load(Ordering::Relaxed)
                    .saturating_sub(replay.len() as u64),
                Ordering::Relaxed,
            );
            start
        };
        self.track_terminal_queries(&data);
        self.detect_alt_screen(&data, base);
        let frame = Bytes::from(proto::frame(proto::S_OUTPUT, &data));
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        // 队列满说明客户端消费不过来，直接断开让它重连并回放，避免拖慢其它标签页。
        let before = clients.len();
        clients.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
        let dropped = before - clients.len();
        if dropped > 0 {
            crate::log_warn!(
                "会话 {} 有 {} 个客户端消费不过来，已断开（请重连回放）",
                self.id,
                dropped
            );
        }
    }

    /// 扫描输出，跟踪是否进入了/离开了备用屏幕。
    ///
    /// 全屏 TUI 程序会切到备用屏幕并持续重绘。
    /// 这些重绘字节如果原样回放，轻则画面错乱，重则被回放上限截断在
    /// 转义序列中间，把终端状态彻底搞坏。所以必须知道当前处于哪种模式。
    ///
    /// **跨块处理**：`ESC[?1049h` 有 8 字节，PTY 一次读出来的块边界完全可能
    /// 把它劈成两半。只在单块里扫会漏判备用屏幕状态，重连后 TUI 画面就乱/空白。
    /// 所以这里把上一块尾部（最多 `MAX_ALT_SEQ_LEN - 1` 字节）带过来一起扫。
    fn detect_alt_screen(&self, chunk: &[u8], base: usize) {
        let tail = {
            let mut t = self.alt_tail.lock().unwrap_or_else(|e| e.into_inner());
            if t.is_empty() && !chunk.contains(&0x1b) {
                // 快路径：整块输出里没有任何 ESC，不可能出现备用屏幕序列。
                // 避免给每一块普通输出都额外分配 + 拷贝一次缓冲区。
                return;
            }
            std::mem::take(&mut *t)
        };
        let tail_len = tail.len();
        let mut buf: Vec<u8> = Vec::with_capacity(tail_len + chunk.len());
        buf.extend_from_slice(&tail);
        buf.extend_from_slice(chunk);

        let mut pos = 0usize;
        while pos < buf.len() {
            let mut hit: Option<(usize, usize, bool)> = None; // (位置, 长度, 是否进入)
            for (seqs, entering) in [(ALT_ENTER, true), (ALT_LEAVE, false)] {
                for seq in seqs {
                    if let Some(i) = find_bytes(&buf[pos..], seq) {
                        let at = pos + i;
                        if hit.map_or(true, |(b, _, _)| at < b) {
                            hit = Some((at, seq.len(), entering));
                        }
                    }
                }
            }
            let Some((at, len, entering)) = hit else { break };
            if entering {
                self.alt_screen.store(true, Ordering::Relaxed);
                // at 可能落在上一块残留的尾巴里，换算回回放缓冲区的绝对下标
                let abs = if at >= tail_len {
                    base + (at - tail_len)
                } else {
                    base.saturating_sub(tail_len - at)
                };
                self.alt_enter_idx.store(abs, Ordering::Relaxed);
            } else {
                self.alt_screen.store(false, Ordering::Relaxed);
                self.alt_enter_idx.store(usize::MAX, Ordering::Relaxed);
            }
            pos = at + len;
        }

        // 留住尾巴，下一块接着用
        let keep = buf.len().min(MAX_ALT_SEQ_LEN - 1);
        let mut t = self.alt_tail.lock().unwrap_or_else(|e| e.into_inner());
        *t = buf[buf.len() - keep..].to_vec();
    }

    /// 子进程退出：记录退出码并通知客户端。
    fn on_child_exit(&self, info: ExitInfo) {
        // 只报告一次：写线程失败和子进程回收都可能走到这里。
        {
            let mut exit = self.exit.lock().unwrap_or_else(|e| e.into_inner());
            if exit.is_some() {
                return;
            }
            *exit = Some(info.clone());
        }
        self.alive.store(false, Ordering::Relaxed);

        let payload = serde_json::to_vec(&info).unwrap_or_default();
        let frame = Bytes::from(proto::frame(proto::S_EXIT, &payload));
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        clients.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
        // 子进程已经退出：把客户端连接全部释放掉。
        // 否则 WebSocket 会一直挂着（前端收到 S_EXIT 也不会主动断开），
        // 这个死会话会一直占着 max_sessions 的名额，反复 exit 就会把名额耗光。
        clients.clear();
    }

    /// 挂载一个客户端。
    ///
    /// 回放策略分两种：
    /// - 普通 shell：回放缓冲区全部内容（按行边界截断，避免半条转义序列）；
    /// - 全屏 TUI（处于备用屏幕）：**只回放进入备用屏幕之前的内容**，
    ///   由调用方重置终端并让 TUI 自己重绘——原始重绘流回放出来只会是乱码。
    pub fn attach(self: &Arc<Self>) -> AttachInfo {
        let (tx, rx) = mpsc::channel::<Bytes>(CLIENT_QUEUE);
        let cid = self.client_seq.fetch_add(1, Ordering::Relaxed) + 1;
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push((cid, tx));
        self.ever_attached.store(true, Ordering::Relaxed);
        self.touch();

        let alt_screen = self.alt_screen.load(Ordering::Relaxed);
        let (replay, need_alt_enter) = {
            let buf = self.replay.lock().unwrap_or_else(|e| e.into_inner());
            // alt_enter_idx 还有效，说明回放里带着「进入备用屏幕」那个起点，
            // 客户端直接回放即可；起点被裁掉了才需要客户端自己补一条。
            let has_entry = self.alt_enter_idx.load(Ordering::Relaxed) != usize::MAX;
            // 整段回放 = 断线重连后恢复屏幕所需的全部历史。
            // （不能只回放「挂载之后」的新增部分，否则重连的页面会一片空白。）
            (trim_to_safe(&buf), alt_screen && !has_entry)
        };

        AttachInfo {
            cid,
            rx,
            replay,
            alt_screen,
            need_alt_enter,
        }
    }

    /// 卸载客户端。
    pub fn detach(&self, cid: u64) {
        self.clients
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|(id, _)| *id != cid);
        self.touch();
    }

    /// 写入终端输入。
    ///
    /// 不能无限期等待：输入队列是有界的（1024 条），PTY 写不动时
    /// （前台程序不读 stdin、或粘贴了超大段文本）队列会填满，
    /// 这里就会一直挂着 —— 而调用方是 WebSocket 的事件循环，
    /// 一旦卡住，输出转发和心跳都会停，前端表现为「终端卡死」。
    /// 所以这里加超时：超时后放弃这次输入并报错，让前端知道发生了什么。
    pub async fn write_input(&self, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        match tokio::time::timeout(Duration::from_secs(2), self.input_tx.send(data)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(_)) => Err("会话已结束".to_string()),
            Err(_) => Err("终端输入阻塞：程序没有在读取输入".to_string()),
        }
    }

    /// 当前前台进程组身份：`(pgid, 进程组组长 /proc starttime)`。
    ///
    /// 只比较 pgid 不够：进程退出后 pgid 可能被复用；starttime 是内核
    /// 分配的单调值，可以区分「同一个 pgid 换了一个进程」。
    fn foreground_identity(&self) -> Option<(i32, u64)> {
        let master = self.master.lock().unwrap_or_else(|e| e.into_inner());
        let fd = master.as_raw_fd()?;
        if fd < 0 {
            return None;
        }
        let pgid = unsafe { libc::tcgetpgrp(fd) };
        if pgid <= 0 {
            return None;
        }
        drop(master);
        let start = proc_start_time(pgid as u32)?;
        Some((pgid, start))
    }

    /// 查询发生时，记录“谁有能力读取这个应答”。
    fn query_recipient(&self, foreground: Option<(i32, u64)>) -> Option<QueryRecipient> {
        let (pgid, start) = foreground?;
        if Some(pgid as u32) == self.pid {
            // 前台是 shell：可能由命令替换/提示符工具在 shell 进程组里查询。
            // 记录同进程组的子进程；如果连一个都没有，说明查询者已经退出，
            // 此时绝不能把应答写回 shell 的键盘输入。
            let children = shell_group_children(pgid as u32);
            if children.is_empty() {
                None
            } else {
                Some(QueryRecipient::ShellChildren {
                    shell_pgid: pgid,
                    children,
                })
            }
        } else {
            Some(QueryRecipient::Foreground { pgid, start })
        }
    }

    /// 扫描 PTY 输出里的 OSC 4/10/11/12 与 DA 查询。
    ///
    /// 扫描发生在把输出发给客户端**之前**，所以客户端 xterm.js 生成应答时，
    /// 服务端一定已经有一条对应的待匹配查询记录。
    fn track_terminal_queries(&self, data: &[u8]) {
        let mut queries = Vec::new();
        {
            let mut scanner = self
                .query_scanner
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            scanner.feed(data, |kind| queries.push(kind));
        }
        if queries.is_empty() {
            return;
        }

        let foreground = self.foreground_identity();
        let recipient = self.query_recipient(foreground);
        let now = Instant::now();
        let mut pending = self
            .pending_queries
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        pending.retain(|q| now.duration_since(q.at) <= TERMINAL_QUERY_TTL);

        for kind in queries {
            match &recipient {
                Some(recipient) => {
                    if pending.len() >= MAX_PENDING_QUERIES {
                        pending.remove(0);
                    }
                    pending.push(PendingTerminalQuery {
                        kind,
                        recipient: recipient.clone(),
                        at: now,
                    });
                    crate::log_debug!(
                        "终端查询已记录: {} recipient={:?}",
                        kind.label(),
                        recipient
                    );
                }
                None => {
                    // 查询来自 shell 自身或已退出的程序：无法确认接收者，直接丢弃。
                    crate::log_debug!("终端查询已丢弃（无法确认接收者）: {}", kind.label());
                }
            }
        }
    }

    /// 前端把 xterm.js 自动生成的查询应答送回来时调用。
    ///
    /// 只有同时满足以下条件的应答才写进 PTY：
    ///   1. 能找到一条尚未过期的同类查询；
    ///   2. 查询时记录的前台进程组/子进程仍然存活且仍在读这个 PTY；
    ///   3. 应答本身能完整解析。
    /// 其余情况一律丢弃，绝不落到 Shell 的 stdin。
    pub async fn write_terminal_response(&self, data: Vec<u8>) -> Result<(), String> {
        let parts = parse_terminal_response(&data);
        if parts.is_empty() {
            crate::log_debug!(
                "终端应答已丢弃（无法解析）: {}",
                preview_bytes(&data, 120)
            );
            return Ok(());
        }

        let current = self.foreground_identity();
        let now = Instant::now();
        let mut allowed = Vec::new();
        {
            let mut pending = self
                .pending_queries
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pending.retain(|q| now.duration_since(q.at) <= TERMINAL_QUERY_TTL);

            for (kind, bytes) in parts {
                let matched = pending.iter().position(|q| {
                    q.kind == kind && recipient_matches(&q.recipient, current)
                });
                match matched {
                    Some(index) => {
                        let query = pending.remove(index);
                        crate::log_debug!(
                            "终端应答已放行: {} -> {:?} data={}",
                            kind.label(),
                            query.recipient,
                            preview_bytes(&bytes, 120)
                        );
                        allowed.extend_from_slice(&bytes);
                    }
                    None => {
                        crate::log_debug!(
                            "终端应答已丢弃: {}（没有匹配查询，或发起程序已退出/切到后台）",
                            kind.label()
                        );
                    }
                }
            }
        }

        if allowed.is_empty() {
            return Ok(());
        }
        self.write_input(allowed).await
    }

    /// 调整 PTY 尺寸。
    pub fn resize(&self, cols: u16, rows: u16) {
        if cols == 0 || rows == 0 {
            return;
        }
        let mut size = self.size.lock().unwrap_or_else(|e| e.into_inner());
        if size.cols == cols && size.rows == rows {
            return;
        }
        size.cols = cols;
        size.rows = rows;
        let master = self.master.lock().unwrap_or_else(|e| e.into_inner());
        let _ = master.resize(*size);
        drop(master);
        drop(size);
        self.touch();
    }

    /// 给 PTY 的**前台进程组**发信号。
    ///
    /// 用 tcgetpgrp 取真正的前台进程组，而不是会话的 pid：
    /// shell 会把自己的子进程放到新的进程组，tcsetpgrp 之后两者就不一样了。
    pub fn notify_foreground(&self, signo: libc::c_int) {
        let master = self.master.lock().unwrap_or_else(|e| e.into_inner());
        let Some(fd) = master.as_raw_fd() else { return };
        if fd < 0 {
            return;
        }
        let fg = unsafe { libc::tcgetpgrp(fd) };
        if fg > 0 {
            unsafe {
                libc::killpg(fg, signo);
            }
        }
    }

    /// 结束会话：先杀进程组，再杀子进程。
    /// 结束会话：把整个终端进程树（shell、前台 TUI、后台作业、nohup 出去的进程）
    /// 一起收掉，并让读线程在 1 秒内自行退出。
    ///
    /// 为什么不能只杀 shell：交互式 shell 开了作业控制，每条命令 / 后台作业
    /// 都有自己的进程组，`killpg(shell_pid)` 只打在 shell 自己那一组上；
    /// 旧实现里 `sleep 999 &` 这类后台作业在标签页关掉后仍然活着（已实际复现）。
    /// 现在按「会话 id + environ 标记」扫 /proc，整棵树一起清。
    pub fn kill(&self) {
        self.kill_inner(true);
    }

    fn kill_inner(&self, scan_tree: bool) {
        // 幂等：写线程失败与 DELETE / 回收 / 服务停止都可能调到 kill()
        if self.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.alive.store(false, Ordering::Relaxed);
        // 先置 shutdown：读线程在 poll 超时后会自己退出（即使还有进程占着 slave）
        self.shutdown.store(true, Ordering::Relaxed);

        if let Some(pid) = self.pid {
            // 1) 先拿到整棵树的 pid 列表（扫描期间 shell 可能还在 fork，
            //    所以后面还会补一次 killpg）
            if scan_tree {
                let targets = vec![(pid, self.marker.clone())];
                kill_session_processes(&targets);
            }
            // 2) 只有确认该进程仍是进程组组长时才 killpg，避免 PID 复用误杀无关进程组。
            if process_group_of(pid) == Some(pid as i32) {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
            }
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
        // 3) portable-pty 的 killer（Unix 上是 SIGHUP）兼容无 /proc 的环境
        if let Some(mut killer) = self.killer.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = killer.kill();
        }
        crate::log_info!(
            "会话 {} 已结束 (pid={}, replay={}KB)",
            self.id,
            self.pid.unwrap_or(0),
            self.replay_len() / 1024
        );
    }

    /// 把回放缓冲区裁到 `cap` 以内（用于长期无客户端会话的内存回收）。
    pub fn trim_replay(&self, cap: usize) {
        let mut replay = self.replay.lock().unwrap_or_else(|e| e.into_inner());
        if replay.len() <= cap {
            return;
        }
        let excess = replay.len() - cap;
        let cut = safe_cut_point(&replay, excess).unwrap_or(excess).min(replay.len());
        if cut == 0 {
            return;
        }
        replay.drain(..cut);
        let idx = self.alt_enter_idx.load(Ordering::Relaxed);
        let new_idx = if idx == usize::MAX {
            usize::MAX
        } else {
            idx.saturating_sub(cut)
        };
        self.alt_enter_idx.store(new_idx, Ordering::Relaxed);
        let total = self.total_out.load(Ordering::Relaxed);
        self.replay_dropped
            .store(total.saturating_sub(replay.len() as u64), Ordering::Relaxed);
    }

    /// 回放缓冲区当前字节数（诊断用）。
    pub fn replay_len(&self) -> usize {
        self.replay
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// 读线程是否应该退出。
    fn shutting_down(&self) -> bool {
        self.shutdown.load(Ordering::Relaxed)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn size(&self) -> (u16, u16) {
        let size = self.size.lock().unwrap_or_else(|e| e.into_inner());
        (size.cols, size.rows)
    }

    #[allow(dead_code)]
    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    pub fn touch(&self) {
        *self.last_active.lock().unwrap_or_else(|e| e.into_inner()) = Instant::now();
    }

    pub fn idle_for(&self) -> Duration {
        Instant::now().duration_since(*self.last_active.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// 取回放缓冲区末尾的一段**纯文本**（去掉 ANSI 控制序列），供 AI 助手当上下文。
    ///
    /// `max_bytes` 限制从缓冲区尾部取多少原始字节（缓冲区里混着大量转义序列，
    /// 直接全取会把提示词撑爆），`max_chars` 再限制最终字符数。
    #[cfg(feature = "ai")]
    pub fn tail_text(&self, max_bytes: usize, max_chars: usize) -> String {
        let raw = {
            let buf = self.replay.lock().unwrap_or_else(|e| e.into_inner());
            let start = buf.len().saturating_sub(max_bytes);
            buf[start..].to_vec()
        };
        let text = strip_ansi(&String::from_utf8_lossy(&raw));
        // 去掉行尾空白，并压掉连续空行，减少无意义的 token
        let mut cleaned = String::with_capacity(text.len());
        let mut blank_run = 0;
        for line in text.lines() {
            let trimmed = line.trim_end();
            if trimmed.trim().is_empty() {
                blank_run += 1;
                if blank_run > 1 {
                    continue;
                }
            } else {
                blank_run = 0;
            }
            cleaned.push_str(trimmed);
            cleaned.push('\n');
        }
        let chars: Vec<char> = cleaned.chars().collect();
        if chars.len() <= max_chars {
            return cleaned;
        }
        chars[chars.len() - max_chars..].iter().collect()
    }

    /// 累计写出的字节数（单调递增，用作输出位置游标）。
    #[cfg(feature = "ai")]
    pub fn output_seq(&self) -> u64 {
        self.total_out.load(Ordering::Relaxed)
    }

    /// 取 `from` 之后新产生的输出（已去 ANSI 的纯文本）。
    ///
    /// 回放缓冲区有上限，太旧的位置会被丢弃，此时返回缓冲区里能拿到的全部。
    #[cfg(feature = "ai")]
    pub fn output_since(&self, from: u64) -> String {
        let dropped = self.replay_dropped.load(Ordering::Relaxed);
        let replay = self.replay.lock().unwrap_or_else(|e| e.into_inner());
        let skip = from.saturating_sub(dropped) as usize;
        if skip >= replay.len() {
            return String::new();
        }
        let slice = &replay[skip..];
        strip_ansi(&String::from_utf8_lossy(slice))
    }

    /// 这条会话是否支持「提示符完成标记」。
    ///
    /// 标记由 `PROMPT_COMMAND` 在**每条命令结束后、提示符显示前**输出，
    /// 因此它比「输出安静了 900ms」可靠得多：命令中途暂停输出（apt、docker
    /// pull、编译）不会被误判成执行完成，`cd` / `export` 这类没有输出的
    /// 命令也不会一直等到超时。
    #[cfg(feature = "ai")]
    pub fn supports_prompt_marker(&self) -> bool {
        shell_is_bash(&self.shell)
    }

    /// 本次会话的提示符标记前缀（不含进程退出码）。
    #[cfg(feature = "ai")]
    pub fn prompt_marker_prefix(&self) -> String {
        prompt_marker_prefix(&self.id)
    }

    /// 标记是否由**本会话的顶层 shell** 产生。
    ///
    /// 嵌套 shell 会继承 `PROMPT_COMMAND`，如果它一启动就发标记，agent 会误以为
    /// `bash` 这条命令已经结束，把下一条命令写进嵌套 shell 里。标记里带 shell 的
    /// `$$`，只接受与 `Session.pid` 一致的那一个。
    #[cfg(feature = "ai")]
    fn marker_owner_matches(&self, pid: Option<u32>) -> bool {
        match (self.pid, pid) {
            (Some(expected), Some(actual)) => expected == actual,
            (None, _) => true,
            (Some(_), None) => false,
        }
    }

    /// 等这条会话回到 shell 提示符，并取回命令输出与退出码。
    ///
    /// 与 `wait_quiet` 的区别：这是**确定性的完成判断**，不是靠猜。
    /// `PROMPT_COMMAND` 会在命令结束后输出
    /// `ESC ] 1337 ; nas-webterm-prompt:<会话 id> ; <shell pid> ; <退出码> BEL`，
    /// 这里在回放缓冲里等这个序列；它只会由 shell 自己产生，命令输出里
    /// 即使出现同样的文字也不会被误认（标记带 128 位随机会话 id）。
    ///
    /// 返回 `(输出, 退出码, 是否超时)`。超时时输出只包含已读到的部分；
    /// 调用方必须再发 Ctrl+C，避免下一条命令被正在运行的程序吃掉。
    #[cfg(feature = "ai")]
    pub async fn wait_for_prompt(
        &self,
        from: u64,
        timeout_ms: u64,
    ) -> (String, Option<i32>, bool) {
        let needle = self.prompt_marker_prefix();
        let start = Instant::now();
        // 已经扫到哪个绝对输出位置。只扫描新增部分，避免每秒把 1MB 回放
        // 缓冲重新复制一遍；needle 可能跨读块，所以回退 needle.len()-1 字节。
        let mut scanned = from;
        let mut first_poll = true;
        loop {
            tokio::time::sleep(Duration::from_millis(60)).await;

            let found = {
                let dropped = self.replay_dropped.load(Ordering::Relaxed);
                let replay = self.replay.lock().unwrap_or_else(|e| e.into_inner());
                // 第一次只看 from 之后；之后的轮次才回退 needle.len()-1 字节，
                // 否则会把 from 之前刚结束的旧提示符标记误当成本次命令结束。
                let begin = if first_poll {
                    scanned.saturating_sub(dropped) as usize
                } else {
                    scanned
                        .saturating_sub(dropped)
                        .saturating_sub(needle.len().saturating_sub(1) as u64)
                        as usize
                };
                let begin = begin.min(replay.len());
                let mut search = begin;
                let mut hit = None;
                while let Some(rel) = find_bytes(&replay[search..], needle.as_bytes()) {
                    let pos = search + rel;
                    // 回放缓冲被裁过时 from 可能落在已丢弃的头部；这时不能把
                    // 旧提示符标记当成本次命令结束，只接受 from 之后的位置。
                    if dropped + (pos as u64) < from {
                        search = pos + needle.len();
                        continue;
                    }
                    let value_start = pos + needle.len();
                    let Some(end) = replay[value_start..].iter().position(|&b| b == 0x07) else {
                        break;
                    };
                    let raw = &replay[value_start..value_start + end];
                    if let Ok(raw) = std::str::from_utf8(raw) {
                        let mut parts = raw.trim().splitn(2, ';');
                        if let (Some(pid), Some(code)) = (parts.next(), parts.next()) {
                            if let (Ok(pid), Ok(code)) =
                                (pid.trim().parse::<u32>(), code.trim().parse::<i32>())
                            {
                                // 只接受顶层 shell 产生的标记：嵌套 shell 也会继承
                                // PROMPT_COMMAND，但它不是这条命令的执行者。
                                if self.marker_owner_matches(Some(pid)) {
                                    let text_start = from.saturating_sub(dropped) as usize;
                                    let text = strip_ansi(&String::from_utf8_lossy(
                                        &replay[text_start.min(pos)..pos],
                                    ));
                                    hit = Some((text, Some(code), dropped + replay.len() as u64));
                                    break;
                                }
                            }
                        }
                    }
                    search = pos + needle.len();
                }
                hit
            };

            if let Some((text, code, _next_scanned)) = found {
                return (text, code, false);
            }
            scanned = {
                let dropped = self.replay_dropped.load(Ordering::Relaxed);
                (dropped + self.replay.lock().unwrap_or_else(|e| e.into_inner()).len() as u64)
                    .max(scanned)
            };
            first_poll = false;

            if start.elapsed() >= Duration::from_millis(timeout_ms) {
                return (self.output_since(from), None, true);
            }
            // 会话已经结束就不用再等了
            if !self.is_alive() {
                return (self.output_since(from), None, false);
            }
        }
    }

    /// 等这条会话「安静下来」：连续 `idle_ms` 没有新输出，或超过 `timeout_ms`。
    ///
    /// **仅作为非 bash shell 的兜底**。它是启发式判断：命令中途停顿超过
    /// `idle_ms` 就会被误判成执行完成，从而把下一条命令写进还在运行的程序。
    /// bash 会话一律用 `wait_for_prompt`。
    #[cfg(feature = "ai")]
    pub async fn wait_quiet(&self, from: u64, idle_ms: u64, timeout_ms: u64) -> (String, u64, bool) {
        let start = std::time::Instant::now();
        let mut last = self.output_seq();
        let mut last_change = std::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(80)).await;
            let cur = self.output_seq();
            if cur != last {
                last = cur;
                last_change = std::time::Instant::now();
            } else if cur > from
                && last_change.elapsed() >= Duration::from_millis(idle_ms)
            {
                let text = self.output_since(from);
                return (text, cur, false);
            }
            if start.elapsed() >= Duration::from_millis(timeout_ms) {
                let text = self.output_since(from);
                return (text, self.output_seq(), true);
            }
            // 会话已经结束就不用再等了
            if !self.is_alive() {
                let text = self.output_since(from);
                return (text, self.output_seq(), false);
            }
        }
    }

    pub fn info(&self) -> SessionInfo {
        let (cols, rows) = self.size();
        SessionInfo {
            id: self.id.clone(),
            shell: self.shell.clone(),
            cwd: self.cwd.clone(),
            pid: self.pid,
            cols,
            rows,
            clients: self.client_count(),
            alive: self.is_alive(),
            alt_screen: self.alt_screen.load(Ordering::Relaxed),
            created: self.created.elapsed().as_secs(),
            replay_bytes: self.replay_len(),
        }
    }
}

/// 读取 `/proc/<pid>/stat` 中 comm 之后的字段（comm 里可能有空格/括号，
/// 所以从最后一个 `)` 之后开始切）。
fn proc_stat_fields(pid: u32) -> Option<Vec<String>> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let rest = stat.get(stat.rfind(')')? + 1..)?.trim();
    Some(rest.split_whitespace().map(|s| s.to_string()).collect())
}

/// 进程的 /proc starttime（第 22 个字段）。
fn proc_start_time(pid: u32) -> Option<u64> {
    proc_stat_fields(pid)?.get(19)?.parse().ok()
}

/// 进程所在进程组（第 5 个字段）。
fn proc_pgrp(pid: u32) -> Option<i32> {
    proc_stat_fields(pid)?.get(2)?.parse().ok()
}

/// 进程所属会话 id（第 6 个字段）。
///
/// portable-pty 在 exec 前调了 setsid()，所以 shell 是会话首领，
/// 它的子孙（含前台 TUI、后台作业）默认都继承这个会话 id，
/// 除非它们自己再 setsid。
fn proc_session(pid: u32) -> Option<i32> {
    proc_stat_fields(pid)?.get(3)?.parse().ok()
}

/// `/proc/<pid>/environ` 里是否有 `KEY=VALUE`。
///
/// environ 是 exec 时的初始环境，子进程 setenv 不会改变它，
/// 所以这个标记能稳定地跟上整棵进程树（包括 setsid 逃跑的守护进程）。
fn proc_environ_has(pid: u32, key: &str, value: &str) -> bool {
    let Ok(raw) = std::fs::read(format!("/proc/{pid}/environ")) else {
        return false;
    };
    let mut needle = Vec::with_capacity(key.len() + value.len() + 1);
    needle.extend_from_slice(key.as_bytes());
    needle.push(b'=');
    needle.extend_from_slice(value.as_bytes());
    raw.split(|b| *b == 0).any(|item| item == needle.as_slice())
}

/// 杀掉给定会话的所有进程（一次 /proc 扫描）。
///
/// 匹配条件（满足任一即可）：
///   * 进程就是会话首领本身；
///   * 进程的 session id 等于会话首领 pid（子孙进程）；
///   * 进程环境里的 `NAS_WEBTERM_SESSION` 等于该会话的标记（setsid 逃跑的也能找到）。
///
/// 永远不会杀 pid 1 和本进程自己。
fn kill_session_processes(targets: &[(u32, String)]) {
    if targets.is_empty() {
        return;
    }
    let self_pid = std::process::id();
    let mut victims: Vec<i32> = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        // 没有 /proc 只能退回按 pid 杀（调用方还会补 killpg）
        for (pid, _) in targets {
            victims.push(*pid as i32);
        }
        for pid in victims {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        return;
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if pid <= 1 || pid == self_pid {
            continue;
        }
        let sid = proc_session(pid);
        let mut hit = false;
        for (leader, marker) in targets {
            if pid == *leader || sid == Some(*leader as i32) {
                hit = true;
                break;
            }
            if !marker.is_empty() && proc_environ_has(pid, SESSION_ENV, marker) {
                hit = true;
                break;
            }
        }
        if hit {
            victims.push(pid as i32);
        }
    }
    for pid in victims {
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// 服务启动时清理上一次运行留下的孤儿终端进程。
///
/// 场景：服务被 panic / OOM / SIGKILL 干掉（panic = abort，没有析构），
/// PTY 里的 shell 与后台作业会变成孤儿继续跑，占内存、占端口、占 root 权限。
/// 这里按「安装实例标记」扫一遍 /proc：本进程刚启动，不可能有它自己的子进程带这个标记，
/// 所以命中者一定是同一个安装上一次运行残留的（另一个实例的标记不同，不会被误杀）。
///
/// 返回清理的进程数。
///
/// 注意：调用方必须先确认本应用没有第二个实例在运行（unix socket 已绑定成功）。
pub fn kill_orphan_processes(instance_tag: &str) -> usize {
    if instance_tag.is_empty() {
        return 0;
    }
    let self_pid = std::process::id();
    let mut victims: Vec<i32> = Vec::new();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return 0;
    };
    for entry in dir.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<u32>().ok()) else {
            continue;
        };
        if pid <= 1 || pid == self_pid {
            continue;
        }
        // 先看进程树里有没有本应用标记（父进程是 shell 也算）
        let Some(marker) = proc_env_value(pid, APP_ENV) else {
            continue;
        };
        if marker != instance_tag {
            continue;
        }
        victims.push(pid as i32);
    }
    // 先 SIGTERM 给一次体面退出的机会，再 SIGKILL 收尾
    for pid in &victims {
        unsafe {
            libc::kill(*pid, libc::SIGTERM);
        }
    }
    if !victims.is_empty() {
        std::thread::sleep(Duration::from_millis(150));
    }
    for pid in &victims {
        unsafe {
            libc::kill(*pid, libc::SIGKILL);
        }
    }
    victims.len()
}

/// 读 `/proc/<pid>/environ` 里某个键的值。
fn proc_env_value(pid: u32, key: &str) -> Option<String> {
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    let mut prefix = Vec::with_capacity(key.len() + 1);
    prefix.extend_from_slice(key.as_bytes());
    prefix.push(b'=');
    raw.split(|b| *b == 0)
        .find(|item| item.starts_with(&prefix))
        .map(|item| String::from_utf8_lossy(&item[prefix.len()..]).to_string())
}

/// shell 进程组里还活着的直接子进程（提示符主题工具、命令替换等）。
fn shell_group_children(shell_pgid: u32) -> Vec<(u32, u64)> {
    let path = format!("/proc/{shell_pgid}/task/{shell_pgid}/children");
    let Ok(list) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    list.split_whitespace()
        .filter_map(|s| s.parse::<u32>().ok())
        .filter(|pid| proc_pgrp(*pid) == Some(shell_pgid as i32))
        .filter_map(|pid| proc_start_time(pid).map(|start| (pid, start)))
        .collect()
}

/// 判断查询时记录的接收者是否仍然可能是当前终端输入的读者。
fn recipient_matches(recipient: &QueryRecipient, current: Option<(i32, u64)>) -> bool {
    let Some((pgid, start)) = current else {
        return false;
    };
    match recipient {
        QueryRecipient::Foreground {
            pgid: want_pgid,
            start: want_start,
        } => *want_pgid == pgid && *want_start == start,
        QueryRecipient::ShellChildren {
            shell_pgid,
            children,
        } => {
            *shell_pgid == pgid
                && children.iter().any(|(pid, want_start)| {
                    proc_start_time(*pid) == Some(*want_start)
                        && proc_pgrp(*pid) == Some(*shell_pgid)
                })
        }
    }
}

/// 日志里展示一小段转义序列内容（不把原始控制字符写进日志文件）。
fn preview_bytes(data: &[u8], max_chars: usize) -> String {
    let text = String::from_utf8_lossy(data);
    let mut out: String = text.chars().take(max_chars).flat_map(|c| c.escape_debug()).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

pub struct SessionManager {
    cfg: Config,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    seq: AtomicU64,
}

impl SessionManager {
    pub fn new(cfg: Config) -> Arc<Self> {
        Arc::new(SessionManager {
            cfg,
            sessions: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        })
    }

    /// 本进程的配置（供测试与诊断使用）
    #[allow(dead_code)]
    pub fn config(&self) -> &Config {
        &self.cfg
    }

    fn next_id(&self) -> String {
        let n = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        // 128 位随机后缀：会话 id 可以直接用来接管别人的终端（root shell），
        // 32 位随机既容易被枚举，碰撞概率也不再可忽略。
        format!(
            "s{}-{:08x}{:08x}{:08x}{:08x}",
            n,
            random_u32(),
            random_u32(),
            random_u32(),
            random_u32()
        )
    }

    pub fn create(
        &self,
        startup: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Session>, String> {
        // 容量检查与「腾名额」放在同一个临界区里。
        //
        // 名额满了的时候，优先回收**没有任何客户端连接**的孤儿会话
        // （前端异常断开、页面刷新、重启标签页没删旧会话等都会留下这种残留）。
        // 否则几次误操作就能占满 max_sessions，整个应用彻底不可用，
        // 而用户只能去重启服务。
        let evicted = {
            let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() >= self.cfg.max_sessions {
                // 最老的孤儿会话优先淘汰。
                // 注意方向：`created.elapsed()` 是「已经过去多久」，
                // 越老的会话这个值越大，所以要取 max 才是最老的那个
                // （用 min 会淘汰掉刚建的那个，用户反而丢不掉真正没人要的残留）。
                let victim = guard
                    .iter()
                    .filter(|(_, s)| s.client_count() == 0)
                    .max_by_key(|(_, s)| s.created.elapsed())
                    .map(|(id, _)| id.clone());
                match victim {
                    Some(id) => guard.remove(&id),
                    None => return Err(limit_error(self.cfg.max_sessions)),
                }
            } else {
                None
            }
        };
        if let Some(s) = evicted {
            crate::log_warn!(
                "会话数已达上限（{} 个），回收无人连接的会话 {}",
                self.cfg.max_sessions,
                s.id
            );
            s.kill();
        }

        let id = self.next_id();
        let session = Session::spawn(&self.cfg, id.clone(), cols, rows, startup)?;
        // 权威判断：创建 PTY 需要时间，这期间可能有别的请求把名额占满，
        // 所以「检查 + 插入」必须在同一个临界区里，否则并发下会突破上限。
        {
            let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() >= self.cfg.max_sessions {
                drop(guard);
                // 名额没了：刚创建的进程不能留着白占资源
                session.kill();
                crate::log_warn!(
                    "会话数已达上限（{} 个），拒绝创建新会话 {}",
                    self.cfg.max_sessions,
                    id
                );
                return Err(limit_error(self.cfg.max_sessions));
            }
            guard.insert(id.clone(), session.clone());
        }
        crate::log_info!(
            "会话已创建：{} (pid={}, shell={}, {}x{})",
            id,
            session.pid.unwrap_or(0),
            session.shell,
            cols,
            rows
        );
        Ok(session)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let mut list: Vec<SessionInfo> = guard.values().map(|s| s.info()).collect();
        list.sort_by(|a, b| a.created.cmp(&b.created));
        list
    }

    /// 结束并移除一个会话。
    pub fn kill(&self, id: &str) -> bool {
        let removed = self
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
        match removed {
            Some(s) => {
                s.kill();
                true
            }
            None => false,
        }
    }

    /// 关停服务时结束全部会话。
    ///
    /// 服务收到 SIGTERM 后必须把 PTY 里的 shell 一起收掉，否则会出现两个问题：
    ///   1. shell 变成孤儿进程，继续挂在后台跑；
    ///   2. tokio 运行时析构时要等待所有 spawn_blocking 任务结束，而读写线程
    ///      阻塞在 `input_rx.blocking_recv()` / `reader.read()` 上，永远等不到，
    ///      进程就会卡住不退出，最后被 fnOS 用 SIGKILL 强杀（线上日志里的
    ///      "force killing webterm" 就是这么来的）。
    pub fn kill_all(&self) {
        let sessions: Vec<Arc<Session>> = {
            let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            guard.drain().map(|(_, s)| s).collect()
        };
        if sessions.is_empty() {
            return;
        }
        crate::log_info!("正在结束 {} 个会话", sessions.len());
        // 先把所有会话的「首领 pid + 标记」收齐，再只扫描一次 /proc：
        // 否则 32 个会话 × 每次全表扫描，停机要多花好几百毫秒。
        let targets: Vec<(u32, String)> = sessions
            .iter()
            .filter_map(|s| s.pid.map(|pid| (pid, s.marker.clone())))
            .collect();
        for s in &sessions {
            s.shutdown.store(true, Ordering::Relaxed);
            s.alive.store(false, Ordering::Relaxed);
        }
        kill_session_processes(&targets);
        for s in &sessions {
            s.kill_inner(false);
        }
    }

    /// 会话数 / 客户端数 / 回放缓冲总字节数（`/api/healthz` 用，便于排查内存）。
    pub fn stats(&self) -> (usize, usize, usize) {
        let guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        let mut clients = 0usize;
        let mut bytes = 0usize;
        for s in guard.values() {
            clients += s.client_count();
            bytes += s.replay_len();
        }
        (guard.len(), clients, bytes)
    }

    /// 清理已退出且没有客户端连接的会话。
    ///
    /// **不按时间杀会话**：`idle_minutes = 0` 表示永不回收，用户可以把终端连开几天。
    /// 只有程序自己退出、且没有页面还挂着它时才会被清掉（避免残留死会话）。
    /// 容量达到上限时，会先回收没有任何客户端连接的孤儿会话（见 `create`），
    /// 实在腾不出名额才拒绝新建，由前端提示用户关标签页。
    pub fn reap(&self) {
        // 收集要回收的会话，**释放会话表锁之后再 kill**：
        // kill() 现在要扫 /proc 清整棵进程树（几毫秒），
        // 在锁里做会把 /api/sessions、新建会话一起卡住。
        let mut doomed: Vec<(String, Arc<Session>, &'static str)> = Vec::new();
        {
            let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());

            // 1) 已退出且无人连接的会话：总是回收
            let dead: Vec<String> = guard
                .iter()
                .filter(|(_, s)| !s.is_alive() && s.client_count() == 0)
                .map(|(id, _)| id.clone())
                .collect();
            for id in dead {
                if let Some(s) = guard.remove(&id) {
                    doomed.push((id, s, "exited"));
                }
            }

            // 2) 建好之后从来没有客户端连上来的会话：只可能是异常中断留下的孤儿，
            //    给 5 分钟宽限后直接回收（否则会一直占着 root shell 与回放缓冲）。
            let orphans: Vec<String> = guard
                .iter()
                .filter(|(_, s)| {
                    s.client_count() == 0
                        && !s.ever_attached.load(Ordering::Relaxed)
                        && s.created.elapsed() > ORPHAN_GRACE
                })
                .map(|(id, _)| id.clone())
                .collect();
            for id in orphans {
                if let Some(s) = guard.remove(&id) {
                    doomed.push((id, s, "orphan"));
                }
            }

            // 3) 无人连接的会话：回放缓冲裁回软上限。
            //    没人看的时候没必要为了「以后回放」保留 4MB 的 TUI 完整重绘流，
            //    否则 32 个标签页关掉浏览器后可以默默吃掉上百 MB。
            for s in guard.values() {
                if s.client_count() == 0 {
                    s.trim_replay(REPLAY_CAP);
                }
            }

            // 4) 可选的空闲回收：0 表示永不回收（默认）
            if self.cfg.idle_minutes > 0 {
                let idle_limit = Duration::from_secs(self.cfg.idle_minutes.saturating_mul(60));
                let expired: Vec<String> = guard
                    .iter()
                    .filter(|(_, s)| s.client_count() == 0 && s.idle_for() > idle_limit)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in expired {
                    if let Some(s) = guard.remove(&id) {
                        doomed.push((id, s, "idle"));
                    }
                }
            }
        }

        for (id, s, why) in doomed {
            match why {
                "idle" => crate::log_info!(
                    "reaped idle session {} ({} min)",
                    id,
                    self.cfg.idle_minutes
                ),
                "orphan" => crate::log_info!("reaped orphan session {} (never attached)", id),
                _ => crate::log_info!("reaped exited session {}", id),
            }
            s.kill();
        }
    }
}

/// 从 portable-pty 的退出状态里取出信号编号。
///
/// portable-pty 0.8 的 `ExitStatus.signal` 是私有字段、没有公开访问器，
/// 只能从 Debug 输出里解析（形如 `ExitStatus { code: 0, signal: Some("SIGKILL") }`）。
/// 拿不到就返回 None —— 只是展示用的信息，拿不到不影响功能。
fn exit_signal(st: &portable_pty::ExitStatus) -> Option<i32> {
    parse_signal_from_debug(&format!("{:?}", st))
}

/// 从 Debug 文本里解析信号名 → 信号编号（拆出来是为了能写单测）。
fn parse_signal_from_debug(dbg: &str) -> Option<i32> {
    let name = dbg
        .split("signal: Some(\"")
        .nth(1)?
        .split('"')
        .next()?
        .to_string();
    let n = name.strip_prefix("SIG")?;
    let num = match n {
        "HUP" => 1,
        "INT" => 2,
        "QUIT" => 3,
        "ILL" => 4,
        "TRAP" => 5,
        "ABRT" | "IOT" => 6,
        "BUS" => 7,
        "FPE" => 8,
        "KILL" => 9,
        "USR1" => 10,
        "SEGV" => 11,
        "USR2" => 12,
        "PIPE" => 13,
        "ALRM" => 14,
        "TERM" => 15,
        "STKFLT" => 16,
        "CHLD" => 17,
        "CONT" => 18,
        "STOP" => 19,
        "TSTP" => 20,
        "TTIN" => 21,
        "TTOU" => 22,
        "URG" => 23,
        "XCPU" => 24,
        "XFSZ" => 25,
        "VTALRM" => 26,
        "PROF" => 27,
        "WINCH" => 28,
        "IO" | "POLL" => 29,
        "PWR" => 30,
        "SYS" => 31,
        _ => return n.parse().ok(),
    };
    Some(num)
}

/// 在字节串中查找子串，返回起始下标。
fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// 把回放内容裁到「安全边界」再交给客户端。
///
/// 终端转义序列不能被拦腰截断，否则客户端会解析出错误的状态。
/// 这里按「转义序列边界」裁剪——**不能按最后一个换行裁**：
/// 全屏 TUI 的重绘输出里根本没有换行（全是光标定位），那样会把整段回放
/// 都裁掉，重连后页面就是一片空白。
fn trim_to_safe(buf: &[u8]) -> Vec<u8> {
    if buf.is_empty() {
        return Vec::new();
    }
    let mut end = buf.len();

    // 1) 尾部若还有半条转义序列，丢掉
    if let Some(esc) = buf.iter().rposition(|b| *b == 0x1b) {
        if sequence_complete(&buf[esc..]) {
            // 序列完整，但结尾可能还带着半个 UTF-8 字符（下面统一处理）
        } else {
            end = esc;
        }
    }

    // 2) 尾部若还有不完整的 UTF-8 字符，也丢掉
    //
    // 注意：这里必须处理「缓冲区尾部全是续字节」的情况。
    // 旧实现先回退到 start，再取 buf[start - 1]——当整段都是续字节时
    // start 会退到 0，buf[start - 1] 直接下溢 panic。
    // release 配置是 panic = "abort"，一次越界就会让整个服务挂掉。
    if end > 0 {
        let (lead_idx, cont) = last_char_span(&buf[..end]);
        if cont > 0 {
            // 尾部是一串续字节
            if lead_idx == 0 {
                // 整段都找不到起始字节：不是合法的 UTF-8，全部丢掉
                end = 0;
            } else {
                let lead = buf[lead_idx - 1];
                let need = utf8_seq_len(lead);
                let have = 1 + cont;
                if need <= 1 {
                    // 前一个字节不是多字节起始：这些续字节是孤儿，丢掉
                    end = lead_idx;
                } else if have < need {
                    // 字符被截断：从它的起始字节开始丢掉
                    end = lead_idx - 1;
                }
                // have >= need：字符完整，保留
            }
        } else {
            // 最后一个字节不是续字节：要么是 ASCII，要么是个孤立的起始字节
            let lead = buf[end - 1];
            let need = utf8_seq_len(lead);
            if need > 1 {
                // 起始字节后面没有续字节：字符被截断，丢掉这个字节
                end -= 1;
            }
        }
    }

    buf[..end].to_vec()
}

/// UTF-8 起始字节对应的字符长度；不是合法起始字节返回 0。
fn utf8_seq_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => 0,
    }
}

/// 找出缓冲区最后一个字符的起点。
///
/// 返回 (续字节起点, 续字节个数)：
/// - 续字节个数为 0 → 最后一个字节不是续字节（ASCII 或孤立起始字节）；
/// - 续字节起点为 0 → 整段都是续字节，找不到合法起点。
fn last_char_span(buf: &[u8]) -> (usize, usize) {
    let mut i = buf.len();
    let mut cont = 0usize;
    while i > 0 && (buf[i - 1] & 0xC0) == 0x80 {
        i -= 1;
        cont += 1;
    }
    (i, cont)
}

/// 判断一段以 ESC 开头的字节是否是完整的转义序列。
fn sequence_complete(tail: &[u8]) -> bool {
    sequence_end(tail).is_some()
}

/// 找到以 ESC 开头的转义序列的结尾字节下标（相对 tail 的偏移）。
///
/// 找不到结尾说明序列还没写完（跨块了）。
fn sequence_end(tail: &[u8]) -> Option<usize> {
    if tail.len() < 2 {
        return None;
    }
    match tail[1] {
        b'[' => {
            // CSI：以 0x40..=0x7E 结尾
            tail[2..]
                .iter()
                .position(|b| (0x40..=0x7e).contains(b))
                .map(|i| 2 + i)
        }
        b']' => {
            // OSC：以 BEL 或 ST(ESC \) 结尾
            if let Some(i) = tail[2..].windows(2).position(|w| w == b"\x1b\\") {
                Some(2 + i + 1)
            } else {
                tail[2..].iter().position(|b| *b == 0x07).map(|i| 2 + i)
            }
        }
        _ => Some(1), // 两字节的简单序列
    }
}

/// 找一个可以安全裁剪的位置：保证裁剪点不落在一条转义序列中间。
///
/// `from` 是期望的裁剪点。如果它落在某条转义序列中间，就往后推到该序列的
/// 结尾之后。实在判断不出来（返回 None）时由调用方决定退路。
fn safe_cut_point(buf: &[u8], from: usize) -> Option<usize> {
    if from == 0 {
        return Some(0);
    }
    if from >= buf.len() {
        return Some(buf.len());
    }
    // 只在 from 之前的一小段窗口里找 ESC：转义序列都很短，
    // 窗口内没有 ESC 就说明 from 落在普通文本里，可以直接裁。
    const WINDOW: usize = 512;
    let lo = from.saturating_sub(WINDOW);
    let Some(rel) = buf[lo..from].iter().rposition(|b| *b == 0x1b) else {
        return Some(from);
    };
    let esc = lo + rel;
    // 这条序列在 from 之前已经结束 → from 是安全的裁剪点
    if sequence_complete(&buf[esc..from]) {
        return Some(from);
    }
    // 序列跨过了 from：把裁剪点推到序列之后
    sequence_end(&buf[esc..]).map(|end| (esc + end + 1).min(buf.len()))
}

/// 解析 /proc/<pid>/stat 中的进程组号。
pub fn process_group_of(pid: u32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{}/stat", pid)).ok()?;
    let close = stat.rfind(')')?;
    let rest: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    // stat 字段：state(0) ppid(1) pgrp(2)
    rest.get(2)?.parse().ok()
}

fn random_u32() -> u32 {
    use std::io::Read as _;
    let mut buf = [0u8; 4];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        if f.read_exact(&mut buf).is_ok() {
            return u32::from_le_bytes(buf);
        }
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    nanos
}

/// 校验 shell 是否可用，依次回退 bash → sh。
pub fn resolve_shell(preferred: &str) -> String {
    let candidates = [
        preferred.to_string(),
        "/bin/bash".to_string(),
        "/usr/bin/bash".to_string(),
        "/bin/sh".to_string(),
    ];
    for c in candidates {
        if !c.is_empty() && std::path::Path::new(&c).is_file() {
            return c;
        }
    }
    "/bin/sh".to_string()
}

/// 校验工作目录：必须是存在且当前进程可进入的目录，否则依次回退。
pub fn resolve_cwd(preferred: &str) -> String {
    if dir_usable(preferred) {
        return preferred.to_string();
    }
    let home = std::env::var("HOME").unwrap_or_default();
    for c in ["/root", home.as_str(), "/tmp", "/"] {
        if dir_usable(c) {
            return c.to_string();
        }
    }
    "/".to_string()
}

/// 目录存在且可进入（读一下就知道有没有权限）。
fn dir_usable(path: &str) -> bool {
    if path.is_empty() {
        return false;
    }
    let p = std::path::Path::new(path);
    if !p.is_dir() {
        return false;
    }
    std::fs::read_dir(p).is_ok()
}

/// 检查启动命令的第一段是否可执行（绝对路径或 PATH 中可找到），仅用于日志提示。
fn command_available(command: &str) -> bool {
    let first = command.split_whitespace().next().unwrap_or("");
    if first.is_empty() {
        return false;
    }
    if first.contains('/') {
        return std::path::Path::new(first).is_file();
    }
    const PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    PATH.split(':').any(|dir| {
        let candidate = std::path::Path::new(dir).join(first);
        candidate.is_file()
    })
}

/// 终端环境变量：明确 TERM / COLORTERM，让 TUI 程序走真彩色路径。
///
/// 同时写两个内部标记：
/// - `NAS_WEBTERM_APP`：应用名，服务重启时用来清理上次留下的孤儿终端进程；
/// - `NAS_WEBTERM_SESSION`：会话标记，关标签页时用来清整棵进程树。
fn child_env(
    shell: &str,
    cwd: &str,
    app_name: &str,
    marker: &str,
    session_id: &str,
) -> Vec<(String, String)> {
    let home = home_dir();
    let user = current_user();
    let lang = detect_locale();
    #[allow(unused_mut)]
    let mut env = vec![
        ("TERM".into(), "xterm-256color".into()),
        ("COLORTERM".into(), "truecolor".into()),
        ("TERM_PROGRAM".into(), "nas-webterm".into()),
        ("TERM_PROGRAM_VERSION".into(), env!("CARGO_PKG_VERSION").into()),
        ("HOME".into(), home),
        ("USER".into(), user.clone()),
        ("LOGNAME".into(), user),
        ("SHELL".into(), shell.to_string()),
        ("PWD".into(), cwd.to_string()),
        (
            "PATH".into(),
            "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin".into(),
        ),
        (APP_ENV.into(), app_name.to_string()),
        (SESSION_ENV.into(), marker.to_string()),
        ("LANG".into(), lang.clone()),
        ("LC_ALL".into(), lang),
        // less 保留颜色
        ("LESS".into(), "-R".into()),
        ("PAGER".into(), "less".into()),
    ];
    // AI-ONLY-BEGIN prompt-marker
    // AI agent 的「命令执行完成」哨兵：由 bash 在每次显示提示符前输出。
    // 不走终端输入、也不改用户的 PS1，因此命令回显里看不到任何多余字符，
    // 同时能比「输出安静 N 毫秒」更准确地判断命令是否真的结束。
    #[cfg(feature = "ai")]
    if shell_is_bash(shell) {
        env.push((
            "PROMPT_COMMAND".into(),
            format!(
                "__naswt_ec=$?; printf '\\033]1337;nas-webterm-prompt:{};%s;%s\\007' \"$$\" \"$__naswt_ec\"",
                session_id
            ),
        ));
    }
    // AI-ONLY-END prompt-marker
    env
}

/// 提示符标记前缀。放在这里让创建会话与等待完成两边用同一个格式。
// AI-ONLY-BEGIN prompt-marker-prefix
#[cfg(feature = "ai")]
fn prompt_marker_prefix(session_id: &str) -> String {
    format!("\x1b]1337;nas-webterm-prompt:{};", session_id)
}

// AI-ONLY-END prompt-marker-prefix

/// 是否 bash：只有 bash 支持用 PROMPT_COMMAND 注入完成标记。
// AI-ONLY-BEGIN shell-is-bash
fn shell_is_bash(shell: &str) -> bool {
    std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "bash" || n == "bash.exe")
        .unwrap_or(false)
}
// AI-ONLY-END shell-is-bash

/// 当前进程的用户名（root 时是 root，降权调试时是实际用户）。
fn current_user() -> String {
    for key in ["USER", "LOGNAME"] {
        if let Ok(v) = std::env::var(key) {
            if !v.is_empty() {
                return v;
            }
        }
    }
    let euid = unsafe { libc::geteuid() };
    if euid == 0 {
        "root".to_string()
    } else {
        euid.to_string()
    }
}

fn home_dir() -> String {
    if unsafe { libc::geteuid() } == 0 {
        return "/root".to_string();
    }
    std::env::var("HOME").unwrap_or_else(|_| "/root".to_string())
}

/// 挑一个系统真实支持的 UTF-8 locale，避免中文输出乱码。
fn detect_locale() -> String {
    static LOCALE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    LOCALE
        .get_or_init(|| {
            let preferred = ["zh_CN.UTF-8", "zh_CN.utf8", "en_US.UTF-8", "C.UTF-8", "C.utf8"];
            let available = std::process::Command::new("locale")
                .arg("-a")
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).to_string())
                .unwrap_or_default();
            for p in preferred {
                if available.contains(p) {
                    return p.to_string();
                }
            }
            "C.UTF-8".to_string()
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_scanner_handles_fragmented_osc10() {
        let mut scanner = TerminalQueryScanner::new();
        let mut kinds = Vec::new();
        scanner.feed(b"\x1b]1", |k| kinds.push(k));
        scanner.feed(b"0;?\x07", |k| kinds.push(k));
        assert_eq!(kinds, vec![TerminalQueryKind::Osc10]);
    }

    #[test]
    fn query_scanner_handles_osc4_pairs_and_st() {
        let mut scanner = TerminalQueryScanner::new();
        let mut kinds = Vec::new();
        scanner.feed(b"\x1b]4;0;?;15;?\x1b\\", |k| kinds.push(k));
        assert_eq!(
            kinds,
            vec![TerminalQueryKind::Osc4(0), TerminalQueryKind::Osc4(15)]
        );
    }

    #[test]
    fn query_scanner_handles_da_queries() {
        let mut scanner = TerminalQueryScanner::new();
        let mut kinds = Vec::new();
        scanner.feed(b"\x1b[c\x1b[>0c", |k| kinds.push(k));
        assert_eq!(kinds, vec![TerminalQueryKind::Da1, TerminalQueryKind::Da2]);
    }

    #[test]
    fn query_scanner_handles_dsr_and_decrqm() {
        let mut scanner = TerminalQueryScanner::new();
        let mut kinds = Vec::new();
        scanner.feed(b"\x1b[5n\x1b[6n\x1b[?6n\x1b[?25$p\x1b[18t", |k| kinds.push(k));
        assert_eq!(
            kinds,
            vec![
                TerminalQueryKind::DsrStatus,
                TerminalQueryKind::DsrCursor { private: false },
                TerminalQueryKind::DsrCursor { private: true },
                TerminalQueryKind::DecRqm { ansi: false, mode: 25 },
                TerminalQueryKind::WindowChars
            ]
        );
    }

    #[test]
    fn query_scanner_does_not_mistake_response_for_query() {
        let mut scanner = TerminalQueryScanner::new();
        let mut kinds = Vec::new();
        scanner.feed(b"\x1b[?1;2c", |k| kinds.push(k));
        assert!(kinds.is_empty(), "DA 应答不能被当成新查询");
    }

    #[test]
    fn response_parser_handles_da_and_osc_colors() {
        let parts = parse_terminal_response(
            b"\x1b[?1;2c\x1b]10;rgb:cccc/cccc/cccc\x1b\\\x1b]4;0;rgb:0c0c/0c0c/0c0c\x07",
        );
        let kinds: Vec<_> = parts.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            kinds,
            vec![
                TerminalQueryKind::Da1,
                TerminalQueryKind::Osc10,
                TerminalQueryKind::Osc4(0)
            ]
        );
    }

    #[test]
    fn response_parser_handles_secondary_da() {
        let parts = parse_terminal_response(b"\x1b[>0;276;0c");
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].0, TerminalQueryKind::Da2);
    }

    #[test]
    fn response_parser_handles_dsr_and_decrqm_and_window_size() {
        let parts = parse_terminal_response(
            b"\x1b[0n\x1b[12;40R\x1b[?13;41R\x1b[?25;2$y\x1b[18;2$y\x1b[8;32;120t",
        );
        let kinds: Vec<_> = parts.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            kinds,
            vec![
                TerminalQueryKind::DsrStatus,
                TerminalQueryKind::DsrCursor { private: false },
                TerminalQueryKind::DsrCursor { private: true },
                TerminalQueryKind::DecRqm { ansi: false, mode: 25 },
                TerminalQueryKind::DecRqm { ansi: true, mode: 18 },
                TerminalQueryKind::WindowChars
            ]
        );
    }

    #[test]
    fn response_parser_rejects_plain_text() {
        assert!(parse_terminal_response(b"rgb:cccc/cccc/cccc").is_empty());
        assert!(parse_terminal_response(b"1;2c").is_empty());
    }

    #[test]
    fn exit_signal_parses_signal_name() {
        // portable-pty 0.8 的 ExitStatus Debug 形态
        let dbg = "ExitStatus { code: 0, signal: Some(\"SIGKILL\") }";
        assert_eq!(parse_signal_from_debug(dbg), Some(9));
        let dbg = "ExitStatus { code: 0, signal: Some(\"SIGTERM\") }";
        assert_eq!(parse_signal_from_debug(dbg), Some(15));
    }

    #[test]
    fn exit_signal_handles_missing_signal() {
        // 正常退出没有信号
        assert_eq!(
            parse_signal_from_debug("ExitStatus { code: 0, signal: None }"),
            None
        );
        // 完全不是这个形态
        assert_eq!(parse_signal_from_debug("whatever"), None);
    }

    #[test]
    fn proc_helpers_read_own_process() {
        // 自己的 pid 一定能读到会话号 / 进程组号
        let pid = std::process::id();
        assert!(proc_session(pid).is_some(), "/proc/self/stat 应能解析出 session");
        assert!(proc_pgrp(pid).is_some(), "/proc/self/stat 应能解析出 pgrp");
        // 不存在的 pid 不能 panic
        assert_eq!(proc_session(4_000_000_000), None);
        assert_eq!(proc_pgrp(4_000_000_000), None);
    }

    #[test]
    fn kill_helpers_are_safe_noops() {
        // 空目标 / 空应用名都不能误杀，也不能 panic
        kill_session_processes(&[]);
        assert_eq!(kill_orphan_processes(""), 0);
        // 不存在的应用名：扫描 /proc 但一个都不匹配
        assert_eq!(kill_orphan_processes("nas-webterm-no-such-app-xyz"), 0);
    }

    #[test]
    fn limit_error_is_detectable() {
        let msg = limit_error(32);
        assert!(is_limit_error(&msg), "应识别为容量错误: {msg}");
        assert!(msg.contains("32"));
        assert!(!is_limit_error("创建 PTY 失败: failed to openpty"));
        assert!(!is_limit_error(""));
    }

    #[test]
    fn trim_keeps_complete_text() {
        let buf = b"hello world".to_vec();
        assert_eq!(trim_to_safe(&buf), buf);
    }

    #[test]
    fn trim_drops_incomplete_escape_sequence() {
        // ESC[2 还没写完 → 整条丢掉
        let buf = b"abc\x1b[2".to_vec();
        assert_eq!(trim_to_safe(&buf), b"abc".to_vec());
    }

    #[test]
    fn trim_drops_incomplete_utf8() {
        // “中”只写了 2 个字节
        let mut buf = b"ok".to_vec();
        buf.extend_from_slice(&[0xE4, 0xB8]);
        assert_eq!(trim_to_safe(&buf), b"ok".to_vec());
    }

    #[test]
    fn trim_drops_lone_lead_byte() {
        let mut buf = b"ok".to_vec();
        buf.push(0xE4);
        assert_eq!(trim_to_safe(&buf), b"ok".to_vec());
    }

    #[test]
    fn trim_does_not_panic_on_continuation_bytes_only() {
        // 旧实现在这里会 buf[start - 1] 下溢 panic（release 下 panic=abort 直接挂服务）
        let buf = vec![0x80u8; 16];
        assert_eq!(trim_to_safe(&buf), Vec::<u8>::new());
    }

    #[test]
    fn trim_keeps_valid_multibyte() {
        let mut buf = b"ok".to_vec();
        buf.extend_from_slice("中".as_bytes());
        assert_eq!(trim_to_safe(&buf), buf);
    }

    #[test]
    fn cut_point_avoids_splitting_sequences() {
        let mut buf = b"abcdefgh".to_vec();
        buf.extend_from_slice(b"\x1b[2J");
        buf.extend_from_slice(b"tail");
        // from 落在 ESC[2J 中间 → 必须推到序列之后
        let cut = safe_cut_point(&buf, 9).unwrap();
        assert_eq!(cut, 12);
        assert!(buf[cut..].starts_with(b"tail"));
    }

    #[test]
    fn cut_point_plain_text_is_unchanged() {
        let buf = b"abcdefghij".to_vec();
        assert_eq!(safe_cut_point(&buf, 4).unwrap(), 4);
    }

    #[test]
    fn sequence_end_detects_csi_and_osc() {
        assert_eq!(sequence_end(b"\x1b[2J"), Some(3));
        assert_eq!(sequence_end(b"\x1b[?"), None);
        assert_eq!(sequence_end(b"\x1b]0;title\x07"), Some(9));
        // OSC 以 ST(ESC \) 结尾：最后一个字节是 '\'（下标 10）
        assert_eq!(sequence_end(b"\x1b]0;title\x1b\\"), Some(10));
    }

    #[test]
    fn trim_drops_orphan_continuation_bytes() {
        // 'k' 后面跟了一个没有起始字节的续字节 → 孤儿字节丢掉
        let mut buf = b"ok".to_vec();
        buf.push(0x80);
        assert_eq!(trim_to_safe(&buf), b"ok".to_vec());
    }
}

/// 去掉终端输出里的 ANSI 转义序列，只留可见文本。
///
/// 处理 CSI（`ESC [ ... 终止字节`）、OSC（`ESC ] ... BEL/ST`）以及两字节转义。
/// 不完整的序列（缓冲区截断导致）一并丢掉，免得把半个序列当正文。
#[cfg(feature = "ai")]
pub fn strip_ansi(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b != 0x1b {
            // 控制字符直接丢（保留 \n 与 \t，\r 交给 lines() 处理）
            if b < 0x20 && b != b'\n' && b != b'\t' && b != b'\r' {
                i += 1;
                continue;
            }
            out.push(b as char);
            i += 1;
            continue;
        }
        // ESC 序列
        i += 1;
        if i >= bytes.len() {
            break;
        }
        match bytes[i] {
            b'[' => {
                // CSI：吃掉参数字节直到遇到终止字节（0x40..=0x7e）
                i += 1;
                while i < bytes.len() {
                    let c = bytes[i];
                    i += 1;
                    if (0x40..=0x7e).contains(&c) {
                        break;
                    }
                }
            }
            b']' => {
                // OSC：直到 BEL 或 ST（ESC \\）
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == 0x07 {
                        i += 1;
                        break;
                    }
                    if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                        i += 2;
                        break;
                    }
                    i += 1;
                }
            }
            b'(' | b')' | b'*' | b'+' => {
                // 字符集选择，后面跟一个字符
                i = (i + 2).min(bytes.len());
            }
            _ => {
                // 其余两字节转义
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod ansi_tests {
    use super::strip_ansi;

    #[test]
    fn removes_csi_sequences() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
        assert_eq!(strip_ansi("\x1b[2J\x1b[Hclear"), "clear");
    }

    #[test]
    fn removes_osc_sequences() {
        assert_eq!(strip_ansi("\x1b]0;title\x07after"), "after");
        assert_eq!(strip_ansi("\x1b]8;;http://x\x1b\\link"), "link");
    }

    #[test]
    fn keeps_plain_text_and_newlines() {
        assert_eq!(strip_ansi("a\nb\tc"), "a\nb\tc");
    }

    #[test]
    fn drops_truncated_sequence() {
        // 缓冲区截断留下的半个 CSI：不能当成正文输出
        assert_eq!(strip_ansi("ok\x1b[38;5"), "ok");
    }
}
