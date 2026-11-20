//! AI 助手的 HTTP 接口。
//!
//! 整个模块只在 `feature = "ai"` 下编译：普通版（`--no-default-features`）
//! 的二进制里**不会包含这些代码**，也不注册对应路由。

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::web::AppState;

// ------------------------------------------------------------------ AI 助手

/// 读长期记忆（跨会话保留的事实）。
pub async fn ai_get_memory(State(state): State<Arc<AppState>>) -> Response {
    let path = state.ai.memory_path();
    let text = if path.as_os_str().is_empty() {
        String::new()
    } else {
        crate::ai::read_memory(&path, state.ai.get().memory_max_chars())
    };
    axum::Json(serde_json::json!({"ok": true, "data": {"text": text}})).into_response()
}

/// 覆写长期记忆（设置窗里手动编辑；传空文本 = 清空）。
pub async fn ai_set_memory(
    State(state): State<Arc<AppState>>,
    body: Option<axum::Json<serde_json::Value>>,
) -> Response {
    let Some(axum::Json(payload)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "缺少请求体"})),
        )
            .into_response();
    };
    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    match state.ai.set_memory(&text) {
        Ok(()) => axum::Json(serde_json::json!({"ok": true, "data": {"text": text}})).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}


pub async fn ai_get_config(State(state): State<Arc<AppState>>) -> Response {
    axum::Json(serde_json::json!({
        "ok": true,
        "data": state.ai.get().public_view(),
    }))
    .into_response()
}

pub async fn ai_set_config(
    State(state): State<Arc<AppState>>,
    body: Option<axum::Json<serde_json::Value>>,
) -> Response {
    let patch = match body {
        Some(axum::Json(v)) => v,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"ok": false, "error": "缺少请求体"})),
            )
                .into_response()
        }
    };
    match state.ai.update(&patch) {
        Ok(cfg) => axum::Json(serde_json::json!({"ok": true, "data": cfg.public_view()})).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------- agent 接口

#[derive(serde::Deserialize)]
struct DetectBody {
    text: String,
}

/// 判断用户输入是 shell 命令还是自然语言。
///
/// 前端在终端里敲回车时同步判断（见 web/src/detect.ts），这个接口用于
/// 兜底与自动化测试，规则与前端保持一致。
async fn ai_detect(body: Option<axum::Json<DetectBody>>) -> Response {
    let Some(axum::Json(payload)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "缺少请求体"})),
        )
            .into_response();
    };
    let (kind, text) = crate::ai::agent::detect_kind(&payload.text);
    axum::Json(serde_json::json!({
        "ok": true,
        "data": {"kind": kind, "text": text},
    }))
    .into_response()
}

/// PATH 里的命令清单（含 shell 内建），供前端判断「命令 or 自然语言」。
///
/// 写死一张命令表永远会漏掉用户后来装的工具；这里每次请求都扫一遍目录，
/// 成本是几十微秒，前端只在页面启动时拉一次。
pub async fn ai_commands() -> Response {
    // 扫描 PATH 要读几十个目录，是阻塞 IO：放到阻塞线程池，别卡 async worker
    let commands = tokio::task::spawn_blocking(crate::ai::agent::command_catalog)
        .await
        .unwrap_or_default();
    axum::Json(serde_json::json!({
        "ok": true,
        "data": {"commands": commands},
    }))
    .into_response()
}

#[derive(serde::Deserialize)]
struct AgentStartBody {
    sid: String,
    text: String,
    #[serde(default)]
    messages: Vec<crate::ai::ChatMessage>,
    /// 续哪个会话（空 = 新会话）。服务端据此把这一轮追加到对应的历史里。
    #[serde(default, alias = "conversationId")]
    conversation_id: Option<String>,
    /// 断线重连：要接回的任务 id（前端从响应头 X-Run-Id 拿到的）
    #[serde(default, alias = "resumeRunId")]
    resume_run_id: Option<String>,
    /// 客户端生成的请求 id：同一条消息的所有重试共用同一个值。
    ///
    /// 比「比对文本」更准确：用户短时间内又问了一遍同样的话时，
    /// 不应该被当成重试、直接回放旧答案。
    #[serde(default, alias = "requestId")]
    request_id: Option<String>,
    /// 已经收到的最后一条事件序号：服务端从它之后接着发
    #[serde(default, alias = "afterSeq")]
    after_seq: u64,
}

