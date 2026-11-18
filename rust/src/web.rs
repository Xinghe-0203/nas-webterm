//! HTTP / WebSocket 层：静态资源、REST 接口、终端数据通道。

use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;

use crate::config::Config;
use crate::proto;
use crate::session::{self, Session, SessionManager};

/// 网关心跳间隔：必须小于 nginx `proxy_read_timeout 300s`，否则空闲终端会被网关掐断。
const HEARTBEAT: Duration = Duration::from_secs(20);

/// 单次 WebSocket 发送的超时。
///
/// 对端不读（手机锁屏、网络半断、TCP 背压）时 `send()` 会一直挂起，
/// 那条连接就会永远占着一个 Session 引用 + 一条输出队列（最多 4MB）。
/// 超时后直接断开，交给前端重连 + 回放。
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(15);

/// 单帧 / 单条消息的大小上限。
///
/// 终端输入都是按键或粘贴文本，2MB 已经非常宽裕；不设上限的话
/// 一个恶意 WebSocket 帧就能让进程分配 64MB（axum 默认值）。
const WS_MAX_MESSAGE: usize = 2 * 1024 * 1024;

/// 回放分片大小：单帧不能太大，否则前端的待发队列（1MB 上限）会整帧丢弃。
const REPLAY_CHUNK_SIZE: usize = 64 * 1024;

/// 终端尺寸上限：防止畸形客户端把 PTY 设成几千列，把 TUI 渲染拖垮。
const MAX_COLS: u16 = session::MAX_COLS;
const MAX_ROWS: u16 = session::MAX_ROWS;

pub struct AppState {
    pub mgr: Arc<SessionManager>,
    pub cfg: Config,
    /// 进程启动时刻：用于 `/api/healthz` 返回真实的运行时长（秒）。
    pub started_at: std::time::Instant,
    /// AI 助手配置（API Key 只存在后端，接口返回掩码）。
    ///
    /// 普通版编译时没有 `feature = "ai"`，这个字段连同相关代码都不存在。
    #[cfg(feature = "ai")]
    pub ai: Arc<crate::ai::AiStore>,
    /// 进行中的 agent 任务（终端内 AI 模式）
    #[cfg(feature = "ai")]
    pub agents: Arc<crate::ai::agent::AgentStore>,
}

impl AppState {
    fn base_raw(&self) -> String {
        format!("{}/", self.cfg.gateway_prefix)
    }
}

pub fn router(state: Arc<AppState>) -> Router {
    // 网关把完整路径 `/app/<appname>/...` 转发过来，因此路由直接按带前缀的路径注册。
    // （axum 的 Router::layer 在路由匹配之后才执行中间件，无法用来剥离前缀。）
    let prefix = state.cfg.gateway_prefix.clone();
    let api = Router::new()
        .route(&format!("{}/api/healthz", prefix), get(healthz))
        .route(&format!("{}/api/config", prefix), get(app_config))
        .route(
            &format!("{}/api/sessions", prefix),
            get(list_sessions).post(create_session),
        )
        .route(
            &format!("{}/api/sessions/{{id}}", prefix),
            axum::routing::delete(kill_session),
        )
        .route(&format!("{}/api/ws", prefix), get(ws_handler));
    // AI 路由：普通版编译时这段代码不存在，接口也不会被注册
    #[cfg(feature = "ai")]
    let api = crate::ai::routes::register_routes(api, state.clone(), &prefix);
    let api = api.layer(middleware::from_fn_with_state(
        state.clone(),
        admin_guard,
    ));

    Router::new()
        .merge(api)
        .fallback(static_handler)
        .layer(middleware::from_fn_with_state(state.clone(), security_headers))
        .with_state(state)
}

