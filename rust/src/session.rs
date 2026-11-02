//! PTY 会话管理：一个会话 = 一个真实伪终端进程。
//!
//! 设计要点：
//! - 输出走「会话 → 每客户端一条有界队列」，慢客户端会被踢掉而不是拖垮服务端；
//! - 保留最近 256KB 输出用于断线重连后回放，刷新页面不丢屏；
//! - 空闲会话按 TTL 回收，避免长期占用 root 进程。

use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
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
const REPLAY_CAP: usize = 256 * 1024;
/// 回放缓冲区硬上限。处于备用屏幕时，为了保住「进入备用屏幕」那个起点，
/// 允许在软上限之上继续保留，直到硬上限。
const REPLAY_HARD_CAP: usize = 4 * 1024 * 1024;
/// 进入备用屏幕（全屏 TUI）的序列
const ALT_ENTER: [&[u8]; 2] = [b"\x1b[?1049h", b"\x1b[?47h"];
/// 离开备用屏幕的序列
const ALT_LEAVE: [&[u8]; 2] = [b"\x1b[?1049l", b"\x1b[?47l"];
/// 单客户端输出队列容量（块，每块最大 16KB）
const CLIENT_QUEUE: usize = 512;
/// PTY 读取块大小
const READ_BUF: usize = 16 * 1024;
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
}

