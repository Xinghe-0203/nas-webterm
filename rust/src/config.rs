//! 运行时配置：全部来自命令行参数，由 `cmd/main` 依据 fnOS 的 TRIM_* 变量注入。

use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct Config {
    /// unix socket 路径（fnOS 统一网关约定为 ${TRIM_APPDEST}/app.sock）
    pub socket: PathBuf,
    /// 前端静态资源目录（${TRIM_APPDEST}/ui）
    pub ui_dir: PathBuf,
    /// 网关前缀，例如 /app/nas-webterm
    pub gateway_prefix: String,
    pub app_name: String,
    pub display_name: String,
    pub version: String,

    /// 默认交互式 shell
    pub shell: String,
    /// 默认工作目录
    pub cwd: String,
    /// 新建会话时自动键入的命令（可为空）
    pub startup_command: String,

    /// 无客户端连接时保留会话的时长（分钟），0 = 永不按时间回收
    pub idle_minutes: u64,
    /// 同时存活的最大会话数；达到上限后拒绝新建，不会杀掉旧会话
    pub max_sessions: usize,

    /// socket 权限位（八进制字符串）
    pub socket_mode: u32,
    /// socket 属组 gid
    pub socket_gid: Option<u32>,

    /// 开发模式：监听 TCP 而不是 unix socket
    pub dev_host: Option<String>,
    pub dev_port: Option<u16>,

    /// 日志文件（追加写）
    pub log_file: Option<PathBuf>,

    /// 是否要求管理员身份（网关注入 X-Trim-Isadmin）
    pub require_admin: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            socket: PathBuf::from("/tmp/nas-webterm.sock"),
            ui_dir: PathBuf::from("./ui"),
            gateway_prefix: "/app/nas-webterm".to_string(),
            app_name: "nas-webterm".to_string(),
            display_name: "Web 终端".to_string(),
            version: "1.0.0".to_string(),
            shell: "/bin/bash".to_string(),
            cwd: "/root".to_string(),
            startup_command: String::new(),
            // 0 = 永不按时间回收，终端可以连开几天
            idle_minutes: 0,
            max_sessions: 32,
            socket_mode: 0o600,
            socket_gid: None,
            dev_host: None,
            dev_port: None,
            log_file: None,
            require_admin: true,
        }
    }
}

impl Config {
    /// 解析命令行参数。未知参数一律报错，避免拼写错误被静默忽略。
    pub fn parse(args: &[String]) -> Result<Self, String> {
        let mut cfg = Config::default();
        let mut i = 0;
        while i < args.len() {
            let key = args[i].as_str();
            let mut value = || -> Result<String, String> {
                i += 1;
                args.get(i)
                    .cloned()
                    .ok_or_else(|| format!("参数 {} 缺少取值", key))
            };
            match key {
                "--socket" => cfg.socket = PathBuf::from(value()?),
                "--ui-dir" => cfg.ui_dir = PathBuf::from(value()?),
                "--gateway-prefix" => cfg.gateway_prefix = value()?,
                "--app-name" => cfg.app_name = value()?,
                "--display-name" => cfg.display_name = value()?,
                "--version" => cfg.version = value()?,
                "--shell" => cfg.shell = value()?,
                "--cwd" => cfg.cwd = value()?,
                "--startup-command" => cfg.startup_command = value()?,
                "--idle-minutes" => {
                    cfg.idle_minutes = value()?
                        .parse()
                        .map_err(|_| "--idle-minutes 需要非负整数".to_string())?
                }
                "--max-sessions" => {
                    cfg.max_sessions = value()?
                        .parse()
                        .map_err(|_| "--max-sessions 需要正整数".to_string())?
                }
                "--socket-mode" => {
                    let raw = value()?;
                    cfg.socket_mode = u32::from_str_radix(raw.trim_start_matches("0o"), 8)
                        .map_err(|_| "--socket-mode 需要八进制数字".to_string())?;
                }
                "--socket-gid" => {
                    cfg.socket_gid = Some(
                        value()?
                            .parse()
                            .map_err(|_| "--socket-gid 需要数字".to_string())?,
                    );
                }
                "--host" => cfg.dev_host = Some(value()?),
                "--port" => {
                    cfg.dev_port = Some(
                        value()?
                            .parse()
                            .map_err(|_| "--port 需要数字".to_string())?,
                    )
                }
                "--log-file" => cfg.log_file = Some(PathBuf::from(value()?)),
                "--require-admin" => {
                    cfg.require_admin = parse_bool(&value()?)
                        .ok_or_else(|| "--require-admin 需要 true/false".to_string())?
                }
                "--help" | "-h" => {
                    return Err(usage().to_string());
                }
                other => return Err(format!("未知参数: {}", other)),
            }
            i += 1;
        }
        // 归一化：去掉末尾斜杠，便于做前缀剥离
        while cfg.gateway_prefix.len() > 1 && cfg.gateway_prefix.ends_with('/') {
            cfg.gateway_prefix.pop();
        }
        if cfg.max_sessions == 0 {
            cfg.max_sessions = 1;
        }
        Ok(cfg)
    }
}

fn parse_bool(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn usage() -> &'static str {
    "nas-webterm <options>\n\
     \n\
     --socket <path>            unix socket 监听路径\n\
     --ui-dir <path>            前端静态资源目录\n\
     --gateway-prefix <prefix>  网关前缀，例如 /app/nas-webterm\n\
     --app-name <name>          应用名\n\
     --display-name <name>      显示名\n\
     --version <ver>            版本号\n\
     --shell <path>             默认 shell\n\
     --cwd <path>               默认工作目录\n\
     --startup-command <cmd>    新会话自动键入的命令\n\
     --idle-minutes <n>         会话空闲保留分钟数（0 = 立即回收）\n\
     --max-sessions <n>         最大并发会话数\n\
     --socket-mode <oct>        socket 权限（八进制，默认 600）\n\
     --socket-gid <gid>         socket 属组\n\
     --host <h> --port <p>      开发模式：监听 TCP\n\
     --log-file <path>          日志文件\n\
     --require-admin <bool>     是否要求管理员身份（默认 true）\n"
}