pub async fn admin_guard(State(state): State<Arc<AppState>>, req: axum::extract::Request, next: Next) -> Response {
    let headers = req.headers();
    let is_admin = headers.get("x-trim-isadmin");
    let username = headers.get("x-trim-username");

    let allowed = match is_admin {
        Some(v) => v.as_bytes().eq_ignore_ascii_case(b"true") || v.as_bytes() == b"1",
        None => {
            if state.cfg.require_admin {
                // 严格模式：网关注入的管理员标记缺失 → 无法证明身份 → 拒绝
                false
            } else {
                // 非严格模式：只依赖网关自身的登录态与 isAdminOnly 规则兜底
                true
            }
        }
    };

    if !allowed {
        let user = username
            .map(|v| v.to_str().unwrap_or("<invalid>"))
            .unwrap_or("-");
        crate::log_warn!(
            "拒绝请求：需要管理员权限 (username={}, isadmin={}, require_admin={})",
            user,
            is_admin
                .map(|v| v.to_str().unwrap_or("<invalid>"))
                .unwrap_or("<缺失>"),
            state.cfg.require_admin
        );
        // 区分两种拒绝原因，方便用户自己判断该找谁：
        // - 网关明确说「不是管理员」→ 换管理员账号登录；
        // - 网关没注入这个头 → 多半是网关行为异常，可在设置里关闭严格校验。
        let (error, hint) = match is_admin {
            Some(_) => (
                "需要管理员权限才能使用 Web 终端",
                "当前账号不是管理员",
            ),
            None => (
                "需要管理员权限才能使用 Web 终端",
                "网关未注入 X-Trim-Isadmin 头；若确认当前账号是管理员，可在「设置」里关闭「严格校验管理员身份」",
            ),
        };
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": error,
                "hint": hint
            })),
        )
            .into_response();
    }
    next.run(req).await
}

/// 统一安全响应头。
async fn security_headers(State(_state): State<Arc<AppState>>, req: axum::extract::Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; \
             script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; font-src 'self' data:; \
             frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
        ),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    res
}

async fn healthz(State(state): State<Arc<AppState>>) -> Response {
    let (sessions, clients, replay_bytes) = state.mgr.stats();
    axum::Json(serde_json::json!({
        "ok": true,
        "data": {
            "version": state.cfg.version,
            "app": state.cfg.app_name,
            "pid": std::process::id(),
            // 运行时长（秒）：进程启动至今。
            // 之前这里误用了 Unix 时间戳（1.7e9 量级），语义完全不对。
            "uptime": state.started_at.elapsed().as_secs(),
            // 下面的字段用于排查「后台挂着不关会不会吃内存」：
            // 会话数、WS 客户端数、所有会话回放缓冲的总字节数、进程 RSS。
            "sessions": sessions,
            "clients": clients,
            "replayBytes": replay_bytes,
            "rssKb": rss_kb(),
        }
    }))
    .into_response()
}

/// 当前进程的常驻内存（KB）。读 `/proc/self/statm` 的第二列（单位是页）。
fn rss_kb() -> u64 {
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    let page = if page > 0 { page as u64 } else { 4096 };
    std::fs::read_to_string("/proc/self/statm")
        .ok()
        .and_then(|s| s.split_whitespace().nth(1).and_then(|v| v.parse::<u64>().ok()))
        .map(|pages| pages * page / 1024)
        .unwrap_or(0)
}

async fn app_config(State(state): State<Arc<AppState>>) -> Response {
    axum::Json(serde_json::json!({
        "ok": true,
        "data": {
            "appName": state.cfg.app_name,
            "displayName": state.cfg.display_name,
            "version": state.cfg.version,
            "shell": state.cfg.shell,
            "cwd": state.cfg.cwd,
            "startupCommand": state.cfg.startup_command,
            "idleMinutes": state.cfg.idle_minutes,
            "maxSessions": state.cfg.max_sessions,
            "base": state.base_raw(),
            // 普通版为 false：前端据此完全不渲染 AI 面板与相关入口
            "aiEnabled": cfg!(feature = "ai"),
        }
    }))
    .into_response()
}

