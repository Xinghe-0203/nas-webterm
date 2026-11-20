//! AI Agent：把「自然语言 → 多步执行」的循环搬到服务端。
//!
//! 与 `ai.rs` 的区别：`ai.rs` 只负责「调一次模型 + 解析命令」，
//! 这里负责**跑完整任务**：调模型 → 拿命令 → 等用户审批 → 写进 PTY →
//! 回收输出 → 把输出喂回模型 → 继续，直到模型不再给命令。
//!
//! 为什么放服务端：PTY 在服务端，只有它能准确拿到「命令执行前后」的输出分界
//! （`Session::output_seq` / `output_since`）。放前端只能靠猜。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::oneshot;

use crate::ai::events::{EventBus, GraceTimer};
use crate::ai::history::{now_millis, ChatHistory, HistoryBlock, HistoryCommand, HistoryTurn};
use crate::ai::{self, AiConfig, ChatMessage};
use crate::session::Session;

/// 步数上限由 `AiConfig::max_steps()` 按模型上下文窗口分档给出。
/// 等待用户审批命令的超时（超时按「跳过」处理）
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(600);
/// 命令执行后「多久没新输出」算跑完
const QUIET_MS: u64 = 900;
/// 单条命令最长等待时间
const CMD_TIMEOUT_MS: u64 = 180_000;
/// 命令输出回灌上限由 `AiConfig::observe_chars()` 按上下文窗口比例给出。
/// 一轮里模型最多能「重新提议」几次同一条被拒的命令
const MAX_REPEAT: usize = 2;
/// 同一条命令在整次任务里最多执行几次。
///
/// 模型有时会在 A、B 两条命令之间来回跳（不是连续重复，`MAX_REPEAT` 抓不到），
/// 直到 64 步上限才停，用户看到的就是「AI 反复循环」。这里按整次任务计数，
/// 超过就收尾并提示，避免白烧 token、反复改机器。
const MAX_SAME_COMMAND: usize = 3;

/// 一条等待用户审批的命令。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PendingCommand {
    pub command: String,
    pub purpose: String,
    pub danger: bool,
    pub reason: String,
    /// 是否需要人工确认（删除 / 改写文件 / 整机级不可逆操作）
    pub needs_approval: bool,
}

/// 用户对命令的决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// 执行（可以带上用户编辑过的命令）
    Run,
    /// 跳过这一条
    Skip,
    /// 终止整个任务
    Stop,
}

/// 记录本次任务的一轮对话，结束时写进聊天记录。
///
/// 为什么要单独记：模型在一次任务里会先说一段、再跑命令、再接着说。
/// 聊天记录要的是**用户看到的那条时间线**（文字与命令卡片交错），
/// 而不是模型内部的原始输出；同时还要留一份纯文本给模型当下次上下文。
///
/// 用 Drop 收尾：任务有十来个提前 return 的出口（停止、超时、用户关页面…），
/// 逐个补 `finish()` 很容易漏一个，漏了就少一条聊天记录。
struct TurnRecorder {
    store: Arc<ChatHistory>,
    conversation_id: String,
    user: String,
    /// 界面上按顺序回放的块
    blocks: Vec<HistoryBlock>,
    /// 这一轮里用户看到的全部文字（按顺序拼接）→ 下次当模型上下文。
    ///
    /// 只收「已经发给前端」的文本，所以不会把那些被扣住、最后没展示的
    /// 提前总结也塞进上下文。
    assistant: String,
    /// 协议标签的**增量**过滤器。
    ///
    /// 流式分片可能把标签切成 `<exe` + `cute_command>` 两半；如果对每一片
    /// 单独做 strip，前半片被清掉、后半片却会原样留下（历史里就出现
    /// `cute_command>` 这种新垃圾）。这里保持跨片状态，直到闭合标签出现
    /// 才整段丢弃。
    filter: crate::ai::protocol::ProtocolFilter,
    /// 是否已经写进存储（save 幂等；Drop 里再兜一次）
    saved: bool,
}

impl TurnRecorder {
    fn new(store: Arc<ChatHistory>, conversation_id: String, user: String) -> Self {
        Self {
            store,
            conversation_id,
            user,
            blocks: Vec::new(),
            assistant: String::new(),
            filter: crate::ai::protocol::ProtocolFilter::new(),
            saved: false,
        }
    }

    /// 立即落盘（幂等）。
    ///
    /// 发 `done` 之前必须先写：前端收到 done 就能立刻发下一条，如果这一轮
    /// 还没落盘，服务端会因为「会话不存在」把它当成新会话，对话就断了。
    fn save(&mut self) {
        if self.saved {
            return;
        }
        self.saved = true;
        // 收尾：把过滤器里扣住的普通文字放出来，没闭合的标签碎片丢掉。
        // 不做这一步，最后一句如果正好停在 `<` 上，就会丢字。
        let tail = self.filter.finish();
        self.append_safe(&tail);
        if self.assistant.trim().is_empty() && self.blocks.is_empty() {
            return;
        }
        let turn = HistoryTurn {
            user: std::mem::take(&mut self.user),
            assistant: std::mem::take(&mut self.assistant),
            blocks: std::mem::take(&mut self.blocks),
            at: now_millis(),
        };
        self.store.append_turn(&self.conversation_id, turn);
    }

    /// 记一段助手输出（界面上看到的文本）。
    ///
    /// 连续的文字会合并成一块，回放时就是一段话而不是一堆碎片。
    fn push_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        // 必须**过滤协议标签**：前端有 ToolFilter，界面上看不到
        // `<execute_command>`，但存进聊天记录的是服务端这份原文。
        // 少了这道过滤，历史里会出现 `<execute` 这种半截标签碎片
        // （模型分片输出时标签还没写完就被记下来了），
        // 还会污染下一轮喂给模型的上下文。
        //
        // 用**增量**过滤器（不是对每一片单独 strip）：标签可能被切在
        // 两片之间，逐片清理会把后半片漏成 `cute_command>` 这类碎片。
        let safe = self.filter.push(text);
        self.append_safe(&safe);
    }

    /// 把过滤器放行的那部分文本记下来（多片会合并成一个文字块）。
    fn append_safe(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.assistant.push_str(text);
        match self.blocks.last_mut() {
            Some(HistoryBlock::Text { text: last }) => last.push_str(text),
            _ => self.blocks.push(HistoryBlock::Text {
                text: text.to_string(),
            }),
        }
    }

    /// 记一条命令（等拿到输出后再补上）。
    fn push_command(&mut self, cmd: &HistoryCommand) {
        self.blocks.push(HistoryBlock::Command {
            command: cmd.clone(),
        });
    }

    /// 丢掉最后一条还没真正执行的命令卡（写 PTY 失败等异常路径）。
    fn drop_last_command(&mut self) {
        if matches!(self.blocks.last(), Some(HistoryBlock::Command { .. })) {
            self.blocks.pop();
        }
    }

    /// 补上刚才那条命令的输出。
    fn fill_command_output(&mut self, output: &str, exit_code: Option<i32>, timed_out: bool) {
        if let Some(HistoryBlock::Command { command }) = self.blocks.last_mut() {
            command.output = output.to_string();
            command.exit_code = exit_code;
            command.timed_out = timed_out;
            // 给模型看的上下文里留一行「跑过这条命令」——否则下一轮它不记得
            // 自己已经执行过，容易反复跑同一条。只留命令 + 退出码 + 输出首行，
            // 不把整段输出再存一份。
            let head = output.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            let head: String = head.chars().take(160).collect();
            let status = if timed_out {
                "超时".to_string()
            } else {
                exit_code
                    .map(|c| format!("退出码 {}", c))
                    .unwrap_or_else(|| "已执行".to_string())
            };
            self.assistant.push_str(&format!(
                "\n> 已执行命令：`{}`（{}）{}\n",
                command.command,
                status,
                if head.is_empty() {
                    String::new()
                } else {
                    format!("——{}", head)
                }
            ));
        }
    }
}

/// 任务结束时把事件总线标记为完成：订阅者的流自然收尾。
///
/// 用 Drop 保证所有退出路径（正常结束 / 出错 / 客户端走人）都覆盖到，
/// 不会出现「前端一直转圈等 done」的情况。
struct DoneGuard {
    bus: Arc<EventBus>,
}

impl Drop for DoneGuard {
    fn drop(&mut self) {
        // 统一兜底发一条 done 再收尾。
        //
        // 任务有十来个提前结束的出口（模型报错、命令超时停不下来、宽限期
        // 到了、用户停止、PTY 写失败……），逐个补 done 很容易漏一个；
        // 漏了的话，断线重连的客户端把缓冲里的事件读完、连接一断，
        // 界面会停在「执行中」。前端对重复的 done 已经去重。
        let _ = self.bus.publish(format!(
            "data: {}\n\n",
            serde_json::json!({"type": "done"})
        ));
        self.bus.mark_done();
    }
}

