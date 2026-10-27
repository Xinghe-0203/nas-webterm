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
use crate::session::{Session, SessionManager};

/// 网关心跳间隔：必须小于 nginx `proxy_read_timeout 300s`，否则空闲终端会被网关掐断。
const HEARTBEAT: Duration = Duration::from_secs(20);

pub struct AppState {
    pub mgr: Arc<SessionManager>,
    pub cfg: Config,
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
        .route(&format!("{}/api/ws", prefix), get(ws_handler))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            admin_guard,
        ));

    Router::new()
        .merge(api)
        .fallback(static_handler)
        .layer(middleware::from_fn_with_state(state.clone(), security_headers))
        .with_state(state)
}

/// 管理员校验：网关注入 X-Trim-Isadmin，非管理员直接 403。
async fn admin_guard(State(state): State<Arc<AppState>>, req: axum::extract::Request, next: Next) -> Response {
    let headers = req.headers();
    let is_admin = headers.get("x-trim-isadmin");
    let username = headers.get("x-trim-username");

    let allowed = match is_admin {
        Some(v) => v == "true" || v == "1",
        None => {
            // 老版本网关只注入用户名，此时由网关自身的 isAdminOnly 规则兜底
            if username.is_some() {
                true
            } else {
                !state.cfg.require_admin
            }
        }
    };

    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "ok": false,
                "error": "需要管理员权限才能使用 Web 终端"
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
    axum::Json(serde_json::json!({
        "ok": true,
        "data": {
            "version": state.cfg.version,
            "app": state.cfg.app_name,
            "pid": std::process::id(),
            "uptime": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        }
    }))
    .into_response()
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
    match state.mgr.create(
        payload.cmd,
        payload.cols.unwrap_or(120),
        payload.rows.unwrap_or(32),
    ) {
        Ok(session) => axum::Json(serde_json::json!({
            "ok": true,
            "data": session.info(),
        }))
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            axum::Json(serde_json::json!({"ok": false, "error": e})),
        )
            .into_response(),
    }
}

async fn kill_session(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let ok = state.mgr.kill(&id);
    axum::Json(serde_json::json!({"ok": ok, "data": {"id": id}})).into_response()
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
    let cols = query.cols.unwrap_or(120).max(2);
    let rows = query.rows.unwrap_or(32).max(2);

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
            match state.mgr.create(startup, cols, rows) {
                Ok(s) => s,
                Err(e) => {
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        axum::Json(serde_json::json!({"ok": false, "error": e})),
                    )
                        .into_response()
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
    if socket
        .send(Message::Binary(Bytes::from(proto::frame(
            proto::S_READY,
            &ready_bytes,
        ))))
        .await
        .is_err()
    {
        return;
    }

    // 断线重连回放
    if !info.replay.is_empty() {
        let _ = socket
            .send(Message::Binary(Bytes::from(proto::frame(
                proto::S_OUTPUT,
                &info.replay,
            ))))
            .await;
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
            let _ = socket
                .send(Message::Binary(Bytes::from(proto::frame(
                    proto::S_EXIT,
                    &payload,
                ))))
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
                        if socket.send(Message::Binary(frame)).await.is_err() {
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
                        if !handle_client_frame(&session, &raw).await {
                            break;
                        }
                    }
                    Some(Ok(Message::Text(text))) => {
                        // 纯文本帧按终端输入处理
                        if session.write_input(text.as_str().as_bytes().to_vec()).await.is_err() {
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
                if socket.send(Message::Ping(axum::body::Bytes::new())).await.is_err() {
                    break;
                }
            }
        }
    }

}

/// 处理客户端二进制帧。返回 false 表示应当断开。
async fn handle_client_frame(session: &Arc<Session>, raw: &[u8]) -> bool {
    let (kind, payload) = match proto::split(raw) {
        Some(v) => v,
        None => return true,
    };
    match kind {
        proto::C_INPUT => session.write_input(payload.to_vec()).await.is_ok(),
        proto::C_RESIZE => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) {
                let cols = v.get("cols").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                let rows = v.get("rows").and_then(|x| x.as_u64()).unwrap_or(0) as u16;
                session.resize(cols, rows);
            }
            true
        }
        proto::C_SIGNAL => {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) {
                if let Some(sig) = v.get("signal").and_then(|x| x.as_str()) {
                    send_signal(session, sig);
                }
            }
            true
        }
        _ => true,
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
        return serve_index(&state);
    }
    match resolve_asset(&state.cfg.ui_dir, &rel) {
        Some((full, _)) => match std::fs::read(&full) {
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
fn serve_index(state: &Arc<AppState>) -> Response {
    let index_path = state.cfg.ui_dir.join("index.html");
    let template = match std::fs::read_to_string(&index_path) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("前端资源缺失: {} ({})", index_path.display(), e),
            )
                .into_response()
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