async fn list_sessions(State(state): State<Arc<AppState>>) -> Response {
    axum::Json(serde_json::json!({
        "ok": true,
        "data": state.mgr.list(),
    }))
    .into_response()
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    cmd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn create_session(
    State(state): State<Arc<AppState>>,
    body: Option<axum::Json<CreateBody>>,
) -> Response {
    let payload = body.map(|axum::Json(b)| b).unwrap_or(CreateBody {
        cmd: None,
        cols: None,
        rows: None,
    });
    // 创建 PTY 要 openpty + fork/exec，是同步且可能几十毫秒的操作。
    // 放在 async handler 里会占住 tokio worker（同一时刻其它标签页的输出转发、
    // 心跳、静态资源请求都会被拖慢），所以挪到阻塞线程池里做。
    let mgr = state.mgr.clone();
    let cols = payload.cols.unwrap_or(120).clamp(2, MAX_COLS);
    let rows = payload.rows.unwrap_or(32).clamp(2, MAX_ROWS);
    let created = tokio::task::spawn_blocking(move || mgr.create(payload.cmd, cols, rows))
        .await
        .unwrap_or_else(|e| Err(format!("创建会话失败: {}", e)));
    match created {
        Ok(session) => axum::Json(serde_json::json!({
            "ok": true,
            "data": session.info(),
        }))
        .into_response(),
        Err(e) => {
            // 会话数达上限是可预期的业务状态，用 429 表达；
            // 前端据此提示用户「先关掉一个标签页」，而不是当成故障无限重试。
            let (status, code) = if session::is_limit_error(&e) {
                (StatusCode::TOO_MANY_REQUESTS, "session_limit")
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error")
            };
            crate::log_warn!("创建会话失败: {}", e);
            (
                status,
                axum::Json(serde_json::json!({"ok": false, "error": e, "code": code})),
            )
                .into_response()
        }
    }
}

async fn kill_session(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let ok = state.mgr.kill(&id);
    if ok {
        axum::Json(serde_json::json!({"ok": true, "data": {"id": id}})).into_response()
    } else {
        // 会话不存在：明确返回 404，调用方才能区分「删掉了」和「本来就没有」。
        // （前端关闭标签页时会忽略这个错误，不影响使用。）
        (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "会话不存在",
                "code": "not_found",
                "data": {"id": id},
            })),
        )
            .into_response()
    }
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    sid: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    cmd: Option<String>,
}

/// WebSocket 升级：建立终端数据通道。
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(query): Query<WsQuery>,
) -> Response {
    let ws = ws
        .max_message_size(WS_MAX_MESSAGE)
        .max_frame_size(WS_MAX_MESSAGE);
    let cols = query.cols.unwrap_or(120).clamp(2, MAX_COLS);
    let rows = query.rows.unwrap_or(32).clamp(2, MAX_ROWS);

    // 有 sid 就复用已有会话（刷新页面可续上），否则新建。
    let session = match query.sid.as_deref().and_then(|id| state.mgr.get(id)) {
        Some(s) if s.is_alive() => s,
        _ => {
            let startup = query
                .cmd
                .clone()
                .filter(|c| !c.trim().is_empty())
                .or_else(|| {
                    let c = state.cfg.startup_command.clone();
                    if c.trim().is_empty() {
                        None
                    } else {
                        Some(c)
                    }
                });
            // 同上：PTY 创建是阻塞操作，别占着 async worker
            let mgr = state.mgr.clone();
            let created = tokio::task::spawn_blocking(move || mgr.create(startup, cols, rows))
                .await
                .unwrap_or_else(|e| Err(format!("创建会话失败: {}", e)));
            match created {
                Ok(s) => s,
                Err(e) => {
                    // WebSocket 握手失败时浏览器拿不到 HTTP 状态码（只会看到
                    // "connection failed"），前端只能盲目重连 → 无限重试。
                    // 所以这里照样把连接建立起来，用 S_ERROR 帧把原因告诉前端，
                    // 前端收到后停止重试并把原因显示出来。
                    let (code, payload) = if session::is_limit_error(&e) {
                        ("session_limit", e)
                    } else {
                        ("internal_error", e)
                    };
                    crate::log_warn!("WebSocket 会话创建失败 ({}): {}", code, payload);
                    let msg = serde_json::to_vec(&serde_json::json!({
                        "code": code,
                        "error": payload,
                    }))
                    .unwrap_or_else(|_| b"{\"code\":\"internal_error\"}".to_vec());
                    return ws
                        .on_upgrade(move |mut socket| async move {
                            let _ = socket
                                .send(axum::extract::ws::Message::Binary(Bytes::from(
                                    proto::frame(proto::S_ERROR, &msg),
                                )))
                                .await;
                            let _ = socket.send(axum::extract::ws::Message::Close(None)).await;
                        })
                        .into_response();
                }
            }
        }
    };

    let state2 = state.clone();
    ws.on_upgrade(move |socket| async move { terminal_loop(socket, state2, session, cols, rows).await })
}

