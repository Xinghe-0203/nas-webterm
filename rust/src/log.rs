//! 极简日志：默认写 stderr，配了日志文件就只写文件（追加写 + 自动轮转）。
//!
//! 不引入 tracing 生态，保持二进制体积与启动时间最小。
//!
//! 设计要点：
//! - 时间戳用**本地时间** `YYYY-MM-DD HH:MM:SS.mmm`，与 `cmd/main` 里
//!   `[YYYY-MM-DD HH:MM:SS]` 的格式保持一致，两边混排也能对上；
//! - 配了日志文件时**只写文件**（不再同时写 stderr），否则 `cmd/main` 的
//!   `>> info.log 2>&1` 会让每一行都出现两遍；
//! - 日志文件超过阈值自动轮转（copytruncate），保留两份历史备份。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// 日志文件超过这个大小就轮转（8 MiB）。
const DEFAULT_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 保留的历史日志份数（info.log.1 / info.log.2）。
const KEEP_BACKUPS: usize = 2;

struct Sink {
    file: Option<File>,
    path: Option<PathBuf>,
    max_bytes: u64,
    /// 已经写出的字节数（用于避免每行都 stat 一次）
    written: u64,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

fn sink() -> &'static Mutex<Sink> {
    SINK.get_or_init(|| {
        Mutex::new(Sink {
            file: None,
            path: None,
            max_bytes: DEFAULT_MAX_BYTES,
            written: 0,
        })
    })
}

/// 打开日志文件并指定轮转阈值。
pub fn init_with_limit(path: Option<&Path>, max_bytes: u64) {
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    guard.max_bytes = if max_bytes == 0 {
        DEFAULT_MAX_BYTES
    } else {
        max_bytes
    };
    match path {
        Some(p) => match open_append(p) {
            Ok((file, size)) => {
                guard.file = Some(file);
                guard.path = Some(p.to_path_buf());
                guard.written = size;
            }
            Err(e) => {
                // 打不开就退回 stderr（cmd/main 会把 stderr 重定向到日志文件）
                guard.file = None;
                guard.path = None;
                guard.written = 0;
                let line = format!("[{}] [ERROR] 打开日志文件失败: {}\n", timestamp(), e);
                let _ = std::io::stderr().write_all(line.as_bytes());
            }
        },
        None => {
            guard.file = None;
            guard.path = None;
            guard.written = 0;
        }
    }
}

fn open_append(path: &Path) -> std::io::Result<(File, u64)> {
    let file = OpenOptions::new().create(true).append(true).open(path)?;
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    Ok((file, size))
}

/// 本地时间戳：`YYYY-MM-DD HH:MM:SS.mmm`。
///
/// 用 libc 的 localtime_r 做时区换算，不引入 chrono 之类的依赖。
fn timestamp() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // localtime_r 成功返回 tm 指针（失败返回 NULL）
    let failed = unsafe { libc::localtime_r(&secs, &mut tm) }.is_null();
    if failed {
        // 时区换算失败时退回 Unix 秒级时间戳
        format!("{}.{:03}", dur.as_secs(), dur.subsec_millis())
    } else {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            tm.tm_year + 1900,
            tm.tm_mon + 1,
            tm.tm_mday,
            tm.tm_hour,
            tm.tm_min,
            tm.tm_sec,
            dur.subsec_millis()
        )
    }
}

/// 写一条日志。`level` 取值：INFO / WARN / ERROR。
pub fn write(level: &str, message: &str) {
    let line = format!("[{}] [{}] {}\n", timestamp(), level, message);
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    match guard.file.as_mut() {
        Some(file) => {
            // 已经有文件了就不再写 stderr：cmd/main 会把 stderr 也重定向到同一个
            // 日志文件，两边都写会让每行日志出现两遍。
            if file.write_all(line.as_bytes()).is_err() {
                let _ = std::io::stderr().write_all(line.as_bytes());
                return;
            }
            let _ = file.flush();
            guard.written += line.len() as u64;
            if guard.written >= guard.max_bytes {
                rotate(&mut guard);
            }
        }
        None => {
            let _ = std::io::stderr().write_all(line.as_bytes());
        }
    }
}

/// 日志轮转：把当前日志复制成 `.1`（旧的 `.1` 顺延为 `.2`），再把原文件清空。
///
/// 用「复制 + 截断」而不是改名：cmd/main 的 `>> info.log 2>&1` 已经持有该文件的
/// 打开句柄，改名会让后续输出跑到旧文件里；截断则保持 inode 不变，所有写者
/// 都继续写进同一个文件。
fn rotate(guard: &mut Sink) {
    let Some(path) = guard.path.clone() else {
        guard.written = 0;
        return;
    };
    if let Some(file) = guard.file.as_mut() {
        let _ = file.flush();
    }

    let mut backups: Vec<PathBuf> = Vec::with_capacity(KEEP_BACKUPS);
    for i in 1..=KEEP_BACKUPS {
        let mut p = path.clone().into_os_string();
        p.push(format!(".{}", i));
        backups.push(PathBuf::from(p));
    }
    // 最老的备份先删掉，再依次后移
    if let Some(oldest) = backups.last() {
        let _ = std::fs::remove_file(oldest);
    }
    for i in (1..backups.len()).rev() {
        let _ = std::fs::rename(&backups[i - 1], &backups[i]);
    }
    let _ = std::fs::copy(&path, &backups[0]);

    // 截断原文件（保持 inode 与已打开的句柄不变）
    if let Ok(f) = OpenOptions::new().write(true).open(&path) {
        let _ = f.set_len(0);
    }
    match open_append(&path) {
        Ok((file, size)) => {
            guard.file = Some(file);
            guard.written = size;
        }
        Err(_) => {
            guard.file = None;
            guard.written = 0;
        }
    }
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::log::write("INFO", &format!($($arg)*)) };
}

/// 终端查询/应答路由的调试日志：默认关闭，设置 `NAS_WEBTERM_DEBUG=1`
/// 后写入同一份 info.log（不会污染终端输入输出）。
#[macro_export]
macro_rules! log_debug {
    ($($arg:tt)*) => {
        if $crate::log::debug_enabled() {
            $crate::log::write("DEBUG", &format!($($arg)*));
        }
    };
}

/// 调试日志开关（进程内只读一次环境变量）。
pub fn debug_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("NAS_WEBTERM_DEBUG").is_some())
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::log::write("WARN", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::log::write("ERROR", &format!($($arg)*)) };
}
