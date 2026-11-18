//! nas-webterm —— 飞牛 NAS 浏览器多标签页 Web 终端。
//!
//! 单进程架构：asyncio 风格的 Rust 服务同时承担
//!   1. 静态资源（前端 Vite 构建产物）
//!   2. REST 接口
//!   3. WebSocket 终端数据通道（每个标签页一个真实 PTY）
//!
//! 进程以 root 运行，通过 unix socket 接入飞牛统一网关，不开放任何 TCP 端口。

#[cfg(feature = "ai")]
mod ai;
mod config;
mod log;
mod proto;
mod session;
mod web;

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::FileTypeExt;
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

    // 收紧 umask：unix socket 创建瞬间的权限由 umask 决定，
    // 默认 022 会让 socket 短暂变成 0755（其它本地用户能连上）。
    // 这里在创建任何线程之前一次性设好，进程后续只创建 socket，不影响其它程序。
    set_umask(0o077);

    log::init_with_limit(cfg.log_file.as_deref(), cfg.log_max_bytes);
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
    // 直接 drop 运行时的话，析构会一直等待 PTY 读写这类 spawn_blocking 任务结束，
    // 而它们只有在会话被彻底结束后才会返回。这里给一个上限，
    // 保证收到 SIGTERM 后进程能及时退出（线上日志里的 "force killing webterm"）。
    runtime.shutdown_timeout(Duration::from_secs(2));
}

async fn run(cfg: Config) -> Result<(), String> {
    let mgr = SessionManager::new(cfg.clone());
    // 启动前清理上一次运行残留的终端进程。
    // 服务被 panic / OOM / SIGKILL 干掉时（release 是 panic=abort，没有析构），
    // PTY 里的 shell 与后台作业会变成孤儿继续跑：占内存、占端口、而且带着 root 权限。
    // 这一步必须在拿到监听之后做（dev 模式是 TCP，socket 模式在下面），
    // 否则同时启动两个实例时会把对方正在用的会话误杀。
    //
    // AI 助手：普通版编译时就没有这个模块（--no-default-features），连配置都不碰
    #[cfg(feature = "ai")]
    let ai_store = Arc::new(ai::AiStore::load(cfg.ai_config.clone()));
    let state = Arc::new(AppState {
        mgr: mgr.clone(),
        cfg: cfg.clone(),
        started_at: std::time::Instant::now(),
        #[cfg(feature = "ai")]
        ai: ai_store,
        #[cfg(feature = "ai")]
        agents: Arc::new(ai::agent::AgentStore::new()),
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
        reap_orphans(&cfg);
        serve_until_shutdown(
            axum::serve(listener, app.into_make_service())
                .with_graceful_shutdown(shutdown_bridge(mgr.clone())),
        )
        .await?;
        log_info!("开发模式：服务已停止，正在清理会话");
        mgr.kill_all();
        return Ok(());
    }

    let socket_path = cfg.socket.clone();
    if let Some(parent) = socket_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目录 {} 失败: {}", parent.display(), e))?;
        }
    }
    // 清掉上次残留的 socket。
    // 注意：只删「确实是 socket」的东西——直接 remove_file 会把该路径上的
    // 普通文件/符号链接目标一起删掉，配错了路径就可能误删用户文件。
    match std::fs::symlink_metadata(&socket_path) {
        Ok(meta) if meta.file_type().is_socket() => {
            let _ = std::fs::remove_file(&socket_path);
        }
        Ok(meta) => {
            if !meta.file_type().is_symlink() {
                return Err(format!(
                    "{} 已存在且不是 socket，拒绝启动",
                    socket_path.display()
                ));
            }
            // 符号链接：指向的必须也是 socket，否则同样拒绝。
            match std::fs::metadata(&socket_path) {
                Ok(target) if target.file_type().is_socket() => {
                    let _ = std::fs::remove_file(&socket_path);
                }
                _ => {
                    return Err(format!(
                        "{} 已存在且不是 socket，拒绝启动",
                        socket_path.display()
                    ));
                }
            }
        }
        Err(_) => {}
    }

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

    // 监听已建立：可以确定本应用没有第二个实例在跑，现在清理上次的孤儿进程。
    reap_orphans(&cfg);

    serve_until_shutdown(
        axum::serve(listener, app.into_make_service())
            .with_graceful_shutdown(shutdown_bridge(mgr.clone())),
    )
    .await?;
    // 先把会话全部收掉，再宣布停止：顺序反了的话，运行时会卡在等待
    // PTY 读写线程上，进程迟迟退不出去（fnOS 只能强杀）。
    mgr.kill_all();
    log_info!("nas-webterm 已停止");
    Ok(())
}