/// 客户端挂载守卫：无论任务正常结束、被取消还是 panic，都会解绑，
/// 避免会话上的客户端计数只增不减（那样死会话就永远回收不掉）。
struct AttachGuard {
    session: Arc<Session>,
    cid: u64,
}

impl Drop for AttachGuard {
    fn drop(&mut self) {
        self.session.detach(self.cid);
        self.session.touch();
    }
}

/// 带超时的 WebSocket 发送：对端不读时不能无限期挂着。
/// 返回 false 表示应当断开这条连接。
async fn ws_send(socket: &mut WebSocket, msg: Message) -> bool {
    matches!(
        tokio::time::timeout(WS_SEND_TIMEOUT, socket.send(msg)).await,
        Ok(Ok(()))
    )
}

/// 终端数据通道主循环。
async fn terminal_loop(
    mut socket: WebSocket,
    state: Arc<AppState>,
    session: Arc<Session>,
    cols: u16,
    rows: u16,
) {
    let info = session.attach();
    let cid = info.cid;
    let mut rx = info.rx;
    let _guard = AttachGuard {
        session: session.clone(),
        cid,
    };
    crate::log_info!(
        "客户端已连接：会话 {} (pid={}, altScreen={})",
        session.id,
        session.pid.unwrap_or(0),
        info.alt_screen
    );

    // 就绪帧：altScreen 说明这是全屏 TUI，客户端要先进入备用屏幕再回放
    let ready = serde_json::json!({
        "sid": session.id,
        "shell": session.shell,
        "cwd": session.cwd,
        "pid": session.pid,
        "cols": cols,
        "rows": rows,
        "version": state.cfg.version,
        "appName": state.cfg.app_name,
        "altScreen": info.alt_screen,
        "needAltEnter": info.need_alt_enter,
    });
    let ready_bytes = serde_json::to_vec(&ready).unwrap_or_default();
    if !ws_send(
        &mut socket,
        Message::Binary(Bytes::from(proto::frame(proto::S_READY, &ready_bytes))),
    )
    .await
    {
        return;
    }

    // 断线重连回放。
    //
    // 必须**分片**发送：回放缓冲区最大能到 4MB（TUI 场景），
    // 整块塞进一个 WebSocket 帧的话，前端会因超出待发队列上限（1MB）
    // 把整帧丢掉 —— 重连后终端就一片空白，而且没有任何提示。
    // 按 64KB 分片后，前端的背压逻辑只会丢最早的几片，不会整段消失。
    for chunk in info.replay.chunks(REPLAY_CHUNK_SIZE) {
        if !ws_send(
            &mut socket,
            Message::Binary(Bytes::from(proto::frame(proto::S_OUTPUT, chunk))),
        )
        .await
        {
            return;
        }
    }

    // 全屏 TUI：给前台进程发一个 SIGWINCH，程序会自己把整个界面重画一遍
    // （不少 TUI 会响应它）。这里**不能**再补一条「进入备用屏幕并清屏」的序列，
    // 否则刚回放好的画面会被擦掉。
    if info.alt_screen {
        session.notify_foreground(libc::SIGWINCH);
    }

    // 会话在升级前就已经结束：补发退出信息，客户端不会一直等
    if !session.is_alive() {
        if let Some(info) = session.exit_info() {
            let payload = serde_json::to_vec(&info).unwrap_or_default();
            let _ = ws_send(
                &mut socket,
                Message::Binary(Bytes::from(proto::frame(proto::S_EXIT, &payload))),
            )
            .await;
        }
    }

    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            // 服务端 → 客户端：队列里已经是完整帧（输出帧或退出帧），直接投递
            chunk = rx.recv() => {
                match chunk {
                    Some(frame) => {
                        if !ws_send(&mut socket, Message::Binary(frame)).await {
                            break;
                        }
                    }
                    None => break,
                }
            }
            // 客户端 → 服务端：输入 / 调整尺寸 / 信号
            msg = socket.recv() => {
                match msg {
                    Some(Ok(Message::Binary(raw))) => {
                        match handle_client_frame(&session, &raw).await {
                            FrameOutcome::Continue => {}
                            FrameOutcome::Close => break,
                            FrameOutcome::Error(msg) => {
                                crate::log_warn!("客户端输入处理失败: {}", msg);
                                let payload =
                                    serde_json::to_vec(&serde_json::json!({
                                        "code": "input_blocked",
                                        "error": msg,
                                    }))
                                    .unwrap_or_default();
                                let _ = ws_send(
                                    &mut socket,
                                    Message::Binary(Bytes::from(proto::frame(
                                        proto::S_ERROR,
                                        &payload,
                                    ))),
                                )
                                .await;
                                break;
                            }
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        // 纯文本帧按终端输入处理
                        if let Err(e) = session.write_input(text.as_str().as_bytes().to_vec()).await {
                            if !session.is_alive() {
                                break;
                            }
                            crate::log_warn!("客户端输入处理失败: {}", e);
                            let payload =
                                serde_json::to_vec(&serde_json::json!({
                                    "code": "input_blocked",
                                    "error": e,
                                }))
                                .unwrap_or_default();
                            let _ = ws_send(
                                &mut socket,
                                Message::Binary(Bytes::from(proto::frame(
                                    proto::S_ERROR,
                                    &payload,
                                ))),
                            )
                            .await;
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            // 心跳：穿过 nginx 的 300s 读超时
            _ = heartbeat.tick() => {
                if !ws_send(&mut socket, Message::Ping(axum::body::Bytes::new())).await {
                    break;
                }
            }
        }
    }

    crate::log_info!("客户端已断开：会话 {}", session.id);
}

/// 处理客户端二进制帧。返回 false 表示应当断开。
/// 客户端帧的处理结果。
enum FrameOutcome {
    /// 继续等待下一帧
    Continue,
    /// 会话已经结束，正常关闭
    Close,
    /// 出错：把原因用 S_ERROR 帧发给客户端后再关闭
    Error(String),
}

async fn handle_client_frame(session: &Arc<Session>, raw: &[u8]) -> FrameOutcome {
    let (kind, payload) = match proto::split(raw) {
        Some(v) => v,
        None => return FrameOutcome::Continue,
    };
    match kind {
        proto::C_INPUT => match session.write_input(payload.to_vec()).await {
            Ok(()) => FrameOutcome::Continue,
            // 写入超时：前台程序不读输入，PTY 缓冲区写满了。
            // 这时必须告诉用户原因，否则表现就是「终端突然卡死」。
            Err(e) => {
                if session.is_alive() {
                    FrameOutcome::Error(e)
                } else {
                    // 会话本身已经结束（例如进程刚退出），正常关闭即可
                    FrameOutcome::Close
                }
            }
        },
        proto::C_RESIZE => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) {
                // 用 try_from + clamp，而不是 `as u16`：
                // `as u16` 会把 70000 截断成 4464，把 PTY 设成几千列。
                let cols = v
                    .get("cols")
                    .and_then(|x| x.as_u64())
                    .and_then(|x| u16::try_from(x).ok())
                    .unwrap_or(80)
                    .clamp(1, MAX_COLS);
                let rows = v
                    .get("rows")
                    .and_then(|x| x.as_u64())
                    .and_then(|x| u16::try_from(x).ok())
                    .unwrap_or(24)
                    .clamp(1, MAX_ROWS);
                session.resize(cols, rows);
            }
            FrameOutcome::Continue
        }
        proto::C_SIGNAL => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) {
                if let Some(sig) = v.get("signal").and_then(|x| x.as_str()) {
                    send_signal(session, sig);
                }
            }
            FrameOutcome::Continue
        }
        proto::C_TERM_RESPONSE => {
            // 终端对 OSC/DA 查询的自动应答不是用户输入：必须经过
            // “发起查询的进程是否还在读”的校验，不能直接当键盘输入写 PTY。
            if let Err(e) = session.write_terminal_response(payload.to_vec()).await {
                crate::log_warn!("终端查询应答处理失败: {}", e);
            }
            FrameOutcome::Continue
        }
        _ => FrameOutcome::Continue,
    }
}