impl Drop for TurnRecorder {
    fn drop(&mut self) {
        // 正常路径已经在发 done 之前 save 过了；这里兜住所有提前 return
        // （前端断开、模型报错、审批超时……），保证不会漏记。
        self.save();
    }
}

pub struct AgentRun {
    pub id: String,
    pub sid: String,
    /// 创建时刻：用于清理卡死（前端异常消失、任务 panic）的僵尸 run
    created: std::time::Instant,
    /// 待审批命令 + 决定回传通道
    pending: Mutex<Option<(PendingCommand, oneshot::Sender<(Decision, Option<String>)>)>>,
    /// 当前步骤号（前端用来对齐卡片）
    step: AtomicU64,
    /// 是否已结束（done 已发出，可以开始新任务）
    finished: Mutex<bool>,
    /// 结束时刻：用于判断「客户端重试」的时间窗口
    finished_at: Mutex<Option<std::time::Instant>>,
    /// 事件总线：事件先存下来再广播，客户端断线重连能补上漏掉的
    bus: Arc<EventBus>,
    /// 客户端掉线宽限计时
    grace: GraceTimer,
    /// 用户点了「停止」：不等宽限期，立刻收尾
    cancelled: AtomicBool,
    /// 本次任务的用户请求原文：用来判断「重发的同一条请求」
    user_text: Mutex<String>,
    /// 客户端生成的请求 id：同一条消息的所有重试共用一个 id。
    ///
    /// 光靠「文本相同」判断重试会误伤：用户 30 秒内又问了一遍同样的话
    /// 会被当成重试、直接回放旧答案。请求 id 能精确区分「同一次请求的重试」
    /// 和「用户真的又发了一条」。
    request_id: Mutex<String>,
    /// 本次任务写入的聊天会话 id（断线重连时回给前端，避免上下文分裂）
    conversation_id: Mutex<String>,
    /// 用户点「停止」时唤醒所有等待点（模型流 / 等审批 / 等命令）
    stop_notify: tokio::sync::Notify,
}

impl AgentRun {
    fn new(id: String, sid: String) -> Self {
        Self {
            id,
            sid,
            created: std::time::Instant::now(),
            pending: Mutex::new(None),
            step: AtomicU64::new(0),

            finished: Mutex::new(false),
            finished_at: Mutex::new(None),
            bus: Arc::new(EventBus::new()),
            grace: GraceTimer::new(),
            cancelled: AtomicBool::new(false),
            user_text: Mutex::new(String::new()),
            request_id: Mutex::new(String::new()),
            conversation_id: Mutex::new(String::new()),
            stop_notify: tokio::sync::Notify::new(),
        }
    }