pub struct Session {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: Option<u32>,
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
    first_output: AtomicBool,
    last_active: Mutex<Instant>,
    created: Instant,
    client_seq: AtomicU64,
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
        let size = PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        };

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(size)
            .map_err(|e| format!("创建 PTY 失败: {}", e))?;

        let mut cmd = CommandBuilder::new(&shell);
        cmd.cwd(&cwd);
        for (k, v) in child_env(&shell, &cwd) {
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

        let session = Arc::new(Session {
            id: id.clone(),
            shell: shell.clone(),
            cwd: cwd.clone(),
            pid,
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
            first_output: AtomicBool::new(false),
            last_active: Mutex::new(Instant::now()),
            created: Instant::now(),
            client_seq: AtomicU64::new(0),
        });

        // 写入线程：把输入队列的字节真正写进 PTY。
        tokio::task::spawn_blocking(move || {
            while let Some(data) = input_rx.blocking_recv() {
                if writer.write_all(&data).is_err() {
                    break;
                }
            }
        });

        // 读取线程：把 PTY 输出推给所有客户端。
        //
        // 子进程句柄由本线程持有并负责 wait 回收。若把 Child 放在会话对象里，
        // 会话先被销毁时回收逻辑就再也执行不到，每杀一个会话就会留下一个僵尸进程。
        let weak = Arc::downgrade(&session);
        let mut child = child;
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
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
            // 无论会话是否还在，都要把子进程回收掉，避免僵尸进程堆积
            let info = reap_child(&mut child);
            if let Some(s) = weak.upgrade() {
                s.on_child_exit(info);
            }
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
            if replay.len() > REPLAY_CAP {
                let excess = replay.len() - REPLAY_CAP;
                let alt_idx = self.alt_enter_idx.load(Ordering::Relaxed);
                // 裁掉就会丢掉「进入备用屏幕」那个起点：客户端就进不了备用屏幕，
                // TUI 的重绘会画到主屏上，画面就乱了。
                // 所以在硬上限之前先不裁，保留完整的一次 TUI 会话。
                let alt_would_be_cut = alt_idx != usize::MAX && alt_idx < excess;
                if !(alt_would_be_cut && replay.len() < REPLAY_HARD_CAP) {
                    // 裁剪点必须落在转义序列边界上，否则客户端会把半条序列
                    // 当成普通文本打印出来（README §7 承诺按序列边界裁剪）。
                    // 判断不出来时退回按字节裁，保证缓冲区不会无限增长。
                    let cut = match safe_cut_point(&replay, excess) {
                        Some(c) => c,
                        None => {
                            crate::log_warn!(
                                "会话 {} 的回放缓冲区头部存在无法识别的转义序列，按字节裁剪",
                                self.id
                            );
                            excess
                        }
                    };
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
            replay.len() - data.len()
        };
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
    /// 这些重绘字节如果原样回放，轻则画面错乱，重则被 256KB 上限截断在
    /// 转义序列中间，把终端状态彻底搞坏。所以必须知道当前处于哪种模式。
    ///
    /// **跨块处理**：`ESC[?1049h` 有 8 字节，PTY 一次读出来的块边界完全可能
    /// 把它劈成两半。只在单块里扫会漏判备用屏幕状态，重连后 TUI 画面就乱/空白。
    /// 所以这里把上一块尾部（最多 `MAX_ALT_SEQ_LEN - 1` 字节）带过来一起扫。
    fn detect_alt_screen(&self, chunk: &[u8], base: usize) {
        let tail = {
            let mut t = self.alt_tail.lock().unwrap_or_else(|e| e.into_inner());
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
        *self.exit.lock().unwrap_or_else(|e| e.into_inner()) = Some(info.clone());
        self.alive.store(false, Ordering::Relaxed);

        let payload = serde_json::to_vec(&info).unwrap_or_default();
        let frame = Bytes::from(proto::frame(proto::S_EXIT, &payload));
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        clients.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
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
        self.touch();

        let alt_screen = self.alt_screen.load(Ordering::Relaxed);
        let (replay, need_alt_enter) = {
            let buf = self.replay.lock().unwrap_or_else(|e| e.into_inner());
            // alt_enter_idx 还有效，说明回放里带着「进入备用屏幕」那个起点，
            // 客户端直接回放即可；起点被裁掉了才需要客户端自己补一条。
            let has_entry = self.alt_enter_idx.load(Ordering::Relaxed) != usize::MAX;
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
    pub async fn write_input(&self, data: Vec<u8>) -> Result<(), String> {
        if data.is_empty() {
            return Ok(());
        }
        self.input_tx
            .send(data)
            .await
            .map_err(|_| "会话已结束".to_string())
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
    pub fn kill(&self) {
        self.alive.store(false, Ordering::Relaxed);
        crate::log_info!("会话 {} 已结束 (pid={})", self.id, self.pid.unwrap_or(0));
        if let Some(mut killer) = self.killer.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = killer.kill();
        }
        if let Some(pid) = self.pid {
            // 只有确认该进程仍是进程组组长时才 killpg，避免 PID 复用误杀无关进程组。
            if process_group_of(pid) == Some(pid as i32) {
                unsafe {
                    libc::killpg(pid as i32, libc::SIGKILL);
                }
            }
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
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
        }
    }
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
        format!("s{}-{:x}", n, random_u32())
    }

    pub fn create(
        &self,
        startup: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Session>, String> {
        // 快路径：容量已满时直接拒绝，不去白创建一个 PTY 进程。
        {
            let guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() >= self.cfg.max_sessions {
                return Err(limit_error(self.cfg.max_sessions));
            }
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

    /// 清理已退出且没有客户端连接的会话。
    ///
    /// **不按时间杀会话**：`idle_minutes = 0` 表示永不回收，用户可以把终端连开几天。
    /// 只有程序自己退出、且没有页面还挂着它时才会被清掉（避免残留死会话）。
    /// 容量达到上限时也不杀旧会话，改为拒绝新建，由前端提示用户关标签页。
    pub fn reap(&self) {
        let mut guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());

        // 1) 已退出且无人连接的会话：总是回收
        let dead: Vec<String> = guard
            .iter()
            .filter(|(_, s)| !s.is_alive() && s.client_count() == 0)
            .map(|(id, _)| id.clone())
            .collect();
        for id in dead {
            if let Some(s) = guard.remove(&id) {
                crate::log_info!("reaped exited session {}", id);
                s.kill();
            }
        }

        // 2) 可选的空闲回收：0 表示永不回收（默认）
        if self.cfg.idle_minutes == 0 {
            return;
        }
        let idle_limit = Duration::from_secs(self.cfg.idle_minutes.saturating_mul(60));
        let expired: Vec<String> = guard
            .iter()
            .filter(|(_, s)| s.client_count() == 0 && s.idle_for() > idle_limit)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(s) = guard.remove(&id) {
                crate::log_info!("reaped idle session {} ({}s)", id, idle_limit.as_secs());
                s.kill();
            }
        }
    }
}

/// 等待子进程退出并回收，返回退出信息。
///
/// 必须在持有 Child 句柄的线程里调用：wait 的结果只有子进程的父进程能拿到。
fn reap_child(child: &mut Box<dyn Child + Send + Sync>) -> ExitInfo {
    for _ in 0..600 {
        match child.try_wait() {
            Ok(Some(st)) => {
                return ExitInfo {
                    code: st.exit_code() as i32,
                    signal: None,
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    // 兜底：PTY 已经关闭但子进程还活着（少见），强制结束并再等一次
    if let Some(pid) = child.process_id() {
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
    for _ in 0..40 {
        match child.try_wait() {
            Ok(Some(st)) => {
                return ExitInfo {
                    code: st.exit_code() as i32,
                    signal: None,
                }
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    ExitInfo {
        code: -1,
        signal: None,
    }
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
fn child_env(shell: &str, cwd: &str) -> Vec<(String, String)> {
    let home = home_dir();
    let user = current_user();
    let lang = detect_locale();
    vec![
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
        ("LANG".into(), lang.clone()),
        ("LC_ALL".into(), lang),
        // less 保留颜色
        ("LESS".into(), "-R".into()),
        ("PAGER".into(), "less".into()),
    ]
}

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