/// 向会话的前台进程组发送信号。
fn send_signal(session: &Arc<Session>, signal: &str) {
    let signo = match signal.to_ascii_uppercase().as_str() {
        "INT" => libc::SIGINT,
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        "HUP" => libc::SIGHUP,
        "QUIT" => libc::SIGQUIT,
        "WINCH" => libc::SIGWINCH,
        _ => return,
    };
    session.notify_foreground(signo);
}

/// 静态资源 / 首页。
async fn static_handler(State(state): State<Arc<AppState>>, uri: Uri) -> Response {
    let path = uri.path();
    let prefix = state.cfg.gateway_prefix.clone();
    // 剥掉网关前缀，得到相对 ui 目录的路径
    let rel = if path == prefix {
        String::new()
    } else if let Some(rest) = path.strip_prefix(&format!("{}/", prefix)) {
        rest.to_string()
    } else {
        // 不带前缀的请求按相对路径处理（本地调试用）
        path.trim_start_matches('/').to_string()
    };
    if rel.is_empty() || rel == "index.html" {
        return serve_index(&state).await;
    }
    // URL 里的路径是百分号编码的：文件名里带编码字符的资源要解码后才找得到。
    // 解码后的路径依然交给 resolve_asset 做组件级校验（`..` 会被拒绝）。
    let rel = percent_decode(&rel);
    match resolve_asset(&state.cfg.ui_dir, &rel) {
        // 用 tokio::fs 而不是 std::fs：这个 handler 跑在 async 运行时里，
        // 1MB 的 JS / 500KB 的字体用同步读会把一个 worker 线程阻塞几毫秒，
        // 同时刻其它标签页的终端输出转发、心跳都会跟着卡。
        Some((full, _)) => match tokio::fs::read(&full).await {
            Ok(bytes) => {
                let mime = mime_for(&full);
                let immutable = rel.starts_with("assets/");
                let cache = if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "public, max-age=60"
                };
                (
                    [
                        (header::CONTENT_TYPE, mime.to_string()),
                        (header::CACHE_CONTROL, cache.to_string()),
                    ],
                    bytes,
                )
                    .into_response()
            }
            Err(_) => not_found(),
        },
        None => not_found(),
    }
}