/// 断线重连：接回正在跑的任务。
#[derive(serde::Deserialize)]
struct AgentResumeBody {
    /// 要接回的任务 id（前端从响应头 X-Run-Id 拿到的）
    #[serde(alias = "runId")]
    run_id: String,
    /// 已经收到的最后一条事件序号（从 SSE 的 id 字段拿）
    #[serde(default, alias = "afterSeq")]
    after_seq: u64,
}

/// 接回一个还在跑的任务，把断线期间漏掉的事件补上。
///
/// 手机上切后台、锁屏、地铁里网络抖动都会让 SSE 断掉。原来的行为是
/// 任务直接死掉——模型调用花了钱、命令执行了一半，用户回来只看到半截。
/// 现在任务会进入宽限期等客户端回来，这里就是它回来的入口。
async fn ai_agent_resume(
    State(state): State<Arc<AppState>>,
    body: Option<axum::Json<AgentResumeBody>>,
) -> Response {
    let Some(axum::Json(payload)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "缺少请求体"})),
        )
            .into_response();
    };
    let Some(run) = state.agents.get(&payload.run_id) else {
        // 任务已经结束或不存在：前端应当按「任务已结束」处理
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "任务已结束或不存在",
                "code": "not_found",
            })),
        )
            .into_response();
    };
    if run.is_finished() {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "任务已结束",
                "code": "not_found",
            })),
        )
            .into_response();
    }
    let ids = Some((run.id.clone(), run.conversation_id()));
    sse_response(&run.bus(), payload.after_seq, ids)
}

/// 会话列表（最近的在前）。
async fn ai_history_list(State(state): State<Arc<AppState>>) -> Response {
    let items = state.ai.history().list();
    axum::Json(serde_json::json!({
        "ok": true,
        "data": {"items": items},
    }))
    .into_response()
}

/// 某个会话的完整内容（用于打开历史会话并继续聊）。
async fn ai_history_get(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    match state.ai.history().get(&id) {
        Some(c) => axum::Json(serde_json::json!({
            "ok": true,
            "data": c,
        }))
        .into_response(),
        None => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "会话不存在或已被删除",
                "code": "not_found",
            })),
        )
            .into_response(),
    }
}

/// 删除一个会话。
async fn ai_history_delete(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    if state.ai.history().delete(&id) {
        axum::Json(serde_json::json!({"ok": true, "data": {"id": id}})).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "会话不存在",
                "code": "not_found",
            })),
        )
            .into_response()
    }
}

/// 清空全部聊天记录。
async fn ai_history_clear(State(state): State<Arc<AppState>>) -> Response {
    state.ai.history().clear();
    axum::Json(serde_json::json!({"ok": true})).into_response()
}

