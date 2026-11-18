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
    let (tx, rx) = tokio::sync::mpsc::channel::<String>(128);

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
    let conversation_for_task = conversation_id.clone();
    // 长期记忆：跨会话保留的事实（模型用 <remember> 写入）
    let memory = if cfg.memory_enabled {
        Some(state.ai.memory_text()).filter(|m| !m.trim().is_empty())
    } else {
        None
    };
    let memory_path = state.ai.memory_path();
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
            tx,
        )
        .await;
    });

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|chunk| (Ok::<_, std::convert::Infallible>(chunk), rx))
    });

    let mut resp = axum::response::Response::new(axum::body::Body::from_stream(stream));
    resp.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    resp.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-cache"),
    );
    resp.headers_mut().insert(
        "X-Run-Id",
        axum::http::HeaderValue::from_str(&run_id)
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("run")),
    );
    // 前端据此记住「现在是哪个会话」，下一轮继续追加到它后面。
    resp.headers_mut().insert(
        "X-Conversation-Id",
        axum::http::HeaderValue::from_str(&conversation_id)
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("conv")),
    );
    resp
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
        &format!("{}/api/ai/memory", prefix),
        get(ai_get_memory).post(ai_set_memory),
    )
    .layer(axum::middleware::from_fn_with_state(
        state,
        crate::web::admin_guard,
    ))
}
