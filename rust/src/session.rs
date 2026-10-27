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
                    replay.drain(..excess);
                    let idx = self.alt_enter_idx.load(Ordering::Relaxed);
                    self.alt_enter_idx
                        .store(idx.saturating_sub(excess), Ordering::Relaxed);
                    if self.alt_enter_idx.load(Ordering::Relaxed) == usize::MAX {
                        // 备用屏幕起点已被裁掉，客户端需要自己补一个
                        self.alt_enter_idx.store(usize::MAX, Ordering::Relaxed);
                    }
                }
            }
            replay.len() - data.len()
        };
        self.detect_alt_screen(&data, base);
        let frame = Bytes::from(proto::frame(proto::S_OUTPUT, &data));
        let mut clients = self.clients.lock().unwrap_or_else(|e| e.into_inner());
        // 队列满说明客户端消费不过来，直接断开让它重连并回放，避免拖慢其它标签页。
        clients.retain(|(_, tx)| tx.try_send(frame.clone()).is_ok());
    }

    /// 扫描输出，跟踪是否进入了/离开了备用屏幕。
    ///
    /// 全屏 TUI 程序会切到备用屏幕并持续重绘。
    /// 这些重绘字节如果原样回放，轻则画面错乱，重则被 256KB 上限截断在
    /// 转义序列中间，把终端状态彻底搞坏。所以必须知道当前处于哪种模式。
    fn detect_alt_screen(&self, chunk: &[u8], base: usize) {
        let mut pos = 0usize;
        while pos < chunk.len() {
            let mut hit: Option<(usize, usize, bool)> = None; // (位置, 长度, 是否进入)
            for (seqs, entering) in [(ALT_ENTER, true), (ALT_LEAVE, false)] {
                for seq in seqs {
                    if let Some(i) = find_bytes(&chunk[pos..], seq) {
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
                self.alt_enter_idx
                    .store(base + at, Ordering::Relaxed);
            } else {
                self.alt_screen.store(false, Ordering::Relaxed);
                self.alt_enter_idx.store(usize::MAX, Ordering::Relaxed);
            }
            pos = at + len;
        }
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
        // 容量上限只拦新建，绝不为腾位置去杀用户正在用的旧会话
        {
            let guard = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() >= self.cfg.max_sessions {
                return Err(format!(
                    "会话数已达上限（{} 个），请先关闭一个标签页再新建",
                    self.cfg.max_sessions
                ));
            }
        }
        let id = self.next_id();
        let session = Session::spawn(&self.cfg, id.clone(), cols, rows, startup)?;
        self.sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, session.clone());
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
        if !sequence_complete(&buf[esc..]) {
            end = esc;
        }
    }

    // 2) 尾部若还有不完整的 UTF-8 字符，也丢掉
    let mut start = end;
    while start > 0 && (buf[start - 1] & 0xC0) == 0x80 {
        start -= 1;
    }
    if start < end {
        let lead = buf[start - 1];
        let need = if lead < 0x80 {
            1
        } else if lead >= 0xF0 {
            4
        } else if lead >= 0xE0 {
            3
        } else if lead >= 0xC0 {
            2
        } else {
            1
        };
        if start - 1 + need > end {
            end = start - 1;
        }
    }

    buf[..end].to_vec()
}

/// 判断一段以 ESC 开头的字节是否是完整的转义序列。
fn sequence_complete(tail: &[u8]) -> bool {
    if tail.len() < 2 {
        return false;
    }
    match tail[1] {
        b'[' => {
            // CSI：以 0x40..=0x7E 结尾
            tail[2..]
                .iter()
                .any(|b| (0x40..=0x7e).contains(b))
        }
        b']' => {
            // OSC：以 BEL 或 ST(ESC \) 结尾
            tail[2..].windows(2).any(|w| w == b"\x1b\\")
                || tail[2..].contains(&0x07)
        }
        _ => true, // 两字节的简单序列
    }
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
