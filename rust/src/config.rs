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

    /// 日志文件（追加写 + 自动轮转）
    pub log_file: Option<PathBuf>,
    /// 日志文件轮转阈值（字节），0 = 用默认值
    pub log_max_bytes: u64,

    /// 是否要求管理员身份（网关注入 X-Trim-Isadmin）
    pub require_admin: bool,

    /// 普通版：不加载、不注册任何 AI 相关能力（分版构建时由 cmd/main 传入）
    pub no_ai: bool,

    /// AI 助手配置文件路径（JSON）。为空时只在内存里保存，重启即丢。
    pub ai_config: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            socket: PathBuf::from("/tmp/nas-webterm.sock"),
            ui_dir: PathBuf::from("./ui"),
            gateway_prefix: "/app/nas-webterm".to_string(),
            app_name: "nas-webterm".to_string(),
            display_name: "Web 终端".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
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
            log_max_bytes: 0,
            require_admin: true,
            no_ai: false,
            ai_config: None,
        }
    }
}

impl Config {
    /// 本次「安装实例」的唯一标识，写进每个终端进程的环境变量。
    ///
    /// 用途有两个：
    ///   * 服务崩溃后重启时，据此清理上一次运行残留的孤儿 shell；
    ///   * 避免误杀**另一个实例**（例如同一台机器上同时装了普通版和 AI 版，
    ///     或者开发时 `tools/dev.sh` 起的调试服务和线上服务并存）。
    ///
    /// 取值 = 应用名 + socket 路径（开发模式用监听地址），同一个安装每次启动都一致。
    pub fn instance_tag(&self) -> String {
        if let Some(port) = self.dev_port {
            let host = self.dev_host.clone().unwrap_or_else(|| "127.0.0.1".to_string());
            return format!("{}|dev:{}:{}", self.app_name, host, port);
        }
        format!("{}|{}", self.app_name, self.socket.display())
    }

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
                "--log-max-bytes" => {
                    cfg.log_max_bytes = value()?
                        .parse()
                        .map_err(|_| "--log-max-bytes 需要非负整数".to_string())?
                }
                "--no-ai" => cfg.no_ai = true,
                "--require-admin" => {
                    cfg.require_admin = parse_bool(&value()?)
                        .ok_or_else(|| "--require-admin 需要 true/false".to_string())?
                }
                "--ai-config" => cfg.ai_config = Some(PathBuf::from(value()?)),
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
     --idle-minutes <n>         会话空闲保留分钟数（0 = 永不回收）\n\
     --max-sessions <n>         最大并发会话数\n\
     --socket-mode <oct>        socket 权限（八进制，默认 600）\n\
     --socket-gid <gid>         socket 属组\n\
     --host <h> --port <p>      开发模式：监听 TCP\n\
     --log-file <path>          日志文件（追加写，超限自动轮转）\n\
     --log-max-bytes <n>        日志轮转阈值（字节，默认 8MB）\n\
     --require-admin <bool>     是否要求管理员身份（默认 true）\n\
     --ai-config <path>         AI 助手配置文件（JSON，含 API Key）\n"
}