/// 等待服务的 `Serve` future 结束。
///
/// `Serve` 本身是「一直跑到 graceful shutdown 触发、并且所有连接都关闭为止」。
/// 这里用 `select!` 区分两种结束方式：
///   * 服务自己出错 / 正常结束 → 直接返回；
///   * 收到 SIGTERM（`shutdown_bridge` 会通知）→ 最多再等 `SHUTDOWN_GRACE`，
///     超时就放弃等待，让调用方把会话收掉并退出。
///
/// 注意不能直接用 `timeout(SHUTDOWN_GRACE, serve)` 包住整个 serve：
/// 那样即使没收到任何信号，服务也会在 5 秒后自己「超时退出」。
async fn serve_until_shutdown<S>(serve: S) -> Result<(), String>
where
    S: std::future::IntoFuture<Output = std::io::Result<()>>,
{
    let serve = serve.into_future();
    let notify = SHUTDOWN_NOTIFY
        .get_or_init(|| Arc::new(tokio::sync::Notify::new()))
        .clone();
    tokio::pin!(serve);
    tokio::select! {
        res = &mut serve => {
            res.map_err(|e| format!("服务异常退出: {}", e))
        }
        _ = notify.notified() => {
            match tokio::time::timeout(SHUTDOWN_GRACE, &mut serve).await {
                Ok(Ok(())) => Ok(()),
                Ok(Err(e)) => Err(format!("服务异常退出: {}", e)),
                Err(_) => {
                    log_warn!(
                        "仍有连接未关闭，优雅退出超时（{}s），直接结束",
                        SHUTDOWN_GRACE.as_secs()
                    );
                    Ok(())
                }
            }
        }
    }
}

/// 进程内的关停通知（只用于让 `serve_until_shutdown` 知道信号已到）。
static SHUTDOWN_NOTIFY: std::sync::OnceLock<Arc<tokio::sync::Notify>> =
    std::sync::OnceLock::new();

/// 把 `shutdown_signal` 和通知接起来。
async fn shutdown_bridge(mgr: Arc<SessionManager>) {
    shutdown_signal(mgr).await;
    if let Some(n) = SHUTDOWN_NOTIFY.get() {
        n.notify_one();
    }
}

/// 优雅退出最多等多久。
///
/// WebSocket 是长连接，`axum::serve` 的 graceful shutdown 会等所有连接自己关；
/// 虽然收到信号时我们立刻杀掉会话、让 WS 循环感知到退出，但网络异常时
/// 仍可能有连接卡住，所以这里必须有硬上限，否则只能等 fnOS 强杀。
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// 清理上一次运行残留的终端进程（日志里给出数量）。
fn reap_orphans(cfg: &Config) {
    let tag = cfg.instance_tag();
    let n = session::kill_orphan_processes(&tag);
    if n > 0 {
        log_warn!("清理了 {} 个上次运行残留的终端进程（instance={}）", n, tag);
    }
}

/// 设置进程 umask（只影响本进程创建的文件）。
fn set_umask(mask: libc::mode_t) {
    unsafe {
        libc::umask(mask);
    }
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
///
/// 关键点：**先杀会话再返回**。
/// WebSocket 循环只有在会话结束（子进程退出 → on_child_exit 清掉全部客户端）
/// 或对端主动断开时才会结束；如果先等 `axum::serve` 优雅退出，它要等所有
/// WebSocket 连接关闭，而浏览器不会主动关——于是只能等到超时被强杀，
/// 这段时间里 PTY 里的 shell 还在跑，stop 也不干净。
async fn shutdown_signal(mgr: Arc<SessionManager>) {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate()).expect("注册 SIGTERM 失败");
    let mut int = signal(SignalKind::interrupt()).expect("注册 SIGINT 失败");
    tokio::select! {
        _ = term.recv() => log_info!("收到 SIGTERM，准备退出"),
        _ = int.recv() => log_info!("收到 SIGINT，准备退出"),
    }
    mgr.kill_all();
}

#[cfg(test)]
mod tests {
    #[test]
    fn shutdown_grace_is_sane() {
        assert!(super::SHUTDOWN_GRACE.as_secs() >= 1);
    }
}