/// 启动一次 agent 任务，事件以 SSE 推给前端。
///
/// 事件类型：
/// - `{"type":"start","runId":...}`
/// - `{"type":"md","text":"..."}`          流式 Markdown 片段
/// - `{"type":"command","command":...,
///    "purpose":...,"danger":...,"reason":...,"auto":bool}` 命令卡片
/// - `{"type":"exec","command":"..."}`     已写入 PTY
/// - `{"type":"observed","output":"...","timedOut":bool}` 命令输出已回收
/// - `{"type":"done"}` / `{"type":"error","error":"..."}`
async fn ai_agent_start(
    State(state): State<Arc<AppState>>,
    body: Option<axum::Json<AgentStartBody>>,
) -> Response {
    let Some(axum::Json(payload)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "缺少请求体"})),
        )
            .into_response();
    };
    let cfg = state.ai.get();
    if !cfg.enabled {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "AI 助手未启用，请先在设置里开启"})),
        )
            .into_response();
    }
    if cfg.api_key.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "尚未配置 API Key"})),
        )
            .into_response();
    }
    let Some(session) = state.mgr.get(&payload.sid) else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"ok": false, "error": "会话不存在", "code": "not_found"})),
        )
            .into_response();
    };

    let terminal_ctx = if cfg.include_context {
        Some(crate::ai::terminal_context(&session, cfg.context_chars())).filter(|t| !t.trim().is_empty())
    } else {
        None
    };

    // 同一个会话如果已经有任务在跑：
    //   * 请求带的 resume_run_id 就是它 → 它自己断线重连，接回去；
    //   * 请求 id 与它相同 → 是同一条消息的重试（首次响应丢了），
    //     也接回去，别开第二个任务；
    //   * 老客户端没带请求 id 时，退回「内容一模一样」判断。
    // 别的情況（用户发了条新消息）照旧返回 409「已有 AI 任务正在运行」——
    // 静默吞掉新消息比报错更糟。
    if let Some(existing) = state.agents.find_by_sid(&payload.sid) {
        let wanted = payload.resume_run_id.as_deref().unwrap_or("");
        let rid = payload.request_id.as_deref().filter(|s| !s.is_empty());
        // 任务「逻辑上已完成」（done 已发）时不算占着会话：允许开新任务。
        // 但它的事件流可能还在收尾（记忆兜底），客户端若带着同一个
        // runId / 同一个请求 id / 同一句话来，仍然接回去，避免同一轮被重复执行。
        //
        // 判断顺序：
        //   1. runId 一致 → 同一条任务的重连；
        //   2. 请求 id 一致 → 同一条消息的重试（最准，能区分「又问了一遍同样的话」）；
        //   3. 老客户端没请求 id 时退回文本比对（仅在没有 runId 时）。
        let same_request = wanted == existing.id
            || match rid {
                Some(id) => {
                    let existing_id = existing.request_id();
                    !existing_id.is_empty() && existing_id == id
                }
                None => wanted.is_empty() && payload.text == existing.user_text(),
            };
        if same_request {
            let bus = existing.bus();
            // 把该任务用的会话 id 一起回给前端：否则前端会继续拿自己
            // 记着的旧 id 发下一轮，模型的上下文就会接错会话。
            let ids = Some((existing.id.clone(), existing.conversation_id()));
            return sse_response(&bus, payload.after_seq, ids);
        }
        // 不是同一个请求：任务已结束（done 已发）就清掉它，让新任务能开始；
        // 还在跑就如实报冲突。
        if existing.is_finished() {
            state.agents.remove(&existing.id);
        } else {
            // 任务还在跑，这确实是「用户发了条新消息」→ 409，
            // 别让后面的 create 把它当成「重试」接回去。
            return (
                StatusCode::CONFLICT,
                axum::Json(serde_json::json!({
                    "ok": false,
                    "error": "该会话已有 AI 任务正在运行，请等它结束或先停止",
                    "code": "busy",
                })),
            )
                .into_response();
        }
    }
    let run = match state.agents.create(&payload.sid) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::CONFLICT,
                axum::Json(serde_json::json!({
                    "ok": false,
                    "error": e,
                    "code": "busy",
                })),
            )
                .into_response();
        }
    };
    let run_id = run.id.clone();
    // 记下用户请求原文（同步设置，不能放到异步任务里）：
    // 客户端重发同一条请求时据此判断「是重试」，接回这个任务，
    // 而不是报「已有 AI 任务正在运行」。
    run.set_user_text(&payload.text);
    if let Some(rid) = payload.request_id.as_deref() {
        run.set_request_id(rid);
    }
    // 事件总线：事件先存再广播，客户端断线重连能补上漏掉的
    let bus = run.bus();
    let bus_for_task = bus.clone();

    let store = state.agents.clone();
    let text = payload.text.clone();
    let session_for_task = session.clone();
    let run_for_task = run.clone();
    // 聊天记录：这一轮结束时会追加到对应的会话里。
    // 没带 conversationId 就是新会话；带了但服务端没有（旧设备残留 / 被删了）
    // 也当新会话，避免历史凭空多出一堆空会话。
    let existing = payload
        .conversation_id
        .as_deref()
        .filter(|id| state.ai.history().get(id).is_some());
    let conversation_id = existing
        .map(|id| id.to_string())
        .unwrap_or_else(crate::ai::history::new_conversation_id);
    // 上下文以**服务端保存的会话**为准：这样刷新页面、换设备之后，
    // 模型依然记得之前聊过什么。前端传来的 messages 只作为兜底
    // （老客户端 / 服务端历史被清空的情况）。
    let history = match existing {
        Some(id) => state.ai.history().model_context(id, cfg.history_turns()),
        None => payload.messages.clone(),
    };
    let history_store = state.ai.history().clone();
    // 记下会话 id：断线重连时把同一个 id 回给前端
    run.set_conversation_id(&conversation_id);
    let conversation_for_task = conversation_id.clone();
    // 长期记忆：跨会话保留的事实（模型用 <remember> 写入）
    let memory = if cfg.memory_enabled {
        Some(state.ai.memory_text()).filter(|m| !m.trim().is_empty())
    } else {
        None
    };
    let memory_path = state.ai.memory_path();
    // 先建 SSE 响应（= 订阅事件总线），再启动任务：
    // 反过来的话任务可能已经跑完了，订阅才建立，中间的事件就漏了。
    let resp = sse_response(&bus, 0, Some((run_id.clone(), conversation_id.clone())));
    tokio::spawn(async move {
        crate::ai::agent::run_task(
            run_for_task,
            store,
            cfg,
            session_for_task,
            text,
            history,
            terminal_ctx,
            memory,
            memory_path,
            conversation_for_task,
            history_store,
            bus_for_task,
        )
        .await;
    });

    resp
}