    /// 本次请求的客户端 id（空 = 老客户端，只能按文本判断重试）。
    pub fn request_id(&self) -> String {
        self.request_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 记录客户端请求 id（任务开始时同步设置）。
    pub fn set_request_id(&self, id: &str) {
        *self.request_id.lock().unwrap_or_else(|e| e.into_inner()) = id.to_string();
    }

    /// 本次任务写入的聊天会话 id。
    pub fn conversation_id(&self) -> String {
        self.conversation_id
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 记录聊天会话 id（任务开始前同步设置）。
    pub fn set_conversation_id(&self, id: &str) {
        *self.conversation_id.lock().unwrap_or_else(|e| e.into_inner()) = id.to_string();
    }

    /// 本次任务的用户请求原文。
    pub fn user_text(&self) -> String {
        self.user_text.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 记录用户请求原文（任务开始时调用一次）。
    pub fn set_user_text(&self, text: &str) {
        *self.user_text.lock().unwrap_or_else(|e| e.into_inner()) = text.to_string();
    }

    /// 事件总线（客户端断线重连要靠它补发漏掉的事件）。
    pub fn bus(&self) -> Arc<EventBus> {
        self.bus.clone()
    }

    /// 用户点了「停止」：不等宽限期，立刻收尾。
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        // 唤醒所有还在等的地方：不唤醒的话，等审批 / 等命令的分支
        // 要等到超时（最长 10 分钟）才会发现「用户已经点了停止」。
        self.stop_notify.notify_waiters();
    }

    /// 是否被用户叫停。
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// 等到「用户点了停止」为止（已经停止时立即返回）。
    ///
    /// 先注册通知再检查标记：cancel() 可能正好发生在两者之间，
    /// 顺序反了会漏掉这一次唤醒，等审批的分支就又要干等 10 分钟。
    pub async fn wait_stop(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.stop_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }

    /// 客户端是否还在看。
    ///
    /// 还在 → 正常跑；不在了 → 最多等宽限期，等它回来接着跑。
    /// 返回 false 表示该收尾了（宽限期过了，或用户点了停止）。
    pub async fn wait_client(&self) -> bool {
        loop {
            if self.is_cancelled() {
                return false;
            }
            if self.bus.has_subscribers() {
                self.grace.seen();
                return true;
            }
            self.grace.gone();
            if self.grace.expired() {
                return false;
            }
            // 用 select 而不是纯 sleep：用户点停止时立刻醒来，
            // 不用再等最多 200ms 的轮询间隔。
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                _ = self.wait_stop() => {}
            }
        }
    }

    /// 前端提交审批结果。返回 false 表示没有待审批的命令（可能已超时）。
    pub fn decide(&self, decision: Decision, command: Option<String>) -> bool {
        if matches!(decision, Decision::Stop) {
            self.cancel();
        }
        let mut guard = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        match guard.take() {
            Some((_, tx)) => {
                let _ = tx.send((decision, command));
                true
            }
            None => false,
        }
    }

    /// 还认不认这个任务。
    ///
    /// * 还在跑 → 认；
    /// * 刚结束（30 秒内）→ 也认：客户端可能正好在「done 之后、结果收到之前」
    ///   掉了连接，带着同一条请求重试，这时要接回原结果而不是重跑一遍；
    /// * 结束很久了 → 不认，当成新任务（用户可能真的又问了一遍同样的话）。
    fn is_retryable(&self) -> bool {
        if !self.is_finished() {
            return true;
        }
        let at = *self.finished_at.lock().unwrap_or_else(|e| e.into_inner());
        at.map(|t| t.elapsed() < std::time::Duration::from_secs(30))
            .unwrap_or(false)
    }

    /// 任务是否已结束（done 已发出）。
    ///
    /// 用它在「能不能开始新任务」的判断上：done 之后前端就会允许用户
    /// 发下一条消息，服务端必须同步放开，否则新消息会被 409 拦住。
    pub fn is_finished(&self) -> bool {
        *self.finished.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 超过 2 小时还没结束的 run 一律视为僵尸（正常任务有步数上限 + 审批超时）。
    fn is_stale(&self) -> bool {
        self.created.elapsed() > Duration::from_secs(2 * 3600)
    }
}

/// 所有进行中的任务。
#[derive(Default)]
pub struct AgentStore {
    runs: Mutex<HashMap<String, Arc<AgentRun>>>,
}

impl AgentStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 创建一个任务；同一个会话同时只允许一个 agent 在跑。
    ///
    /// 两个任务同时操作同一个 PTY 是最糟糕的情况：都会写命令、都从回放
    /// 缓冲读输出，彼此把对方的输出当成自己的结果，表现就是命令乱序、
    /// 重复执行、AI 已经汇报完了终端里还在跑另一条命令。多开页面 / 多个
    /// 浏览器同时点发送很容易触发，所以必须在服务端做互斥，不能只靠前端
    /// 的 busy 状态（那只管得住当前页面）。
    pub fn create(&self, sid: &str) -> Result<Arc<AgentRun>, String> {
        let mut runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        // 顺手清掉已结束 / 僵尸任务，避免长期累积（每个 run 都会抓住一个 Session 引用）。
        // 已结束的留 30 秒：客户端可能刚好在 done 之后重试，要能接回原结果。
        runs.retain(|_, r| r.is_retryable() && !r.is_stale());
        if runs.values().any(|r| r.sid == sid) {
            return Err("该会话已有 AI 任务正在运行，请等它结束或先停止".to_string());
        }
        let id = format!("run-{}", random_id());
        let run = Arc::new(AgentRun::new(id.clone(), sid.to_string()));
        runs.insert(id, run.clone());
        Ok(run)
    }

    /// 把一个任务从表里移除（任务已完成、且要开始新任务时用）。
    pub fn remove(&self, id: &str) {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    /// 找出这个会话上的任务（包括刚结束、事件还没读完的）。
    ///
    /// 为什么连「已结束」的也要返回：客户端可能正好在任务跑完、
    /// 响应丢失的瞬间重试，此时它的结果还在事件缓冲里。如果这里直接
    /// 看不到它，服务端会当成新任务再跑一遍——同一串命令就被执行两次。
    /// 调用方会先比对「是不是同一条请求」，不是的话再把旧任务清掉。
    pub fn find_by_sid(&self, sid: &str) -> Option<Arc<AgentRun>> {
        let runs = self.runs.lock().unwrap_or_else(|e| e.into_inner());
        runs.values()
            .find(|r| r.sid == sid && !r.is_stale() && r.is_retryable())
            .cloned()
    }

    pub fn get(&self, id: &str) -> Option<Arc<AgentRun>> {
        self.runs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    /// 标记任务「逻辑上已结束」。
    ///
    /// 只是让 `create()` 知道这个会话可以开始新任务了；事件流仍然开着，
    /// 客户端还能把最后的输出读完（`is_done` 才是真正的收尾）。
    pub fn finish(&self, id: &str) {
        if let Some(run) = self.get(id) {
            // 先记结束时刻再置 finished：反过来的话，存在一个极短的窗口
            // 「is_finished 为真、finished_at 还是 None」，此时 is_retryable()
            // 会判 false，客户端带着同一个 runId 重试就接不回原任务了。
            {
                let mut at = run.finished_at.lock().unwrap_or_else(|e| e.into_inner());
                if at.is_none() {
                    *at = Some(std::time::Instant::now());
                }
            }
            *run.finished.lock().unwrap_or_else(|e| e.into_inner()) = true;
        }
    }
}

fn random_id() -> String {
    use std::io::Read;
    let mut buf = [0u8; 12];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// SSE 事件（发给前端的一行 JSON）。
fn ev(v: serde_json::Value) -> String {
    format!("data: {}\n\n", v)
}

/// 跑一次 agent 任务，事件通过 `tx` 推给前端。
///
/// 前端断开（`tx` 关闭）就立刻停下，不要继续烧 token。
#[allow(clippy::too_many_arguments)]
pub async fn run_task(
    run: Arc<AgentRun>,
    store: Arc<AgentStore>,
    cfg: AiConfig,
    session: Arc<Session>,
    user_text: String,
    history: Vec<ChatMessage>,
    terminal_context: Option<String>,
    memory: Option<String>,
    memory_path: std::path::PathBuf,
    conversation_id: String,
    history_store: Arc<ChatHistory>,
    bus: Arc<EventBus>,
) {
    crate::log_info!("AI agent 任务 {} 开始（会话 {}）：{}", run.id, run.sid, user_text);
    // 任务结束（无论怎么结束）都要通知总线，让前端的流收尾
    let _done = DoneGuard {
        bus: bus.clone(),
    };
    // 这次任务的一轮对话，结束时写进聊天记录。
    let mut recorder = TurnRecorder::new(history_store, conversation_id, user_text.clone());
    let mut messages: Vec<serde_json::Value> = Vec::new();
    // 只带最近 N 轮（一轮 = 用户 + 助手两条），由设置决定
    let keep = cfg.history_turns().saturating_mul(2);
    // 前端只发本次任务之前的历史；当前请求由下面的 user 消息单独拼入，
    // 所以这里保留完整的旧轮次即可（history 以 assistant 结尾是合法的）。
    let history: Vec<&ChatMessage> = if keep == 0 {
        Vec::new()
    } else if history.len() > keep {
        history[history.len() - keep..].iter().collect()
    } else {
        history.iter().collect()
    };
    for m in &history {
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        messages.push(serde_json::json!({"role": role, "content": m.content}));
    }
    // 把终端现状 + 工作目录作为第一条 system 之外的上下文
    let mut ctx = String::new();
    if let Some(t) = terminal_context.as_deref() {
        if !t.trim().is_empty() {
            ctx.push_str(&format!("终端最近的输出：\n```\n{}\n```\n\n", t));
        }
    }
    if let Some(mem) = memory.as_deref() {
        if !mem.trim().is_empty() {
            ctx.push_str(&format!(
                "长期记忆（你在之前的会话里记下的、关于这台机器和用户偏好的事实）：\n```\n{}\n```\n\n",
                mem
            ));
        }
    }
    ctx.push_str(&format!("当前 shell 提示符/工作目录参考：{}\n", session.cwd));
    messages.push(serde_json::json!({"role": "user", "content": format!("{}\n\n用户请求：{}", ctx, user_text)}));

    let _ = bus.publish(ev(serde_json::json!({"type": "start", "runId": run.id})));

    let started = std::time::Instant::now();
    let mut steps_used = 0usize;
    let mut mem_written = false;
    let mut repeats = 0usize;
    let mut last_cmd = String::new();
    // 整次任务内每条命令的执行次数（防止 A→B→A→B 式反复循环）
    let mut command_counts: HashMap<String, usize> = HashMap::new();

    // 步数按模型上下文窗口分档（1M 窗口 → 64 步），不再写死 12 步
    let max_steps = cfg.max_steps();
    // 「客户端断开」只记一次：流式循环每片都检查订阅者，
    // 不控制的话一条长回复会刷出几十条同样的日志。
    let mut logged_disconnect = false;
    for step in 0..max_steps {
        // 客户端断开了（关页面 / 网络抖动 / 手机切后台）：不要立刻收尾。
        // 手机上切一下后台 SSE 就断，原来的行为是任务直接死掉——模型调用
        // 的钱花了、命令也执行了一半，用户回来只看到半截输出。
        // 现在改成进入宽限期：等客户端回来接着跑；一直不回来才收尾。
        // 宽限期内**不会执行新命令**（没人看着时不该继续改机器），
        // 但当前这一步会跑完并把结果记进聊天记录。
        if !run.wait_client().await {
            crate::log_info!(
                "AI agent 任务 {} 客户端未在宽限期内回来，停止执行（第 {} 步）",
                run.id,
                step
            );
            store.finish(&run.id);
            return;
        }
        run.step.store(step as u64, Ordering::Relaxed);
        steps_used = step + 1;
        // ---- 1. 调模型（流式）----
        // 步数多、输出大时先把消息压进窗口预算，避免上游直接 400
        ai::trim_messages_to_budget(&cfg, &mut messages);
        let body = ai::request_body(
            &cfg,
            &ai::build_agent_messages(&cfg, &messages),
        );
        let mut rx = match ai::call_model_stream(&cfg, &body) {
            Ok(r) => r,
            Err(e) => {
                let _ = bus.publish(ev(serde_json::json!({"type": "error", "error": e})));
                store.finish(&run.id);
                return;
            }
        };

        let mut acc = String::new();
        let mut stderr = String::new();
        let mut ok = false;
        // 已经通过 `md` 事件发到前端的字节数。命令标签/代码块出现后，后面的
        // 文字先扣住不发：很多模型会在标签后面补一段「已完成」的结论，旧实现
        // 会把它立刻显示出来，然后才执行命令——用户看到的就是
        // 「都汇报完了才去执行命令」。正确顺序是先执行、拿到输出，再总结。
        //
        // 流式过程中只能先按「看起来像命令」扣住；等整段回复收完，再用
        // `first_command_start` 确认真正的命令位置，避免把普通代码块也永久扣住。
        let mut md_sent = 0usize;
        let mut md_hold: Option<usize> = None;
        loop {
            // 等模型下一片，同时能被「停止」唤醒：模型偶尔会停顿好几秒
            // 才吐下一片，只靠每片检查 cancelled 的话，用户点了停止还要
            // 干等到下一片来才真正停。
            let next = tokio::select! {
                next = rx.recv() => next,
                _ = run.wait_stop() => None,
            };
            let Some(evt) = next else {
                // 用户点了「停止」：立刻中断模型流，不用等它跑完。
                // （只是「客户端断开」的话，模型流会继续跑完——钱已经花了，
                //    输出还能补发给重连的客户端。）
                if run.is_cancelled() {
                    crate::log_info!("AI agent 任务 {} 用户点了停止，中止模型流", run.id);
                } else {
                    // 模型流正常结束（没有更多事件）
                    break;
                }
                drop(rx);
                store.finish(&run.id);
                return;
            };
            if run.is_cancelled() {
                crate::log_info!("AI agent 任务 {} 用户点了停止，中止模型流", run.id);
                drop(rx);
                store.finish(&run.id);
                return;
            }
            if !run.bus.has_subscribers() {
                // 客户端断了，但这次模型调用已经付过钱了：让它跑完，
                // 输出照样记进聊天记录，客户端回来能补看到。
                // 只是不再往下走命令——没人看着别改机器。
                if !logged_disconnect {
                    logged_disconnect = true;
                    crate::log_info!(
                        "AI agent 任务 {} 客户端断开，等待宽限期，模型流继续跑完",
                        run.id
                    );
                }
            } else {
                logged_disconnect = false;
            }
            match evt {
                ai::StreamEvent::Line(line) => {
                    if let Some(d) = ai::parse_sse_line(&line) {
                        if let Some(err) = d.error {
                            let msg = ai::friendly_model_error(&err);
                            let _ = bus.publish(ev(serde_json::json!({"type": "error", "error": msg})));
                            store.finish(&run.id);
                            return;
                        }
                        if !d.text.is_empty() {
                            acc.push_str(&d.text);
                            // 命令标签/代码块之后的文字先扣住；之前的说明正常流式显示。
                            if let Some(pos) = find_command_block_start(&acc) {
                                md_hold = Some(md_hold.map(|h| h.min(pos)).unwrap_or(pos));
                            }
                            let emit_to = md_hold.unwrap_or(acc.len());
                            if emit_to > md_sent {
                                let piece = acc[md_sent..emit_to].to_string();
                                if !piece.is_empty() {
                                    // 流式文本：前端把它渲染成面板里的 Markdown
                                    recorder.push_text(&piece);
                                    let _ = bus.publish(ev(serde_json::json!({"type": "md", "text": piece})));
                                }
                                md_sent = emit_to;
                            }
                        }
                        if d.done {
                            ok = true;
                        }
                    }
                }
                ai::StreamEvent::Finished { success, stderr: se } => {
                    ok = success;
                    stderr = se;
                    break;
                }
            }
        }
        if !ok && acc.is_empty() {
            let _ = bus.publish(ev(serde_json::json!({
                    "type": "error",
                    "error": format!("模型调用失败：{}", ai::friendly_model_error(&stderr)),
                })));
            store.finish(&run.id);
            return;
        }

        // 模型可能用 <remember>…</remember> 记下跨会话的事实
        for fact in ai::extract_memories(&acc) {
            if cfg.memory_enabled {
                match ai::append_memory(&memory_path, &fact, cfg.memory_max_chars()) {
                    Ok(()) => {
                        mem_written = true;
                        crate::log_info!("AI 记下一条长期记忆：{}", fact)
                    }
                    Err(e) => crate::log_warn!("长期记忆写入失败：{}", e),
                }
            }
        }

        messages.push(serde_json::json!({"role": "assistant", "content": acc.clone()}));

        // ---- 2. 有命令就等审批、执行、回收输出 ----
        let cmds = ai::extract_commands(&acc);
        // 用整段回复精确判断「命令从哪开始」：流式阶段扣住的普通代码块
        // 如果并不是命令，在这里补发出去，界面不会凭空少一段说明。
        // 只有真的提取到命令时才把命令块本身及之后的内容继续扣住。
        let hold_to = if cmds.is_empty() {
            acc.len()
        } else {
            ai::first_command_start(&acc).unwrap_or(acc.len())
        };
        if hold_to > md_sent {
            let piece = acc[md_sent..hold_to].to_string();
            if !piece.trim().is_empty() {
                recorder.push_text(&piece);
                let _ = bus.publish(ev(serde_json::json!({"type": "md", "text": piece})));
            }
        }
        crate::log_info!(
            "AI agent {} 第 {} 步：模型输出 {} 字符，识别到 {} 条命令",
            run.id,
            step,
            acc.chars().count(),
            cmds.len()
        );
        let Some(cmd) = cmds.into_iter().next() else {
            // 先落盘再发 done：前端收到 done 会立刻允许下一条消息，
            // 若这时会话还没写入，续聊会被当成新会话而断开。
            recorder.save();
            let _ = bus.publish(ev(serde_json::json!({"type": "done", "text": acc.clone()})));
            // 先标记 run 结束，再做「长期记忆兜底提取」这个额外的模型请求：
            // 前端已经收到 done、可以立刻发下一条任务，服务端不能还因为旧 run
            // 没结束而返回 409「已有任务正在运行」。
            store.finish(&run.id);
            // 兜底记忆提取可能还要几秒（又一次模型调用）。放到后台任务里做，
            // 不占着当前任务的收尾：DoneGuard 会在函数返回时立刻关闭事件流，
            // 前端不会因为「done 之后还挂着连接」而以为任务没结束。
            tokio::spawn(async move {
                finish_with_memory(
                    &cfg,
                    &user_text,
                    &acc,
                    &memory_path,
                    mem_written,
                    &run.id,
                    steps_used,
                    started,
                )
                .await;
            });
            return;
        };

        if cmd.command == last_cmd {
            repeats += 1;
            if repeats >= MAX_REPEAT {
                recorder.push_text("\n> 该命令已被跳过多次，先停下。换个思路再试。\n");
                let _ = bus.publish(ev(serde_json::json!({
                        "type": "md",
                        "text": "\n> 该命令已被跳过多次，先停下。换个思路再试。\n",
                    })));
                recorder.save();
                let _ = bus.publish(ev(serde_json::json!({"type": "done"})));
                store.finish(&run.id);
                return;
            }
        } else {
            repeats = 0;
            last_cmd = cmd.command.clone();
        }

        // 整次任务内的总次数：模型交替提议 A、B、A、B 时，只看「连续重复」
        // 是抓不到的，会一路跑到步数上限。
        let times = command_counts
            .entry(cmd.command.clone())
            .or_insert(0usize);
        *times += 1;
        if *times > MAX_SAME_COMMAND {
            let notice = format!(
                "\n> 命令 `{}` 已经在本次任务里执行/提议了 {} 次，先停在这里。请根据已有输出给出结论，或换一种做法。\n",
                cmd.command, *times
            );
            recorder.push_text(&notice);
            let _ = bus.publish(ev(serde_json::json!({
                    "type": "md",
                    "text": notice,
                })));
            recorder.save();
            let _ = bus.publish(ev(serde_json::json!({"type": "done"})));
            crate::log_warn!(
                "AI agent {} 检测到重复命令循环，停止：{}（第 {} 次）",
                run.id, cmd.command, *times
            );
            store.finish(&run.id);
            return;
        }

        let pending = PendingCommand {
            command: cmd.command.clone(),
            purpose: cmd.purpose.clone(),
            danger: cmd.danger,
            reason: cmd.reason.clone(),
            needs_approval: cmd.needs_approval,
        };

        // 不涉及「删除 / 改写文件」的命令一律直接执行，不再逐步打断用户；
        // 只有删除、覆盖文件、关机/格式化这类才弹确认（高危还要二次确认）。
        let auto = !pending.needs_approval;
        // 最终要执行的命令（用户可能改过）
        let mut to_run = pending.command.clone();

        // 无论是否需要审批，都先发给前端一张卡片：
        // 面板要把「命令 + 目的 + 输出」记录下来，auto 的命令也不该凭空消失。
        // 聊天记录不在这里记：用户可能跳过/停止，没真正执行的命令不该
        // 在历史里显示成「已执行」；等审批完、确定要跑时再记（见下方）。
        let _ = bus.publish(ev(serde_json::json!({
                "type": "command",
                "step": step,
                "runId": run.id,
                "command": pending.command,
                "purpose": pending.purpose,
                "danger": pending.danger,
                "reason": pending.reason,
                "needsApproval": pending.needs_approval,
                "auto": auto,
            })));

        if !auto {
            let (ptx, mut prx) = oneshot::channel();
            {
                let mut guard = run.pending.lock().unwrap_or_else(|e| e.into_inner());
                *guard = Some((pending.clone(), ptx));
            }

            let decided = tokio::select! {
                r = tokio::time::timeout(APPROVAL_TIMEOUT, &mut prx) => Some(r),
                // 用户点了「停止」：立刻收尾，不用再等审批。
                _ = run.wait_stop() => None,
                // 客户端断开时不要干等 10 分钟审批：等它回来接着批，
                // 宽限期到了就当没人管，收尾。
                _ = bus.wait_no_subscribers() => {
                    if !run.wait_client().await {
                        run.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
                        crate::log_info!("AI agent 任务 {} 等待审批时客户端未回来，停止", run.id);
                        store.finish(&run.id);
                        return;
                    }
                    // 客户端回来了：重新等一次审批决定
                    tokio::select! {
                        r = tokio::time::timeout(APPROVAL_TIMEOUT, &mut prx) => Some(r),
                        _ = run.wait_stop() => None,
                    }
                }
            };
            let (decision, edited) = match decided {
                Some(Ok(Ok(v))) => v,
                // 超时 / 用户停止 / 前端断开：按停止处理
                _ => {
                    run.pending.lock().unwrap_or_else(|e| e.into_inner()).take();
                    recorder.save();
                    let _ = bus.publish(ev(serde_json::json!({"type": "done"})));
                    store.finish(&run.id);
                    return;
                }
            };

            match decision {
                Decision::Stop => {
                    recorder.save();
                    let _ = bus.publish(ev(serde_json::json!({"type": "done"})));
                    store.finish(&run.id);
                    return;
                }
                Decision::Skip => {
                    messages.push(serde_json::json!({
                        "role": "user",
                        "content": "用户跳过了这条命令，不要重复它，换一种方式或直接给结论。",
                    }));
                    continue;
                }
                Decision::Run => {}
            }

            // 用户在卡片里改过命令就用改后的
            if let Some(c) = edited {
                let c = c.trim().to_string();
                if !c.is_empty() {
                    // 改完可能变成高危命令，必须重新确认
                    let verdict = ai::classify_for_exec(&c);
                    if verdict.danger && !pending.danger {
                        let _ = bus.publish(ev(serde_json::json!({
                                "type": "error",
                                "error": format!(
                                    "改后的命令属于高危操作（{}），已放弃执行",
                                    verdict.reason
                                ),
                            })));
                        messages.push(serde_json::json!({
                            "role": "user",
                            "content": "用户改后的命令被判定为高危，未执行。请换一个安全的方案。",
                        }));
                        continue;
                    }
                    to_run = c;
                }
            }
        }

        // 到这里命令一定会执行（用户改过就用改后的版本），记进聊天记录。
        recorder.push_command(&HistoryCommand {
            command: to_run.clone(),
            purpose: pending.purpose.clone(),
            output: String::new(),
            exit_code: None,
            timed_out: false,
            danger: pending.danger,
            auto,
        });

        // ---- 3. 写进 PTY 并回收输出 ----
        // 先清掉 shell 里可能存在的半行输入：用户在终端里敲了一半中文后
        // 交给 AI，那一行还在 readline 缓冲区里；如果不先清，命令会和它粘在一起
        // （实测 `帮我看看磁盘 df -h`）。Ctrl+C 是唯一无条件生效的清除方式。
        // 这一步必须在**服务端**做：浏览器发出的 Ctrl+C 走 WebSocket，
        // 和这里写 PTY 是两条通道，谁先到达不确定。
        //
        // bash 会话有 PROMPT_COMMAND 注入的完成标记：等 Ctrl+C 后的提示符
        // 真正出现再开始写命令，避免把「^C 回显」算进下一条命令的输出。
        let mut marker_supported = session.supports_prompt_marker();
        let clear_before = session.output_seq();
        let _ = session.write_input(vec![0x03]).await;
        if marker_supported {
            // 同时验证标记是否真的生效：用户的 .bashrc 可能覆盖 PROMPT_COMMAND，
            // 或者会话里 exec 过别的 shell。1200ms 内没看到标记就退回
            // 「输出安静」判断，避免每条命令都白等 3 分钟超时。
            let (_, _, missing) = session.wait_for_prompt(clear_before, 1200).await;
            if missing {
                marker_supported = false;
                crate::log_warn!(
                    "AI agent {} 会话 {} 的提示符完成标记未生效，退回输出静默判断",
                    run.id,
                    session.id
                );
            }
        } else {
            // 非 bash：没有完成标记，只能等一小段回显
            let clear_at = session.output_seq();
            for _ in 0..12 {
                if session.output_seq() > clear_at {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        let seq = session.output_seq();
        let mut bytes = to_run.as_bytes().to_vec();
        bytes.push(b'\r');
        if let Err(e) = session.write_input(bytes).await {
            recorder.drop_last_command();
            let _ = bus.publish(ev(serde_json::json!({"type": "error", "error": e})));
            store.finish(&run.id);
            return;
        }
        let _ = bus.publish(ev(serde_json::json!({
                "type": "exec",
                "step": step,
                "command": to_run,
            })));

        let cmd_started = std::time::Instant::now();
        // 命令等待也要能被「停止 / 关页面」打断：SSE 连接一断开就 Ctrl+C
        // 收尾，不要让用户点了停止后服务端还因为旧任务在等命令而返回 409。
        let mut wait_command = Box::pin(async {
            if marker_supported {
                session.wait_for_prompt(seq, CMD_TIMEOUT_MS).await
            } else {
                let (text, _seq2, to) = session.wait_quiet(seq, QUIET_MS, CMD_TIMEOUT_MS).await;
                (text, None, to)
            }
        });
        let (output, exit_code, timed_out) = tokio::select! {
            r = &mut wait_command => r,
            // 用户点了「停止」：当前命令已经在 PTY 里跑了，先让它跑完
            // （立刻 Ctrl+C 可能留下半截输出），但不再回灌模型、也不再执行后续命令。
            _ = run.wait_stop() => {
                crate::log_info!("AI agent 任务 {} 等待命令时用户点了停止", run.id);
                let _ = session.write_input(vec![0x03]).await;
                store.finish(&run.id);
                return;
            }
            _ = bus.wait_no_subscribers() => {
                // 命令已经写进 PTY 了，让它跑完；但客户端不在，
                // 拿到输出后不再回灌模型、也不再执行后续命令。
                if !run.wait_client().await {
                    let _ = session.write_input(vec![0x03]).await;
                    crate::log_info!("AI agent 任务 {} 等待命令时客户端未回来，已停止", run.id);
                    store.finish(&run.id);
                    return;
                }
                // 客户端回来了：继续等这条命令跑完
                wait_command.await
            }
        };
        // 超时说明命令可能还在跑（tail -f、交互式程序、卡住的网络命令）。
        // 必须先 Ctrl+C 停掉它，否则下一轮会把下一条命令写进这个程序，
        // 表现就是命令乱序、同一个任务反复循环、AI 汇报完了还在执行旧命令。
        if timed_out {
            crate::log_warn!(
                "AI agent {} 第 {} 步命令超时，发送 Ctrl+C 停止：{}",
                run.id, step, to_run
            );
            let _ = session.write_input(vec![0x03]).await;
            if marker_supported {
                let after = session.output_seq();
                let (_, _, still_running) = session.wait_for_prompt(after, 2_000).await;
                if still_running {
                    // 第二次 Ctrl+C：有些程序第一次只清行/退出插入模式。
                    let _ = session.write_input(vec![0x03]).await;
                    let after = session.output_seq();
                    let (_, _, still_running) = session.wait_for_prompt(after, 1_500).await;
                    if still_running {
                        // 还停不下来就不能再往 PTY 写命令了：下一条会被这个
                        // 程序当成输入吃掉，表现就是命令乱序、反复循环。
                        let _ = bus.publish(ev(serde_json::json!({
                                "type": "error",
                                "error": format!(
                                    "命令无法中断，任务已停止：{}（请回到终端手动处理）",
                                    to_run
                                ),
                            })));
                        crate::log_warn!(
                            "AI agent {} 第 {} 步 Ctrl+C 后仍未回到提示符，终止任务：{}",
                            run.id, step, to_run
                        );
                        store.finish(&run.id);
                        return;
                    }
                }
            } else {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
        crate::log_info!(
            "AI agent {} 第 {} 步执行完成：{} (exit={:?}, 耗时={}ms, timeout={})",
            run.id,
            step,
            to_run,
            exit_code,
            cmd_started.elapsed().as_millis(),
            timed_out
        );
        // 命令已经写进 PTY（只能让它自己跑完），但客户端不在就没必要再回灌模型。
        if !run.wait_client().await {
            crate::log_info!("AI agent 任务 {} 命令执行后客户端未回来，停止", run.id);
            store.finish(&run.id);
            return;
        }
        // 单条命令回灌上限按上下文窗口的 10% 推导
        let observe = cfg.observe_chars();
        let cleaned = clean_output(&output, &to_run);
        crate::log_debug!(
            "AI agent {} 第 {} 步原始输出={:?} 清洗后={:?}",
            run.id, step, output, cleaned
        );
        let trimmed = clamp_chars(&cleaned, observe);
        // 面板要显示这次命令的实际输出（截断到界面合理的长度即可），
        // 模型侧仍然用 `trimmed`，避免把过长的输出喂回模型。
        let shown = clamp_chars(&cleaned, 2000);
        // 聊天记录：把这次命令的输出补到刚才那张卡片上
        recorder.fill_command_output(&shown, exit_code, timed_out);
        let _ = bus.publish(ev(serde_json::json!({
                "type": "observed",
                "step": step,
                "timedOut": timed_out,
                "exitCode": exit_code,
                "output": shown,
            })));

        // 没有输出时也要明确告诉模型「命令是执行完了的」，否则模型容易
        // 把空输出当失败、反复重试同一条命令（cd / export / true 很常见）。
        let output_for_model = if trimmed.trim().is_empty() {
            "（命令执行完成，没有输出）".to_string()
        } else {
            trimmed
        };
        let timeout_note = if timed_out {
            "；注意：命令超过最长等待时间，已被 Ctrl+C 中断，这里只是中断前读到的部分输出"
        } else {
            ""
        };
        messages.push(serde_json::json!({
            "role": "user",
            "content": format!(
                "命令 `{}` 已执行结束（退出码：{}{}）。输出如下（可能含提示符，请忽略提示符本身）：\n```\n{}\n```\n继续：若目标未达成，给出下一条命令；若已达成，用 Markdown 总结。",
                to_run,
                exit_code.map(|c| c.to_string()).unwrap_or_else(|| "未知（非 bash shell）".to_string()),
                timeout_note,
                output_for_model
            ),
        }));
    }

    let notice = "\n> 已达到单次任务的步数上限，先停在这里。\n";
    recorder.push_text(notice);
    let _ = bus.publish(ev(serde_json::json!({
            "type": "md",
            "text": notice,
        })));
    recorder.save();
    let _ = bus.publish(ev(serde_json::json!({"type": "done"})));
    crate::log_info!(
        "AI agent 任务 {} 结束（达到步数上限 {} 步，耗时 {:?}）",
        run.id,
        steps_used,
        started.elapsed()
    );
    store.finish(&run.id);
}

/// 收尾：打印完成日志；如果这一轮模型没主动写长期记忆，再用一次小请求兜底提取。
///
/// 模型（尤其是小模型）经常只在正文里说「我记住了」，并不输出 <remember>，
/// 导致长期记忆一直是空的。这里加一道确定性兜底：让模型只做一件事——
/// 判断这轮对话有没有值得长期记住的稳定事实，有就输出一句话。
#[allow(clippy::too_many_arguments)]
async fn finish_with_memory(
    cfg: &crate::ai::AiConfig,
    user_text: &str,
    answer: &str,
    memory_path: &std::path::Path,
    mem_written: bool,
    run_id: &str,
    steps: usize,
    started: std::time::Instant,
) {
    crate::log_info!(
        "AI agent 任务 {} 结束（{} 步，耗时 {:?}，记忆写入={}）",
        run_id,
        steps,
        started.elapsed(),
        mem_written
    );
    if mem_written || !cfg.memory_enabled || answer.trim().is_empty() {
        return;
    }
    if memory_path.as_os_str().is_empty() {
        return;
    }

    let mut probe_cfg = cfg.clone();
    probe_cfg.max_tokens = 256;
    probe_cfg.temperature = 0.0;
    probe_cfg.reasoning_effort = String::new();
    probe_cfg.stream = true;

    let messages = vec![
        serde_json::json!({
            "role": "system",
            "content": "你是记忆提取器。判断这轮对话里是否包含值得跨会话长期记住的稳定事实：机器用途、硬件规格、目录约定、装过的服务、用户的偏好/习惯/长期计划。只输出一条不超过 80 字的中文陈述句；如果没有值得记的，只输出 NO。不要解释，不要加引号，不要输出其它内容。"
        }),
        serde_json::json!({
            "role": "user",
            "content": format!(
                "用户请求：{}

助手最终答复：{}",
                truncate_head(user_text, 800),
                truncate_head(answer, 2000)
            )
        }),
    ];
    let body = crate::ai::request_body(&probe_cfg, &messages);
    let Ok(mut rx) = crate::ai::call_model_stream(&probe_cfg, &body) else {
        return;
    };
    let mut text = String::new();
    while let Some(evt) = rx.recv().await {
        match evt {
            crate::ai::StreamEvent::Line(line) => {
                if let Some(d) = crate::ai::parse_sse_line(&line) {
                    if !d.text.is_empty() {
                        text.push_str(&d.text);
                    }
                }
            }
            crate::ai::StreamEvent::Finished { .. } => break,
        }
    }
    let fact = text.trim().trim_matches('"').trim();
    if fact.is_empty()
        || fact.eq_ignore_ascii_case("no")
        || fact.eq_ignore_ascii_case("none")
        || fact == "无"
    {
        return;
    }
    match crate::ai::append_memory(memory_path, fact, cfg.memory_max_chars()) {
        Ok(()) => crate::log_info!("AI 记下一条长期记忆（自动提取）：{}", fact),
        Err(e) => crate::log_warn!("长期记忆写入失败：{}", e),
    }
}

/// 找到模型回复里「第一条命令」的起始位置。
///
/// 除了 `<execute_command>`，模型也常用 ```bash / 裸 ``` 代码块。两种都要扣住，
/// 否则代码块后面的总结仍然会先于命令执行显示出来。
fn find_command_block_start(text: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    let mut best = lower.find("<execute_command");
    for marker in ["```", "~~~"] {
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(marker) {
            let pos = from + rel;
            let line_start = lower[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
            // 只看行首的围栏，正文里出现的三个反引号不算
            if lower[line_start..pos].trim().is_empty() {
                best = Some(best.map(|b| b.min(pos)).unwrap_or(pos));
                break;
            }
            from = pos + marker.len();
        }
    }
    best
}


/// 去掉输出里回显的命令行与尾部的提示符，只留下真正的结果。
///
/// 命令回显可能占不止一行（长命令在终端里会折行），所以只要开头几行都
/// 是命令本身（或它的片段）就一起去掉；末尾的提示符行同理，连空行一起清。
fn clean_output(raw: &str, command: &str) -> String {
    let mut lines: Vec<&str> = raw.lines().collect();
    // 头部：命令回显（含折行片段）。
    //
    // 关键是**只把开头连续、能拼回命令本身的行**当回显。旧实现用了
    // `cmd_compact.contains(line)`，于是 `printf "slow-start"` 的输出行
    // `slow-start`（确实是命令的子串）会被当成回显吃掉，模型收到空输出，
    // 就会以为命令没执行、反复重试或直接汇报错误结论。
    let cmd_compact = normalize_space(command);
    let mut echo = String::new();
    let mut consumed = 0usize;
    while consumed < 8 {
        let Some(first) = lines.first() else { break };
        let t = normalize_space(first);
        if t.is_empty() {
            lines.remove(0);
            consumed += 1;
            continue;
        }
        // 终端折行可能在词中间，也可能在空格处：两种拼接方式都试一次。
        // 只有「拼出来的仍然是命令的前缀」才算回显；一旦 echo 已经等于
        // 完整命令，后面的程序输出（哪怕内容与命令开头相同）都会停下。
        let joined_word = format!("{}{}", echo, t);
        let joined_space = if echo.is_empty() {
            t.clone()
        } else {
            format!("{} {}", echo, t)
        };
        let next = if cmd_compact.starts_with(&joined_word) {
            joined_word
        } else if cmd_compact.starts_with(&joined_space) {
            joined_space
        } else {
            break;
        };
        echo = next;
        lines.remove(0);
        consumed += 1;
        if echo == cmd_compact {
            break;
        }
    }
    // 少数终端在折行/重绘时会把完整命令后再跟一段前缀（历史测试里的形态）。
    // 只在已经完整匹配到命令之后清理，且片段足够长，避免误吃程序输出。
    while echo == cmd_compact && consumed < 8 {
        let Some(first) = lines.first() else { break };
        let t = normalize_space(first);
        if t.len() >= 8 && cmd_compact.starts_with(&t) {
            lines.remove(0);
            consumed += 1;
        } else {
            break;
        }
    }
    // 尾部：提示符行 + 空行
    while let Some(last) = lines.last() {
        let t = last.trim();
        let prompt = t.len() < 90
            && (t.ends_with('#') || t.ends_with('$') || t.ends_with('❯') || t.ends_with('%'));
        if t.is_empty() || prompt {
            lines.pop();
        } else {
            break;
        }
    }
    lines
        .iter()
        .map(|l| l.trim_start_matches('\r').trim_end_matches('\r'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// 把空白压成单个空格，用于比较「终端回显」与模型给的命令。
fn normalize_space(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 只保留开头 max 个字符（用于喂给记忆提取器，结论通常在前面）。
fn truncate_head(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect::<String>() + "…"
}

fn clamp_chars(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let tail: String = chars[chars.len() - max..].iter().collect();
    format!("…（前面还有 {} 字符已省略）\n{}", chars.len() - max, tail)
}

// ---------------------------------------------------------------- 意图识别

/// 判断用户输入是「shell 命令」还是「自然语言」。
///
/// 与前端 `web/src/detect.ts` 保持同一套规则（前端在按下回车时同步判断，
/// 这里用于 `/api/ai/detect` 与测试）。判断顺序（命中即返回）：
///
/// 1. 以 `!` 开头 → 强制当命令（去掉 `!`）
/// 2. 以 `#` 或 `?` 开头 → 强制当自然语言
/// 3. 含换行且每行都像命令 → 命令（粘贴多行脚本）
/// 4. 有 shell 元字符 → 命令
/// 5. 首个可执行 token（跳过 sudo/env/timeout）是路径 / 已知命令 → 命令
/// 6. 带 `-x` / `--long` 参数 → 命令
/// 7. 多词纯英文且首词是歧义词 → 自然语言
/// 8. 其余 → 自然语言
pub fn detect_kind(text: &str) -> (&'static str, String) {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix('!') {
        return ("command", rest.trim().to_string());
    }
    if let Some(rest) = t.strip_prefix('#').or_else(|| t.strip_prefix('?')) {
        return ("natural", rest.trim().to_string());
    }
    if t.contains('\n') {
        let all_cmds = t
            .lines()
            .filter(|l| !l.trim().is_empty())
            .all(looks_like_command_line);
        if all_cmds {
            return ("command", t.to_string());
        }
        return ("natural", t.to_string());
    }
    if looks_like_command_line(t) {
        ("command", t.to_string())
    } else {
        ("natural", t.to_string())
    }
}

/// 中日韩字符判定：首词是中文就说明这是人话，不是命令。
fn is_cjk(c: char) -> bool {
    let u = c as u32;
    (0x4E00..=0x9FFF).contains(&u)        // 汉字
        || (0x3400..=0x4DBF).contains(&u) // 扩展 A
        || (0x3000..=0x303F).contains(&u) // 中文标点
        || (0xFF00..=0xFFEF).contains(&u) // 全角
        || (0x3040..=0x30FF).contains(&u) // 日文假名
        || (0xAC00..=0xD7AF).contains(&u) // 韩文
}

/// 服务端扫描 PATH 得到的命令清单，供前端判断「这一行是命令还是自然语言」。
///
/// 写死一张命令表永远会漏掉用户自己装的工具（opencode、lazygit、fnpack…），
/// 漏掉的后果是把命令当成一句话发给模型。这里同时把 shell 内建和常见别名
/// 带上，并在结果里统一小写（前端只做大小写无关的精确匹配）。
pub fn command_catalog() -> Vec<String> {
    use std::os::unix::fs::PermissionsExt;

    let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for word in BUILTINS.iter().chain(SHELL_WORDS.iter()) {
        set.insert(word.to_ascii_lowercase());
    }

    // 会话里 shell 用的 PATH 是固定的这一串（见 session::child_env），
    // 同时把服务进程自己的 PATH 合并进来（开发模式下可能是自定义的）。
    let mut paths: Vec<String> = vec![
        "/usr/local/sbin".into(),
        "/usr/local/bin".into(),
        "/usr/sbin".into(),
        "/usr/bin".into(),
        "/sbin".into(),
        "/bin".into(),
    ];
    if let Ok(extra) = std::env::var("PATH") {
        for dir in extra.split(':') {
            if !dir.is_empty() {
                paths.push(dir.to_string());
            }
        }
    }

    for dir in paths {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue;
            }
            // 只收普通可执行文件；符号链接也允许（很多命令是 update-alternatives 的链接）
            let Ok(meta) = std::fs::metadata(entry.path()) else {
                continue;
            };
            if !meta.is_file() || meta.permissions().mode() & 0o111 == 0 {
                continue;
            }
            if name.len() > 64 || name.contains(char::is_whitespace) {
                continue;
            }
            set.insert(name.to_ascii_lowercase());
        }
    }
    set.into_iter().collect()
}


/// shell 内建命令 + 常见别名（不需要在 PATH 里找）
const BUILTINS: &[&str] = &[
    "cd", "ls", "ll", "la", "pwd", "echo", "export", "unset", "alias", "source", ".", "exit",
    "history", "jobs", "fg", "bg", "kill", "killall", "wait", "set", "unset", "read", "printf",
    "test", "[", "true", "false", "shift", "eval", "exec", "type", "command", "builtin", "ulimit",
    "umask", "trap", "return", "local", "declare", "readonly", "let", "time", "clear", "reset",
];

/// 「一定是命令」的常见词：即使后面跟的是普通单词也当命令。
///
/// 例如 `docker ps`、`git status` 不能被误判成自然语言；
/// 而 `install docker please` 里 `install` 虽然也是 /usr/bin 里的程序，
/// 却明显是一句英语，要当自然语言。
const SHELL_WORDS: &[&str] = &[
    "ls", "ll", "la", "cd", "pwd", "cat", "less", "more", "head", "tail", "grep", "rg", "awk",
    "sed", "find", "xargs", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "ln", "chmod", "chown",
    "tar", "zip", "unzip", "gzip", "df", "du", "free", "ps", "top", "htop", "kill", "killall",
    "pkill", "systemctl", "service", "journalctl", "dmesg", "lsblk", "mount", "umount", "fdisk",
    "docker", "podman", "git", "npm", "pnpm", "yarn", "node", "python", "python3", "pip", "pip3",
    "curl", "wget", "ssh", "scp", "rsync", "ping", "dig", "nslookup", "ss", "netstat", "ip",
    "ifconfig", "iptables", "ufw", "apt", "apt-get", "yum", "dnf", "apk", "pacman", "make",
    "cargo", "go", "java", "vim", "vi", "nano", "code", "tmux", "screen", "echo", "export",
    "source", "alias", "history", "clear", "reset", "exit", "reboot", "shutdown", "uname",
    "whoami", "id", "env", "which", "whereis", "stat", "file", "wc", "sort", "uniq", "diff",
    "patch", "md5sum", "sha256sum", "base64", "openssl", "crontab", "useradd", "userdel",
    "passwd", "su", "sudo", "chroot", "nohup", "bg", "fg", "jobs", "test",
];


/// 一整行看起来像不像 shell 命令（而不是英语/中文句子）。
///
/// 与前端保持一致：先跳过 `sudo`/`env`/`timeout` 这类前缀，找到真正执行的命令；
/// 它是路径、已安装命令、或带参数时判为命令，否则按自然语言。
pub(crate) fn looks_like_command_line(line: &str) -> bool {
    let line = line.trim();
    if line.is_empty() {
        return false;
    }

    let tokens: Vec<&str> = line.split_whitespace().collect();

    // 首词含中日韩字符 → 那是人话（中文不会是命令名）。
    // 只判首词，是为了保住 `cat 你好.txt`、`grep 中文 note.md` 这类命令。
    if tokens.first().map(|t| t.chars().any(is_cjk)).unwrap_or(false) {
        return false;
    }

    // 有 shell 元字符 → 一定是命令。
    // 只用「几乎不可能出现在英文句子里」的一批：管道、重定向、命令分隔、变量、
    // 命令替换、通配、赋值。括号/方括号/反斜杠在自然语言里也可能出现，不参与判断。
    const META: &[char] = &['|', '>', '<', ';', '&', '$', '`', '*', '='];
    if line.chars().any(|c| META.contains(&c)) {
        return true;
    }

    let Some(head) = first_executable_token(&tokens) else {
        return false;
    };

    // 多词纯英文 + 首词是「英文单词也是命令」的歧义词 → 英语句子。
    // 这一步必须排在「已安装命令」之前：`install`、`find`、`date` 都是
    // /usr/bin 里的真实程序，只看 PATH 会把 `install docker please` 当命令。
    if tokens.len() >= 3
        && tokens.iter().all(|t| t.chars().all(|c| c.is_ascii_alphabetic()))
        && AMBIGUOUS_WORDS.contains(&head.to_ascii_lowercase().as_str())
    {
        return false;
    }

    // 路径形式一定是命令：./deploy.sh、/usr/bin/htop、~/bin/x
    if head.contains('/') || head.starts_with('~') {
        return true;
    }
    // 已安装的命令 → 命令（即使后面跟了中文参数）
    if is_installed_command(head) {
        return true;
    }
    // 带 `-x` / `--long` 参数 → 命令
    if tokens.iter().any(|t| is_option(t)) {
        return true;
    }
    false
}

/// 前缀命令：它们后面才是真正执行的命令。
const WRAPPERS: &[&str] = &[
    "sudo", "doas", "env", "exec", "command", "builtin", "time", "nohup", "setsid", "strace",
    "ltrace", "watch", "xargs", "eval", "nice", "ionice", "stdbuf", "proxychains",
    "proxychains4", "torsocks", "timeout",
];

/// 前缀命令自己的选项/参数形态（`-u`、`-n 5`、`FOO=1`）
fn is_wrapper_arg(tok: &str) -> bool {
    if tok.is_empty() {
        return false;
    }
    if tok.starts_with('-') {
        return tok.len() > 1;
    }
    tok.chars().all(|c| c.is_ascii_digit())
        || (tok.contains('=')
            && tok
                .split('=')
                .next()
                .map(|k| {
                    !k.is_empty()
                        && k.chars().next().map(|c| c.is_ascii_alphabetic() || c == '_').unwrap_or(false)
                        && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                })
                .unwrap_or(false))
}

/// `sudo -u root ls`：`-u` 后面那个值是用户名，不是命令。
const WRAPPER_VALUE_OPTS: &[&str] = &["-u", "--user", "-g", "--group", "-p", "--prompt", "-h"];

fn first_executable_token<'a>(tokens: &'a [&'a str]) -> Option<&'a str> {
    let mut i = 0usize;
    while i < tokens.len() {
        let tok = tokens[i];
        if !WRAPPERS.contains(&tok.to_ascii_lowercase().as_str()) {
            return Some(tok);
        }
        i += 1;
        while i < tokens.len() {
            let arg = tokens[i];
            if WRAPPER_VALUE_OPTS.contains(&arg) {
                i += 2;
                continue;
            }
            if is_wrapper_arg(arg) {
                i += 1;
                continue;
            }
            break;
        }
    }
    None
}

fn is_option(tok: &str) -> bool {
    let mut chars = tok.chars();
    if chars.next() != Some('-') {
        return false;
    }
    match chars.next() {
        Some(c) => c.is_ascii_alphanumeric(),
        None => false,
    }
}

/// 命令是否已安装（在 PATH 里，或是 shell 内建/常见别名）。
fn is_installed_command(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    if BUILTINS.contains(&lower.as_str()) || SHELL_WORDS.contains(&lower.as_str()) {
        return true;
    }
    is_in_path(word)
}

/// 既是常见英文单词、又是真实可执行文件的命令名。
/// 整行由普通英文单词组成时，这些词出现在句首更可能是自然语言。
const AMBIGUOUS_WORDS: &[&str] = &[
    "install", "find", "test", "make", "touch", "watch", "sort", "head", "tail", "cut",
    "date", "host", "open", "say", "more", "less", "man", "info", "time", "which", "type",
    "file", "read", "play", "look", "print", "dir", "sleep", "wait", "id", "env", "at",
    "batch", "yes", "true", "false", "join", "split", "paste", "tr", "expr", "size", "stat",
];

fn is_in_path(word: &str) -> bool {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            if !dir.is_empty() && std::path::Path::new(dir).join(word).is_file() {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_keeps_finished_run_for_retry_window() {
        let store = AgentStore::new();
        let run = store.create("sid-1").expect("应该能创建");
        run.set_user_text("看看磁盘");
        run.set_request_id("req-1");
        store.finish(&run.id);
        // 刚结束：同一个会话还能找到它（前端重试要接回原结果）
        let found = store.find_by_sid("sid-1").expect("30 秒内应该还认得");
        assert_eq!(found.id, run.id);
        assert_eq!(found.request_id(), "req-1");
        // 但这时开新任务不能再被它挡住（done 已发，前端已允许下一条）
        store.remove(&found.id);
        assert!(store.create("sid-1").is_ok());
    }

    #[test]
    fn store_separates_runs_by_request_id() {
        let store = AgentStore::new();
        let run = store.create("sid-2").expect("应该能创建");
        run.set_request_id("req-a");
        assert_eq!(run.request_id(), "req-a");
        // 同一个会话第二个任务会被挡住（会话互斥）
        assert!(store.create("sid-2").is_err());
        // 不同会话互不影响
        assert!(store.create("sid-3").is_ok());
    }

    #[test]
    fn recorder_strips_tags_split_across_chunks() {
        // 标签被切在两片之间：逐片 strip 会漏掉后半片（`cute_command>`），
        // 增量过滤器必须跨片保持状态，直到闭合标签出现才整段丢弃。
        let store = Arc::new(ChatHistory::load(None));
        let mut rec = TurnRecorder::new(store.clone(), "conv-test".to_string(), "看看磁盘".to_string());
        rec.push_text("先看整体。");
        rec.push_text("<exec");
        rec.push_text("ute_command>\n<command>df -h</command>\n</execute_");
        rec.push_text("command>");
        rec.push_text("\n看完结论。");
        rec.save();
        let conv = store.get("conv-test").expect("应该有聊天记录");
        assert_eq!(conv.turns.len(), 1);
        let t = &conv.turns[0];
        assert!(t.assistant.contains("先看整体"), "正文不能丢: {}", t.assistant);
        assert!(t.assistant.contains("看完结论"), "后续正文不能丢: {}", t.assistant);
        assert!(!t.assistant.contains("execute"), "标签碎片必须清掉: {}", t.assistant);
        // 回放块里也不该有标签
        for b in &t.blocks {
            if let HistoryBlock::Text { text } = b {
                assert!(!text.contains("execute"), "文本块里有标签: {}", text);
            }
        }
    }

    #[test]
    fn detect_shell_command() {
        assert_eq!(detect_kind("ls -la").0, "command");
        assert_eq!(detect_kind("pwd").0, "command");
        assert_eq!(detect_kind("systemctl status nginx").0, "command");
        assert_eq!(detect_kind("/usr/bin/env bash").0, "command");
    }

    #[test]
    fn detect_natural_language() {
        assert_eq!(detect_kind("帮我看看磁盘满了吗").0, "natural");
        assert_eq!(detect_kind("install docker please").0, "natural");
        assert_eq!(detect_kind("my instance is slow, help me").0, "natural");
        // 中文开头的输入即使后面跟了英文命令名，也还是人话
        assert_eq!(detect_kind("帮我看看 df -h 的输出").0, "natural");
        assert_eq!(detect_kind("看一下内存占用 ls 一下").0, "natural");
    }

    /// 用户自己装的 CLI 也必须当命令执行。
    /// `opencode` 这类工具不在任何写死的词表里，过去会被当成一句话发给 AI。
    #[test]
    fn installed_tool_is_command() {
        assert_eq!(detect_kind("opencode --help").0, "command");
        assert_eq!(detect_kind("htop -d 5").0, "command");
        // 带中文参数也还是命令（cat 在固定词表里）
        assert_eq!(detect_kind("cat 你好.txt").0, "command");
        assert_eq!(detect_kind("grep 中文 note.md").0, "command");
        // 单独一个 opencode：只有真的装了才会被判成命令，没装的机器上跳过
        if is_in_path("opencode") {
            assert_eq!(detect_kind("opencode").0, "command");
        }
        // 无论装没装，都能在 PATH 扫描结果里找到它（前提是装了）
        if is_in_path("opencode") {
            assert!(command_catalog().iter().any(|c| c == "opencode"));
        }
    }

    /// 没有安装的命令 + 英文句子仍然按自然语言处理。
    #[test]
    fn unknown_words_stay_natural() {
        assert_eq!(detect_kind("hello").0, "natural");
        assert_eq!(detect_kind("please check my disks").0, "natural");
        // 括号、方括号、引号不该让英文句子变成命令
        assert_eq!(detect_kind("check (please) the disk").0, "natural");
        assert_eq!(detect_kind("why is it slow [help]").0, "natural");
        // 但 `=`、`>`、`|` 这类还是命令
        assert_eq!(detect_kind("echo a=1").0, "command");
        assert_eq!(detect_kind("ls > out.txt").0, "command");
    }

    /// 前缀命令要跳过：`sudo systemctl restart x` 真正执行的是 systemctl。
    #[test]
    fn wrapper_commands_are_skipped() {
        assert_eq!(detect_kind("sudo -u root systemctl restart nginx").0, "command");
        assert_eq!(detect_kind("env FOO=1 python3 app.py").0, "command");
        assert_eq!(detect_kind("timeout 10 ping -c 3 host").0, "command");
        assert_eq!(detect_kind("nohup ./server > out.log 2>&1 &").0, "command");
    }

    #[test]
    fn command_catalog_has_basics() {
        let catalog = command_catalog();
        assert!(catalog.iter().any(|c| c == "ls"));
        assert!(catalog.iter().any(|c| c == "bash" || c == "sh" || c == "dash"));
    }

    #[test]
    fn force_markers() {
        let (k, v) = detect_kind("!ls -la");
        assert_eq!(k, "command");
        assert_eq!(v, "ls -la");
        assert_eq!(detect_kind("#ls -la").0, "natural");
        assert_eq!(detect_kind("?df -h").0, "natural");
    }

    #[test]
    fn multiline_commands() {
        assert_eq!(detect_kind("cd /tmp\nls -la").0, "command");
        assert_eq!(detect_kind("cd /tmp\n帮我看看").0, "natural");
    }

    #[test]
    fn cjk_detection() {
        assert!(is_cjk('中'));
        assert!(is_cjk('，'));
        assert!(!is_cjk('a'));
    }

    #[test]
    fn clean_output_strips_echo_and_prompt() {
        let raw = "df -h\nFilesystem Size Used\n/dev/sda1 100G 50G\nroot@nas:~# ";
        let out = clean_output(raw, "df -h");
        assert!(!out.contains("df -h"));
        assert!(out.contains("/dev/sda1"));
        assert!(!out.ends_with('#'));
    }

    /// 命令里含 `printf "start\n"` 这类字面量时，程序输出的 `start`
    /// 不能被当成命令回显吃掉（旧实现用子串匹配，真的会整段吞掉）。
    #[test]
    fn clean_output_keeps_output_that_looks_like_command_fragment() {
        let raw = "printf \"slow-start\\n\"; sleep 2; printf \"slow-end\\n\"\r\n\r\nslow-start\r\nslow-end\r\n";
        let out = clean_output(
            raw,
            "printf \"slow-start\\n\"; sleep 2; printf \"slow-end\\n\"",
        );
        assert!(out.contains("slow-start"), "{out}");
        assert!(out.contains("slow-end"), "{out}");
        assert!(!out.contains("sleep 2"), "{out}");
        assert!(!out.starts_with('\r'), "{out:?}");
    }

    /// 长命令在终端里会折行，回显占好几行；提示符也可能带 `…root@nas:~$` 前缀。
    #[test]
    fn clean_output_strips_wrapped_echo() {
        let raw = "ps aux --sort=-%cpu | head -6\n\
                   ps aux --sort=-%cpu |\n\
                   UID   PID  %CPU COMMAND\n\
                   root  11  2.1 systemd\n\
                   root@nas:~$ ";
        let out = clean_output(raw, "ps aux --sort=-%cpu | head -6");
        assert!(out.contains("systemd"));
        assert!(!out.contains("ps aux"));
        assert!(!out.contains("root@nas"));
    }
}