/// 读取首页模板并注入网关前缀等变量。
async fn serve_index(state: &Arc<AppState>) -> Response {
    let index_path = state.cfg.ui_dir.join("index.html");
    let template = match tokio::fs::read_to_string(&index_path).await {
        Ok(t) => t,
        Err(e) => {
            // 注意：不要把服务器上的绝对路径写进响应体（信息泄露），
            // 只在服务端日志里记录细节。
            crate::log_error!("读取前端 index.html 失败: {} ({})", index_path.display(), e);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                "前端资源缺失，请检查应用安装是否完整".to_string(),
            )
                .into_response();
        }
    };
    let base = state.base_raw();
    let html = template
        .replace("__FN_BASE_RAW__", &base)
        .replace("__FN_BASE__", &base)
        .replace("__FN_VERSION__", &state.cfg.version)
        .replace("__FN_APPNAME__", &state.cfg.app_name)
        .replace("__FN_DISPLAY_NAME__", &state.cfg.display_name);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8".to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        html,
    )
        .into_response()
}

/// 百分号解码（只处理 %XX，不把 `+` 当空格）。
///
/// URL 路径里的文件名可能是编码过的（中文、空格等），
/// 不解码就会 404。解码后的结果仍然要过 `resolve_asset` 的路径穿越校验。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]) {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 把 URL 路径安全映射到 ui_dir 下的文件，阻断路径穿越。
fn resolve_asset(ui_dir: &Path, rel: &str) -> Option<(PathBuf, bool)> {
    let mut out = ui_dir.to_path_buf();
    let mut depth = 0usize;
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(part) => {
                depth += 1;
                if depth > 8 {
                    return None;
                }
                out.push(part);
            }
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.is_file() {
        Some((out, true))
    } else {
        None
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({"ok": false, "error": "not found"})),
    )
        .into_response()
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 开发模式监听地址。
pub fn dev_addr(cfg: &Config) -> Option<SocketAddr> {
    let port = cfg.dev_port?;
    let host = cfg.dev_host.clone().unwrap_or_else(|| "127.0.0.1".to_string());
    format!("{}:{}", host, port).parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decode_decodes_hex_escapes() {
        assert_eq!(percent_decode("a%20b"), "a b");
        assert_eq!(percent_decode("%E4%B8%AD"), "中");
        assert_eq!(percent_decode("plain"), "plain");
    }

    #[test]
    fn percent_decode_leaves_plus_and_broken_escapes() {
        // '+' 在路径里是字面加号，不能当空格
        assert_eq!(percent_decode("a+b"), "a+b");
        // 不完整 / 非法的转义保持原样
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%4"), "%4");
    }
}