/// 构造 SSE 响应。
///
/// `after_seq` 是客户端已经收到的最后一条事件序号：服务端把序号更大的
/// 事件先补发一遍，再接上实时流。客户端断线重连时带着这个序号来，
/// 就不会漏看中间的内容，也不会重复。
fn sse_response(
    bus: &std::sync::Arc<crate::ai::events::EventBus>,
    after_seq: u64,
    ids: Option<(String, String)>,
) -> axum::response::Response {
    // 先订阅再补发：订阅在前，保证补发期间产生的新事件不会丢。
    //
    // 但这样一来，「订阅之后、快照之前」那段时间产生的事件会**同时**
    // 出现在补发列表和实时流里 → 客户端收到两遍。解决办法是记住快照的
    // 最大序号，实时流里比它小的直接跳过。
    let (sub_id, rx) = bus.subscribe();
    let snapshot: Vec<(u64, String)> = bus.replay_since(after_seq);
    let snapshot_max = snapshot.last().map(|(s, _)| *s).unwrap_or(after_seq);
    let replay = snapshot.into_iter().map(|(_, f)| f);
    // 心跳：模型思考时可能几十秒不吐一个字，中间的反代 / 网关会当成
    // 空闲连接把 SSE 掐掉（手机锁屏后尤其明显）。定期发一行 SSE 注释
    // （客户端会忽略）就能把连接保活。
    let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(15));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // 客户端断开时取消订阅：agent 由此知道「没人看了」。
    // guard 必须活到响应体被丢弃为止，所以它跟着 stream 一起走
    // （放进 stream 的状态里，流结束/被丢弃时才 Drop）。
    let stream = futures_util::stream::unfold(
        (
            rx,
            replay.into_iter(),
            Some(SubscriptionGuard { bus: bus.clone(), id: sub_id }),
            snapshot_max,
            heartbeat,
        ),
        |(mut rx, mut replay, guard, snapshot_max, mut heartbeat)| async move {
            loop {
                if let Some(chunk) = replay.next() {
                    return Some((Ok::<_, std::convert::Infallible>(chunk), (rx, replay, guard, snapshot_max, heartbeat)));
                }
                tokio::select! {
                    maybe = rx.recv() => match maybe {
                        Some((seq, chunk)) => {
                            // 补发快照里已经给过的，不重复给
                            if seq <= snapshot_max {
                                continue;
                            }
                            return Some((Ok(chunk), (rx, replay, guard, snapshot_max, heartbeat)));
                        }
                        None => return None,
                    },
                    _ = heartbeat.tick() => {
                        // SSE 注释行：客户端不渲染，只用来保活
                        return Some((Ok(": ping\n\n".to_string()), (rx, replay, guard, snapshot_max, heartbeat)));
                    }
                }
            }
        },
    );

    let mut resp = axum::response::Response::new(axum::body::Body::from_stream(stream));
    resp.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    resp.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-cache"),
    );
    if let Some((run_id, conversation_id)) = ids {
        resp.headers_mut().insert(
            "X-Run-Id",
            axum::http::HeaderValue::from_str(&run_id)
                .unwrap_or_else(|_| axum::http::HeaderValue::from_static("run")),
        );
        // 前端据此记住「现在是哪个会话」，下一轮继续追加到它后面。
        if !conversation_id.is_empty() {
            resp.headers_mut().insert(
                "X-Conversation-Id",
                axum::http::HeaderValue::from_str(&conversation_id)
                    .unwrap_or_else(|_| axum::http::HeaderValue::from_static("conv")),
            );
        }
    }
    resp
}

/// SSE 连接结束时取消订阅。
///
/// 客户端断开（关页面 / 网络断了）时，订阅被撤销，agent 就知道
/// 「现在没人看」，进入宽限期等它回来。
struct SubscriptionGuard {
    bus: std::sync::Arc<crate::ai::events::EventBus>,
    id: u64,
}

