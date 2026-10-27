//! 极简日志：同时输出到 stderr 与日志文件（追加写）。
//!
//! 不引入 tracing 生态，保持二进制体积与启动时间最小。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

struct Sink {
    file: Option<File>,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

fn sink() -> &'static Mutex<Sink> {
    SINK.get_or_init(|| Mutex::new(Sink { file: None }))
}

/// 打开日志文件（追加写）。失败时只记录到 stderr。
pub fn init(path: Option<&Path>) {
    let file = path.and_then(|p| {
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .ok()
    });
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    guard.file = file;
}

fn timestamp() -> String {
    // 不引入 chrono：取 UTC 秒级时间戳 + 进程启动后的单调偏移足够定位问题。
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", now)
}

/// 写一条日志。`level` 取值：INFO / WARN / ERROR。
pub fn write(level: &str, message: &str) {
    let line = format!("[{}] [{}] {}\n", timestamp(), level, message);
    let _ = std::io::stderr().write_all(line.as_bytes());
    let mut guard = sink().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(file) = guard.file.as_mut() {
        let _ = file.write_all(line.as_bytes());
        let _ = file.flush();
    }
}

#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => { $crate::log::write("INFO", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::log::write("WARN", &format!($($arg)*)) };
}

#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => { $crate::log::write("ERROR", &format!($($arg)*)) };
}
