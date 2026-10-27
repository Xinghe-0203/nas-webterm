//! nas-webterm —— 飞牛 NAS 浏览器多标签页 Web 终端。
//!
//! 单进程架构：asyncio 风格的 Rust 服务同时承担
//!   1. 静态资源（前端 Vite 构建产物）
//!   2. REST 接口
//!   3. WebSocket 终端数据通道（每个标签页一个真实 PTY）
//!
//! 进程以 root 运行，通过 unix socket 接入飞牛统一网关，不开放任何 TCP 端口。

mod config;
mod log;
mod proto;
mod session;
mod web;

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use config::Config;
use session::SessionManager;
use web::AppState;

/// 退出时删除 socket 文件。
struct SocketGuard(PathBuf);
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cfg = match Config::parse(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(2);
        }
    };

    log::init(cfg.log_file.as_deref());
    log_info!(
        "nas-webterm {} 启动 (pid={}, shell={}, cwd={})",
        cfg.version,
        std::process::id(),
        cfg.shell,
        cfg.cwd
    );

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("webterm")
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            log_error!("运行时初始化失败: {}", e);
            std::process::exit(1);
        }
    };

    if let Err(e) = runtime.block_on(run(cfg)) {
        log_error!("致命错误: {}", e);
        std::process::exit(1);
    }
}

async fn run(cfg: Config) -> Result<(), String> {
    let mgr = SessionManager::new(cfg.clone());
    let state = Arc::new(AppState {
        mgr: mgr.clone(),
        cfg: cfg.clone(),
    });
    let app = web::router(state);

    // 回收空闲会话，避免 root 进程长期堆积。
    let reaper = mgr.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            reaper.reap();
        }
    });

    if let Some(addr) = web::dev_addr(&cfg) {
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| format!("监听 {} 失败: {}", addr, e))?;
        log_info!("开发模式监听 http://{}", addr);
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_signal())
            .await
            .map_err(|e| format!("服务异常退出: {}", e))?;
        return Ok(());
    }

    let socket_path = cfg.socket.clone();
    if let Some(parent) = socket_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {}", parent.display(), e))?;
        }
    }
    // 清掉上次残留的 socket
    let _ = std::fs::remove_file(&socket_path);

    let listener = tokio::net::UnixListener::bind(&socket_path)
        .map_err(|e| format!("监听 {} 失败: {}", socket_path.display(), e))?;
    let _guard = SocketGuard(socket_path.clone());

    apply_socket_mode(&socket_path, cfg.socket_mode, cfg.socket_gid)?;
    log_info!(
        "已监听 unix socket {} (mode={:o}, gid={:?})",
        socket_path.display(),
        cfg.socket_mode,
        cfg.socket_gid
    );

    axum::serve(listener, app.into_make_service())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(|e| format!("服务异常退出: {}", e))?;
    log_info!("nas-webterm 已停止");
    Ok(())
}

/// 设置 socket 权限与属组。
fn apply_socket_mode(path: &Path, mode: u32, gid: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("读取 socket 属性失败: {}", e))?
        .permissions();
    perms.set_mode(mode);
    std::fs::set_permissions(path, perms)
        .map_err(|e| format!("设置 socket 权限失败: {}", e))?;
    if let Some(gid) = gid {
        let c = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "socket 路径含非法字符".to_string())?;
        let rc = unsafe { libc::chown(c.as_ptr(), 0, gid) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            // 降权运行时 chown 会 EPERM，属预期情况，忽略即可
            log_warn!("设置 socket 属组失败(已忽略): {}", err);
        }
    }
    Ok(())
}

/// 收到 SIGTERM / SIGINT 时优雅退出。
async fn shutdown_signal() {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("注册 SIGTERM 失败");
    let mut int = signal(SignalKind::interrupt()).expect("注册 SIGINT 失败");
    tokio::select! {
        _ = term.recv() => log_info!("收到 SIGTERM，准备退出"),
        _ = int.recv() => log_info!("收到 SIGINT，准备退出"),
    }
}