impl Drop for SubscriptionGuard {
    fn drop(&mut self) {
        self.bus.unsubscribe(self.id);
    }
}

#[derive(serde::Deserialize)]
struct DecideBody {
    #[serde(rename = "runId")]
    run_id: String,
    /// run / skip / stop
    decision: String,
    #[serde(default)]
    command: Option<String>,
}

/// 用户对「待审批命令」的决定。
async fn ai_agent_decide(
    State(state): State<Arc<AppState>>,
    body: Option<axum::Json<DecideBody>>,
) -> Response {
    let Some(axum::Json(payload)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"ok": false, "error": "缺少请求体"})),
        )
            .into_response();
    };
    let Some(run) = state.agents.get(&payload.run_id) else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false, "error": "任务不存在或已结束", "code": "not_found",
            })),
        )
            .into_response();
    };
    let decision = match payload.decision.as_str() {
        "run" => crate::ai::agent::Decision::Run,
        "skip" => crate::ai::agent::Decision::Skip,
        "stop" => crate::ai::agent::Decision::Stop,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({"ok": false, "error": "decision 只能是 run/skip/stop"})),
            )
                .into_response()
        }
    };
    // 服务端再复核一次：前端说 run，但命令是高危的，只记日志
    // （模型给的高危命令必须在卡片上二次确认，改过的命令由 agent 侧重新分类）
    if decision == crate::ai::agent::Decision::Run {
        if let Some(cmd) = payload.command.as_deref() {
            let v = crate::ai::classify_for_exec(cmd);
            if v.danger {
                crate::log_warn!("agent 高危命令执行：{}（{}）", cmd, v.reason);
            }
        }
    }
    if decision == crate::ai::agent::Decision::Stop {
        // 「停止」任何时候都有效：哪怕当前没有待审批的命令，
        // 也要把整个任务叫停（模型流 / 等命令 / 宽限期都算）。
        run.cancel();
        let acted = run.decide(decision, None);
        return axum::Json(serde_json::json!({
            "ok": true,
            // acted=false 表示没有待审批命令，但取消标记已经设置好了
            "data": {"pending": acted},
        }))
        .into_response();
    }
    if run.decide(decision, payload.command.clone()) {
        axum::Json(serde_json::json!({"ok": true})).into_response()
    } else {
        (
            StatusCode::CONFLICT,
            axum::Json(serde_json::json!({
                "ok": false, "error": "没有待审批的命令（可能已超时）", "code": "no_pending",
            })),
        )
            .into_response()
    }
}

/// 严格模式（`require_admin = true`，安装向导默认开启）下，
/// **必须**拿到 `X-Trim-Isadmin: true` 才放行：
/// 拿不到标记就等于无法证明调用者是管理员，不能因为「有用户名」就放行。
/// 否则「严格校验管理员身份」这个开关等于形同虚设——任何能访问到 socket
/// 的人只要伪造一个用户名头就能拿到 root shell。

/// 把 AI 相关路由挂到 api 路由树上。
pub fn register_routes(
    api: Router<Arc<AppState>>,
    state: Arc<AppState>,
    prefix: &str,
) -> Router<Arc<AppState>> {
    api.route(
        &format!("{}/api/ai/config", prefix),
        get(ai_get_config).post(ai_set_config),
    )
    .route(&format!("{}/api/ai/commands", prefix), get(ai_commands))
    .route(
        &format!("{}/api/ai/history", prefix),
        get(ai_history_list).delete(ai_history_clear),
    )
    .route(
        &format!("{}/api/ai/history/{{id}}", prefix),
        get(ai_history_get).delete(ai_history_delete),
    )
    .route(
        &format!("{}/api/ai/detect", prefix),
        axum::routing::post(ai_detect),
    )
    .route(
        &format!("{}/api/ai/agent", prefix),
        axum::routing::post(ai_agent_start),
    )
    .route(
        &format!("{}/api/ai/agent/decide", prefix),
        axum::routing::post(ai_agent_decide),
    )
    .route(
        &format!("{}/api/ai/agent/resume", prefix),
        axum::routing::post(ai_agent_resume),
    )
    .route(
        &format!("{}/api/ai/memory", prefix),
        get(ai_get_memory).post(ai_set_memory),
    )
    .layer(axum::middleware::from_fn_with_state(
        state,
        crate::web::admin_guard,
    ))
}
