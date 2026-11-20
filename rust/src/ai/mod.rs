//! AI 助手：把大模型接进终端，命令由用户审批后执行。
//!
//! 设计要点：
//!
//! * **密钥不出后端**。前端只能看到「是否已配置」和掩码，永远拿不到明文。
//! * **只有「删除」与「改写/覆盖文件」需要审批**。其它命令（查询、装包、
//!   启停服务、docker 操作…）由模型给完就直接写进 PTY，不再逐步打断用户。
//! * **不可逆操作额外拦截**。`rm -rf /`、`mkfs`、`dd of=/dev/sdX`、关机重启
//!   这类会在卡片上标红并要求二次确认。
//! * **预算按模型上下文比例分配**。终端上下文 60%、长期记忆 8%、历史对话 12%、
//!   单条命令回灌 10%，剩下的留给系统提示词与模型输出；步数按窗口大小分档。
//!   这些值不再暴露成用户可调项，避免配出「窗口 200k、上下文 6k」这种畸形组合。
//! * **不引入新的 TLS 依赖**。走 `curl` 子进程，因为交叉编译环境下
//!   拉 rustls/openssl 依赖不可靠；密钥通过 0600 临时配置文件传给 curl，
//!   不出现在 `ps` 的命令行里。

pub mod routes;
pub mod agent;
pub mod history;
pub mod protocol;
pub mod events;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// 1 token 大约等于多少字符。中文约 1 字/token，英文约 4 字符/token，
/// 取 3 作为中英混排的保守估计（宁可少喂一点，也别把窗口撑爆）。
const CHARS_PER_TOKEN: usize = 3;
/// 从回放缓冲区里取样多少字节来提取终端文本。
///
/// 与 session 的回放上限保持一致：缓冲区里只有这么多内容，
/// 取再多也拿不到更早的输出。
const CONTEXT_BYTES: usize = 1024 * 1024;
/// 终端上下文占模型上下文窗口的比例（用户要求 60%，剩下留给消息与记忆）。
const CONTEXT_PCT: usize = 60;
/// 长期记忆占比。
const MEMORY_PCT: usize = 8;
/// 历史对话占比。
const HISTORY_PCT: usize = 12;
/// 单条命令输出回灌占比。
const OBSERVE_PCT: usize = 10;
/// 单次请求的超时（秒）。
const REQUEST_TIMEOUT: u64 = 120;

/// 落盘的 AI 配置。字段全部可选，缺省值由 `Default` 提供。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiConfig {
    /// 总开关：关掉之后前端不再显示 AI 面板
    #[serde(default)]
    pub enabled: bool,
    /// OpenAI 兼容的 base url，例如 https://api.deepseek.com/v1
    #[serde(default = "default_base_url")]
    #[serde(alias = "baseUrl")]
    pub base_url: String,
    /// API Key（只在后端保存，接口返回时打码）
    #[serde(default)]
    #[serde(alias = "apiKey")]
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default = "default_system_prompt")]
    #[serde(alias = "systemPrompt")]
    pub system_prompt: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    #[serde(alias = "maxTokens")]
    pub max_tokens: u32,
    /// 是否把终端最近输出作为上下文一起发给模型
    #[serde(default = "default_true")]
    #[serde(alias = "includeContext")]
    pub include_context: bool,
    /// 流式输出
    #[serde(default = "default_true")]
    pub stream: bool,
    /// 模型的上下文窗口（tokens）。用户按实际模型填：1M / 200k / 128k…
    ///
    /// 终端上下文、长期记忆、历史对话、单条命令回灌、步数上限**全部按它换算**，
    /// 不再单独暴露成一堆数字设置项——那些值一旦和模型窗口对不上，
    /// 要么白白浪费窗口，要么直接把请求撑爆。
    #[serde(default = "default_context_window")]
    #[serde(alias = "contextWindow")]
    pub context_window: usize,
    /// 长期记忆：把跨会话的事实写到 ai-memory.md，下次自动带上
    #[serde(default = "default_true")]
    #[serde(alias = "memoryEnabled")]
    pub memory_enabled: bool,
    /// 模型思考强度：留空表示不传（用服务端默认），可选 minimal/low/medium/high。
    /// 走 OpenAI 兼容的 `reasoning_effort` 字段。
    #[serde(default)]
    #[serde(alias = "reasoningEffort")]
    pub reasoning_effort: String,
}

/// 历史版本的出厂提示词前缀。
///
/// 用户升级后 `ai.json` 里还留着旧版默认提示词——那是我们写的，不是用户写的。
/// 不认出来换掉的话，1.0.6 的 agent 交互就永远拿不到新提示词。
const LEGACY_PROMPT_PREFIXES: &[&str] = &[
    "你是一个嵌在 Linux 终端里的运维助手",
    "你是一个 Linux 终端里的运维助手",
    // 1.0.6–1.0.8 的出厂提示词。升级后自动换成下面针对 Debian 12 / fnOS 的版本。
    "你是嵌在 Linux 终端里的 AI 运维 agent",
    // 1.0.9–1.1.x 的出厂提示词（缺「必须执行、不许只念命令」的约束）
    "你是飞牛 OS（fnOS）终端里的运维 agent",
];

fn default_base_url() -> String {
    "https://api.deepseek.com/v1".to_string()
}
fn default_model() -> String {
    "deepseek-chat".to_string()
}
fn default_temperature() -> f32 {
    0.2
}
fn default_max_tokens() -> u32 {
    2048
}
fn default_true() -> bool {
    true
}
/// 默认按 1M 上下文（现在主流大模型常见规格），用户可在设置里改。
fn default_context_window() -> usize {
    1_000_000
}
fn default_system_prompt() -> String {
    r#"你是飞牛 OS（fnOS）终端里的运维 agent，运行在管理员 root shell 中。fnOS 底层是 Debian 12 (bookworm)。
用户用中文描述目标，你负责用尽量少的命令把事办成，并如实汇报结果。

环境事实：
- 系统：Debian 12 bookworm；systemd 管理服务；apt 可用，但不要跑交互式安装（用 apt-get -y，并事先说明会装什么）。
- fnOS 组件在 /usr/trim，相关服务以 trim_ 开头（trim_http_cgi、trim_app_center、trim_init 等），非必要不要停止或禁用。
- 应用目录：/var/apps/<app>，其中 target 指向 /vol*/@appcenter，var 指向 /vol*/@appdata，etc 指向 /vol*/@appconf；存储卷通常是 /vol1、/vol2…
- 自带 docker（容器数据由 fnOS 管理），删除容器/镜像或停止服务前先说明影响。
- 当前用户已是 root，命令不要加 sudo。不要执行关机、重启、格盘类操作，除非用户明确要求。

回复风格（重要）：
- 像资深 Linux 运维同事：直接、简短，不寒暄、不重复用户的问题、不写“当然可以”“好的，我来帮您”这类开场。
- 每一步最多两三句话：要做什么、为什么。结论优先，过程从简。
- 不要输出思考过程，不要用 emoji，不要堆标题和分隔线。

执行协议（最重要）：
- **你必须自己执行命令，绝不允许只把命令写在正文里让用户复制去跑。** 需要动手就必须用下面的标签输出：
<execute_command>
<command>完整命令（单行，可含管道与参数）</command>
<purpose>一句话说明这条命令的目的</purpose>
</execute_command>
- 一次只给一条命令，标签外不要重复命令内容；不要写 "你可以运行……" 这种话。
- **给出命令标签后立即结束本次回复**，不要再写结论、总结或下一步。命令的执行结果会由系统在下一轮消息里以「命令已执行结束（退出码：N）」发给你；在收到它之前，你不可能知道结果，**绝对不要提前汇报完成或编造输出**。
- 不要用 Markdown 代码块代替 `<execute_command>` 标签；如果只打算回答问题或总结，就不要输出任何命令标签。
- 命令会**自动执行**，你不需要判断是否需要审批：只有「删除文件/目录」「改写或覆盖文件」以及关机/格式化这类不可逆操作才会弹给用户确认，其余包括查询、装包、启停服务、docker 操作都会直接跑。
- 因为会自动执行，命令必须写完整、写准确（路径用绝对路径，破坏性操作前先确认对象），不要输出半条命令或占位符，命令保持单行、不要写注释。
- **交互式 / 全屏程序**（`vim`、`top`、`htop`、`less`、`tail -f`、`watch`、`journalctl -f`、`read`…）会一直阻塞，超过最长等待时间会被 Ctrl+C 中断。除非用户明确要求在终端里打开它，否则改用一次性参数（`top -b -n 1`、`journalctl --no-pager -n 50`、`tail -n 50`、`w`、`ps aux`…）。
- 需要几条命令才能完成时：先给第 0 步，拿到输出后再给下一步，不要一次性把整段脚本丢给用户。**一次回复最多一条命令，等它的执行结果返回后再决定下一步。**
- 拿到输出后先判断是否达成目标：没达成就给下一条；达成后用简短 Markdown 总结（列表或小表格即可）。
- 命令失败先看错误原因再换方案，不要原样重试。不要编造输出。一次只针对一个目标。

记忆：
- 一旦出现值得跨会话记住的事实（机器用途、硬件、目录约定、装过的服务、用户的偏好/习惯/长期计划），**必须**在回复末尾用一行 <remember>一句话</remember> 记下，不要只在正文里说"我记住了"。
- 只记稳定的、以后还用得上的事实；一次性的查询结果不要记。"#
        .to_string()
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_base_url(),
            api_key: String::new(),
            model: default_model(),
            system_prompt: default_system_prompt(),
            temperature: default_temperature(),
            max_tokens: default_max_tokens(),
            include_context: true,
            stream: true,
            context_window: default_context_window(),
            memory_enabled: true,
            reasoning_effort: String::new(),
        }
    }
}

impl AiConfig {
    /// 给前端看的版本：密钥换成掩码 + 是否已配置。
    ///
    /// 系统提示词是产品的一部分，不下发到浏览器——前端没有用，也避免用户把它
    /// 当成「可调参数」改坏交互协议。
    pub fn public_view(&self) -> serde_json::Value {
        serde_json::json!({
            "enabled": self.enabled,
            "baseUrl": self.base_url,
            "model": self.model,
            // f32 直接序列化会变成 0.20000000298023224，前端显示很难看。
            // 先转 f64 再取两位小数，serde 才会输出成 0.2。
            "temperature": ((self.temperature as f64) * 100.0).round() / 100.0,
            "maxTokens": self.max_tokens,
            "includeContext": self.include_context,
            "stream": self.stream,
            "hasKey": !self.api_key.is_empty(),
            "keyMask": mask_key(&self.api_key),
            "contextWindow": self.context_window,
            "memoryEnabled": self.memory_enabled,
            "reasoningEffort": self.reasoning_effort,
            // 只读的派生结果：前端直接显示，避免两边各算一套、显示与实际不一致
            "derived": {
                "contextChars": self.context_chars(),
                "observeChars": self.observe_chars(),
                "memoryMaxChars": self.memory_max_chars(),
                "historyTurns": self.history_turns(),
                "maxSteps": self.max_steps(),
            },
        })
    }

    /// 终端上下文长度（字符）：窗口的 60%。
    pub fn context_chars(&self) -> usize {
        let chars = self.context_window.saturating_mul(CONTEXT_PCT) / 100 * CHARS_PER_TOKEN;
        chars.clamp(8_000, 1_500_000)
    }

    /// 单条命令输出回灌给模型的长度（字符）：窗口的 10%。
    pub fn observe_chars(&self) -> usize {
        let chars = self.context_window.saturating_mul(OBSERVE_PCT) / 100 * CHARS_PER_TOKEN;
        chars.clamp(4_000, 120_000)
    }

    /// 长期记忆容量（字符）：窗口的 8%。
    pub fn memory_max_chars(&self) -> usize {
        let chars = self.context_window.saturating_mul(MEMORY_PCT) / 100 * CHARS_PER_TOKEN;
        chars.clamp(4_000, 60_000)
    }

    /// 保留的历史对话轮数：窗口的 12%，按每轮约 2000 字符估算。
    pub fn history_turns(&self) -> usize {
        let chars = self.context_window.saturating_mul(HISTORY_PCT) / 100 * CHARS_PER_TOKEN;
        (chars / 2_000).clamp(4, 40)
    }

    /// 单次任务的步数上限：按窗口分档。
    ///
    /// 之前固定 12 步，稍微复杂一点的任务（先查→再改→再验证）就撞上限；
    /// 现在窗口越大给得越多，1M 窗口可以跑 64 步。
    pub fn max_steps(&self) -> usize {
        match self.context_window {
            w if w >= 800_000 => 64,
            w if w >= 400_000 => 56,
            w if w >= 200_000 => 48,
            w if w >= 100_000 => 36,
            w if w >= 32_000 => 24,
            _ => 16,
        }
    }
}

/// 掩码只保留头尾几位，中间用 `*`。空 key 返回空串。
fn mask_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    if chars.len() <= 8 {
        return "*".repeat(chars.len());
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}{}{}", head, "*".repeat(8), tail)
}

/// 配置文件的读写。用 `Mutex` 串行化，避免两个请求同时写坏文件。
pub struct AiStore {
    path: PathBuf,
    cache: Mutex<AiConfig>,
    /// 聊天记录（会话历史）。和 ai.json 放同一个目录。
    history: Arc<history::ChatHistory>,
}

impl AiStore {
    /// `path` 为 `None` 时只在内存里保存（开发模式 / 没给 `--ai-config`）。
    pub fn load(path: Option<PathBuf>) -> Self {
        // 上次运行被 SIGKILL / 断电时，临时 curl 配置（里面有 API Key）会留在
        // 临时目录里。启动时清掉一小时前的残留，避免密钥长期裸在磁盘上。
        cleanup_stale_curl_conf();
        let mut cfg = AiConfig::default();
        if let Some(p) = path.as_deref() {
            match std::fs::read_to_string(p) {
                Ok(raw) => match serde_json::from_str::<AiConfig>(&raw) {
                    Ok(parsed) => cfg = parsed,
                    Err(e) => crate::log_warn!("AI 配置解析失败，使用默认值: {}", e),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => crate::log_warn!("AI 配置读取失败，使用默认值: {}", e),
            }
        }
        let history = Arc::new(history::ChatHistory::load(
            path.as_deref().map(history::history_path_for),
        ));
        let store = Self {
            path: path.unwrap_or_default(),
            cache: Mutex::new(cfg),
            history,
        };
        store.migrate_default_prompt();
        store
    }

    /// 聊天记录存储。
    pub fn history(&self) -> &Arc<history::ChatHistory> {
        &self.history
    }

    /// 把「旧版出厂提示词」换成当前版本，并把结果写回磁盘。
    ///
    /// 只认历史默认值的前缀：用户自己改过的提示词（哪怕是以这些词开头）不动。
    fn migrate_default_prompt(&self) {
        // 注意：当前出厂提示词和 1.0.9–1.1.x 的开头是同一句话，只按前缀判断会把
        // **当前版本**也当成老版本，于是每次启动都重写一遍 ai.json（线上日志里
        // 每次启动都出现「提示词已升级」就是这个原因）。所以先排除「等于当前默认值」。
        let current = default_system_prompt();
        let outdated = {
            let guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            let cur = guard.system_prompt.trim();
            cur.is_empty()
                || (cur != current.trim() && LEGACY_PROMPT_PREFIXES.iter().any(|p| cur.starts_with(p)))
        };
        if !outdated {
            return;
        }
        let updated = {
            let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            guard.system_prompt = default_system_prompt();
            guard.clone()
        };
        if self.path.as_os_str().is_empty() {
            return;
        }
        match save_to(&self.path, &updated) {
            Ok(()) => crate::log_info!("AI 提示词已升级为当前版本的 agent 风格"),
            Err(e) => crate::log_warn!("AI 提示词升级后写盘失败: {}", e),
        }
    }

    /// 长期记忆文件路径（跟 ai.json 同目录）。没配 --ai-config 时返回空路径。
    pub fn memory_path(&self) -> PathBuf {
        if self.path.as_os_str().is_empty() {
            return PathBuf::new();
        }
        memory_path_for(&self.path)
    }

    /// 当前生效的长期记忆内容（未启用或未配置路径时为空）。
    pub fn memory_text(&self) -> String {
        let cfg = self.get();
        if !cfg.memory_enabled {
            return String::new();
        }
        let p = self.memory_path();
        if p.as_os_str().is_empty() {
            return String::new();
        }
        read_memory(&p, cfg.memory_max_chars())
    }

    /// 覆写长期记忆（设置窗里手动编辑）。
    pub fn set_memory(&self, text: &str) -> Result<(), String> {
        let p = self.memory_path();
        if p.as_os_str().is_empty() {
            return Err("未配置 AI 配置文件路径，无法保存记忆".to_string());
        }
        write_memory(&p, text)
    }

    pub fn get(&self) -> AiConfig {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 合并式更新：只覆盖请求里出现的字段。
    ///
    /// `api_key` 为空字符串时视为「不修改」，避免前端把掩码回传后把真 key 清掉。
    pub fn update(&self, patch: &serde_json::Value) -> Result<AiConfig, String> {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let mut cfg = guard.clone();

        if let Some(v) = patch.get("enabled").and_then(|v| v.as_bool()) {
            cfg.enabled = v;
        }
        if let Some(v) = patch.get("baseUrl").and_then(|v| v.as_str()) {
            let v = v.trim().trim_end_matches('/').to_string();
            if v.is_empty() {
                return Err("接口地址不能为空".to_string());
            }
            if !(v.starts_with("http://") || v.starts_with("https://")) {
                return Err("接口地址必须以 http:// 或 https:// 开头".to_string());
            }
            cfg.base_url = v;
        }
        if let Some(v) = patch.get("apiKey").and_then(|v| v.as_str()) {
            let v = v.trim();
            // 空串 = 不改；特殊值 `-` = 清除
            if v == "-" {
                cfg.api_key.clear();
            } else if !v.is_empty() {
                cfg.api_key = v.to_string();
            }
        }
        if let Some(v) = patch.get("model").and_then(|v| v.as_str()) {
            let v = v.trim().to_string();
            if v.is_empty() {
                return Err("模型名不能为空".to_string());
            }
            cfg.model = v;
        }
        // systemPrompt 不再接受前端写入：提示词属于产品行为，前端也不再展示。
        // 老前端仍可能带上这个字段，这里静默忽略。
        if let Some(v) = patch.get("temperature").and_then(|v| v.as_f64()) {
            cfg.temperature = v.clamp(0.0, 2.0) as f32;
        }
        if let Some(v) = patch.get("maxTokens").and_then(|v| v.as_f64()) {
            cfg.max_tokens = (v as u64).clamp(64, 32768) as u32;
        }
        if let Some(v) = patch.get("includeContext").and_then(|v| v.as_bool()) {
            cfg.include_context = v;
        }
        // 旧的 autoExecSafe / maxSteps / historyTurns / contextChars /
        // observeChars / memoryMaxChars 已不再作为配置项：预算全部按
        // contextWindow 的比例推导。老前端仍可能带上这些字段，静默忽略。
        // 用 as_f64 兜底：前端把输入框转成 Number 后，带小数的值会序列化成
        // 浮点，as_u64() 取不到 → 会「静默不生效」，用户以为改了其实没改。
        if let Some(v) = patch
            .get("contextWindow")
            .or_else(|| patch.get("context_window"))
            .and_then(|v| v.as_f64())
        {
            if v < 8_000.0 || v > 4_000_000.0 {
                return Err("模型上下文需在 8000 ~ 4000000 tokens 之间".to_string());
            }
            cfg.context_window = v as usize;
        }
        if let Some(v) = patch
            .get("reasoningEffort")
            .or_else(|| patch.get("reasoning_effort"))
            .and_then(|v| v.as_str())
        {
            let v = v.trim().to_ascii_lowercase();
            // 留空 = 不传；其余只接受这几个标准取值，避免把奇怪的值透给上游
            cfg.reasoning_effort = match v.as_str() {
                "" | "default" | "none" => String::new(),
                "minimal" | "low" | "medium" | "high" => v,
                _ => return Err("思考强度只支持 minimal/low/medium/high 或留空".to_string()),
            };
        }
        if let Some(v) = patch.get("stream").and_then(|v| v.as_bool()) {
            cfg.stream = v;
        }
        if let Some(v) = patch.get("memoryEnabled").and_then(|v| v.as_bool()) {
            cfg.memory_enabled = v;
        }

        if !self.path.as_os_str().is_empty() {
            save_to(&self.path, &cfg)?;
        }
        *guard = cfg.clone();
        Ok(cfg)
    }
}

/// 原子写：先写 `.tmp` 再 rename，避免进程被杀时留下半个 JSON。
fn save_to(path: &Path, cfg: &AiConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
        }
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| format!("序列化失败: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("写入配置失败: {}", e))?;
    // 配置里有 API Key，权限收到 0600
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("保存配置失败: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------- 对话请求

/// 前端传来的一条消息。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

/// 请求体（OpenAI 兼容）。
/// agent 模式的消息组装：系统提示词 + 已有对话。
///
/// 终端上下文由调用方拼进 user 消息（每步都要刷新，不能只放一次）。
pub fn build_agent_messages(
    cfg: &AiConfig,
    history: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    let mut out = Vec::with_capacity(history.len() + 1);
    out.push(serde_json::json!({"role": "system", "content": cfg.system_prompt}));
    for m in history {
        let role = match m.get("role").and_then(|v| v.as_str()) {
            Some("assistant") => "assistant",
            _ => "user",
        };
        let content = m.get("content").and_then(|v| v.as_str()).unwrap_or("");
        out.push(serde_json::json!({"role": role, "content": content}));
    }
    out
}

/// 把上游错误翻成「人话 + 处理建议」。
///
/// 最常见的是上下文超限：模型窗口填大了（比如默认 1M 却用了只支持 64k 的模型），
/// 上游会回一大段英文 JSON，用户根本不知道要改哪里。
pub fn friendly_model_error(raw: &str) -> String {
    let low = raw.to_ascii_lowercase();
    let hint = if low.contains("context")
        && (low.contains("length")
            || low.contains("maximum")
            || low.contains("too long")
            || low.contains("exceed")
            || low.contains("window"))
    {
        "；上下文超出模型窗口：到设置里把「模型上下文」改成模型实际支持的大小（64k 填 64000，128k 填 128000）"
    } else if low.contains("401")
        || low.contains("invalid api key")
        || low.contains("unauthorized")
        || low.contains("authentication")
    {
        "；API Key 无效或没有权限，请到设置里重新填写"
    } else if low.contains("404") || (low.contains("model") && low.contains("not found")) {
        "；模型名或接口地址不对，请检查设置"
    } else {
        ""
    };
    format!("{}{}", raw.trim(), hint)
}

/// 把消息列表压进上下文预算。
///
/// 估算方式：1 token ≈ 3 字符；预算取窗口的 85%（剩下 15% 留给模型输出）。
/// 超出时从**最老的对话**开始删，保留第一条（任务上下文 + 用户请求）与
/// 最后一条（最新一条命令输出）；仍然超出就把第一条从头部截断。
///
/// 没有这一步的话，长任务跑到二三十步、每步回灌几万字符，请求会直接
/// 超过模型窗口被上游 400 拒绝——表现就是「AI 忽然不说话了」。
pub fn trim_messages_to_budget(cfg: &AiConfig, messages: &mut Vec<serde_json::Value>) {
    let len_of = |m: &serde_json::Value| -> usize {
        m.get("content")
            .and_then(|c| c.as_str())
            .map(|s| s.chars().count())
            .unwrap_or(0)
    };
    let budget = cfg
        .context_window
        .saturating_mul(CHARS_PER_TOKEN)
        .saturating_mul(85)
        / 100;
    let mut total: usize = messages.iter().map(len_of).sum::<usize>() + cfg.system_prompt.chars().count();

    while total > budget && messages.len() > 2 {
        total = total.saturating_sub(len_of(&messages[1]));
        messages.remove(1);
    }

    if total > budget && !messages.is_empty() {
        let first_len = len_of(&messages[0]);
        let keep = budget
            .saturating_sub(total.saturating_sub(first_len))
            .max(2_000);
        if first_len > keep {
            if let Some(content) = messages[0].get("content").and_then(|c| c.as_str()) {
                let chars: Vec<char> = content.chars().collect();
                let tail: String = chars[chars.len() - keep..].iter().collect();
                messages[0]["content"] = serde_json::json!(tail);
                crate::log_debug!("上下文超预算，已截断首条消息到 {} 字符", keep);
            }
        }
    }
}

pub fn request_body(cfg: &AiConfig, messages: &[serde_json::Value]) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": cfg.model,
        "messages": messages,
        "temperature": cfg.temperature,
        "max_tokens": cfg.max_tokens,
        "stream": cfg.stream,
    });
    // 思考强度：留空就不传，交给服务端默认值（不同供应商支持的取值不一样）
    let effort = cfg.reasoning_effort.trim();
    if !effort.is_empty() {
        if let Some(obj) = body.as_object_mut() {
            obj.insert(
                "reasoning_effort".to_string(),
                serde_json::Value::String(effort.to_string()),
            );
        }
    }
    body
}

/// 把 base_url 拼成 chat/completions 的完整地址。
///
/// 用户可能填 `https://api.deepseek.com`、`.../v1`、甚至直接填完整端点，
/// 三种都接受。
pub fn completions_url(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        b.to_string()
    } else {
        format!("{}/chat/completions", b)
    }
}

// ---------------------------------------------------------------- 长期记忆

/// 长期记忆文件跟 `ai.json` 放同一目录，名字固定。
pub fn memory_path_for(config_path: &Path) -> PathBuf {
    config_path.with_file_name("ai-memory.md")
}

/// 读长期记忆（尾部最多 `max_chars` 字符）。
pub fn read_memory(path: &Path, max_chars: usize) -> String {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        return trimmed.to_string();
    }
    // 超了就保留最近的（后面的更重要）
    let tail: String = chars[chars.len() - max_chars..].iter().collect();
    format!("…（更早的记忆已省略）\n{}", tail)
}

/// 追加一条记忆。已存在的行不重复写，整体超长时丢掉最旧的行。
pub fn append_memory(path: &Path, fact: &str, max_chars: usize) -> Result<(), String> {
    let fact = fact.trim().replace('\n', " ");
    if fact.is_empty() {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建记忆目录失败: {}", e))?;
        }
    }
    let mut lines: Vec<String> = std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.iter().any(|l| l == &fact) {
        return Ok(());
    }
    lines.push(fact);
    // 超出容量就从最旧的开始丢
    loop {
        let joined = lines.join("\n");
        if joined.chars().count() <= max_chars || lines.len() <= 1 {
            break;
        }
        lines.remove(0);
    }
    let body = lines.join("\n");
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("写入记忆失败: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("保存记忆失败: {}", e))?;
    Ok(())
}

/// 整体覆写长期记忆（用户在设置里手动编辑时用）。空文本 = 清空。
pub fn write_memory(path: &Path, text: &str) -> Result<(), String> {
    let body = text.trim();
    if body.is_empty() {
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建记忆目录失败: {}", e))?;
        }
    }
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("写入记忆失败: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("保存记忆失败: {}", e))?;
    Ok(())
}

/// 从模型回复里抽出 `<remember>…</remember>` 的内容。
pub fn extract_memories(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let lower = text.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find("<remember>") {
        let start = from + rel + "<remember>".len();
        let Some(end_rel) = lower[start..].find("</remember>") else {
            break;
        };
        let body = text[start..start + end_rel].trim();
        if !body.is_empty() {
            out.push(body.to_string());
        }
        from = start + end_rel + "</remember>".len();
    }
    out
}

/// 从终端回放缓冲区取一段纯文本作为上下文（长度由配置决定）。
pub fn terminal_context(session: &crate::session::Session, chars: usize) -> String {
    session.tail_text(CONTEXT_BYTES, chars.max(200))
}

// ------------------------------------------------------------ curl 子进程

/// 流式调用时从 curl 里逐行读到的事件。
pub enum StreamEvent {
    /// 一行原始输出（SSE 的 `data: ...`）
    Line(String),
    /// curl 结束：`success = false` 时 `stderr` 里有原因
    Finished { success: bool, stderr: String },
}

/// 流式调用模型：立刻返回一个事件接收端，curl 在后台跑。
///
/// 前端拿到第一段文本就能开始渲染，不用等整个回复生成完
/// （长回答动辄十几秒，等完再显示体验很差）。
pub fn call_model_stream(
    cfg: &AiConfig,
    body: &serde_json::Value,
) -> Result<tokio::sync::mpsc::Receiver<StreamEvent>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    if cfg.api_key.trim().is_empty() {
        return Err("尚未配置 API Key".to_string());
    }
    let url = completions_url(&cfg.base_url);
    let cfg_path = write_curl_conf(cfg, &url)?;
    let payload = serde_json::to_vec(body).map_err(|e| format!("序列化请求失败: {}", e))?;

    let (tx, rx) = tokio::sync::mpsc::channel::<StreamEvent>(64);
    tokio::spawn(async move {
        let spawned = tokio::process::Command::new("curl")
            .arg("-K")
            .arg(&cfg_path)
            .arg("--data-binary")
            .arg("@-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let mut child = match spawned {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&cfg_path);
                let _ = tx
                    .send(StreamEvent::Finished {
                        success: false,
                        stderr: format!("无法启动 curl: {}", e),
                    })
                    .await;
                return;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(&payload).await;
            drop(stdin);
        }
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout).lines();
            // 接收端断开（用户关面板）时立刻停，不要继续白跑
            while let Ok(Some(line)) = reader.next_line().await {
                if tx.send(StreamEvent::Line(line)).await.is_err() {
                    let _ = child.kill().await;
                    let _ = std::fs::remove_file(&cfg_path);
                    return;
                }
            }
        }
        let mut err_text = String::new();
        if let Some(stderr) = child.stderr.take() {
            let mut ereader = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = ereader.next_line().await {
                err_text.push_str(&line);
                err_text.push('\n');
            }
        }
        let success = child.wait().await.map(|s| s.success()).unwrap_or(false);
        let _ = std::fs::remove_file(&cfg_path);
        let _ = tx.send(StreamEvent::Finished { success, stderr: err_text }).await;
    });
    Ok(rx)
}

/// 清掉上次运行遗留的 curl 临时配置（超过 1 小时的）。
///
/// 正常请求的 `max-time` 是 120s，所以一小时前的文件一定不是本次运行在用的；
/// 不删得太激，避免误删同机另一个实例正在用的配置。
fn cleanup_stale_curl_conf() {
    let dir = std::env::temp_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !name.starts_with(".nas-webterm-ai-") || !name.ends_with(".conf") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else { continue };
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > 3600 && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        crate::log_info!("清理了 {} 个上次运行遗留的 AI 临时配置", removed);
    }
}

/// 把 curl 配置写到 0600 的临时文件（密钥不进命令行，避免被 `ps` 看到）。
fn write_curl_conf(cfg: &AiConfig, url: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    let stamp = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let cfg_path = std::env::temp_dir().join(format!(".nas-webterm-ai-{}.conf", stamp));
    // curl 配置里，值中的反斜杠和引号要转义
    let escape = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let conf = format!(
        "silent\nshow-error\nno-buffer\nhttp1.1\n\
         max-time = {}\n\
         header = \"Content-Type: application/json\"\n\
         header = \"Authorization: Bearer {}\"\n\
         url = \"{}\"\n",
        REQUEST_TIMEOUT,
        escape(cfg.api_key.trim()),
        escape(url)
    );
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&cfg_path)
        .map_err(|e| format!("创建临时配置失败: {}", e))?;
    f.write_all(conf.as_bytes())
        .map_err(|e| format!("写入临时配置失败: {}", e))?;
    Ok(cfg_path)
}

// ------------------------------------------------------------ 响应解析

/// 流式响应里一个 data 块的内容。
#[derive(Debug, Default)]
pub struct StreamDelta {
    /// 增量文本
    pub text: String,
    /// 是否收到结束标记
    pub done: bool,
    /// 服务端在流里返回的错误
    pub error: Option<String>,
}

/// 解析一行 SSE。不是 data 行就返回 `None`。
pub fn parse_sse_line(line: &str) -> Option<StreamDelta> {
    let payload = line.strip_prefix("data:")?.trim();
    if payload == "[DONE]" {
        return Some(StreamDelta {
            done: true,
            ..Default::default()
        });
    }
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    // 有些兼容实现把错误塞在流里
    if let Some(err) = value.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("模型返回错误");
        return Some(StreamDelta {
            error: Some(msg.to_string()),
            ..Default::default()
        });
    }
    let text = value
        .pointer("/choices/0/delta/content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    Some(StreamDelta {
        text,
        done: false,
        error: None,
    })
}

// ------------------------------------------------------------ 命令提取

/// 一条从模型回复里抽出来的命令。
#[derive(Debug, Clone, Serialize)]
pub struct ExtractedCommand {
    pub command: String,
    /// 模型给出的「这条命令要干什么」（没有则为空）
    #[serde(default)]
    pub purpose: String,
    /// 是否需要二次确认（高危）
    pub danger: bool,
    /// 危险原因，`danger = false` 时为空
    pub reason: String,
    /// 是否需要人工确认（删除 / 改写文件 / 整机级不可逆操作）
    pub needs_approval: bool,
}

/// 解析 chaterm 风格的工具调用标签。
///
/// chaterm（以及 Cline）让模型输出 XML 标签而不是 Markdown 代码块：
///
/// ```text
/// <execute_command>
/// <command>df -h</command>
/// <requires_approval>true</requires_approval>
/// </execute_command>
/// ```
///
/// 这里同时支持两种格式：模型训练数据里两种写法都很常见，
/// 只认一种会让另一批模型「看起来不会执行命令」。
fn extract_tool_tags(text: &str) -> Vec<ExtractedCommand> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some((_open_start, body_start)) = find_tag_open(text, "execute_command", from) {
        let Some((body_end, close_end)) = find_tag_close(text, "execute_command", body_start) else {
            // 标签没闭合：流式输出途中，先不抽
            break;
        };
        let body = &text[body_start..body_end];
        from = close_end;
        if let Some(cmd) = tag_value(body, "command").map(|c| normalize_model_command(&c)) {
            let mut item = classify(&cmd);
            item.purpose = tag_value(body, "purpose").unwrap_or_default();
            // <requires_approval> 是旧协议遗留字段：是否审批由服务端按
            // 「删除 / 改写文件」规则判断，不信任模型的自述，这里直接忽略。
            out.push(item);
        } else {
            // 有些模型省略 <command> 包装，直接写 <execute_command>df -h</execute_command>。
            // 只要第一行确实像 shell 命令就收下，避免「只把命令念给用户听」。
            let first = body
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with('<'));
            if let Some(cmd) = first.map(normalize_model_command) {
                if crate::ai::agent::looks_like_command_line(&cmd) {
                    let mut item = classify(&cmd);
                    item.purpose = tag_value(body, "purpose").unwrap_or_default();
                    out.push(item);
                }
            }
        }
    }
    out
}

/// 找 `<tag ...>` 的开标签，返回 `(标签起点, 标签体起点)`。
///
/// 兼容模型常见写法：`<execute_command>`、`<execute_command >`、
/// `<execute_command language="bash">`、大小写混写。
fn find_tag_open(text: &str, tag: &str, from: usize) -> Option<(usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let needle = format!("<{}", tag);
    let mut pos = from.min(lower.len());
    while let Some(rel) = lower[pos..].find(&needle) {
        let start = pos + rel;
        let after = start + needle.len();
        let rest = &text[after..];
        // 必须刚好是标签名，不能把 <execute_command_foo> 认成 execute_command
        if let Some(gt) = rest.find('>') {
            let attr = &rest[..gt];
            if attr.is_empty() || attr.starts_with(char::is_whitespace) {
                return Some((start, after + gt + 1));
            }
        }
        pos = start + 1;
    }
    None
}

/// 找 `</tag>` 的闭标签，返回 `(标签体结束, 闭标签结束)`。
fn find_tag_close(text: &str, tag: &str, from: usize) -> Option<(usize, usize)> {
    let lower = text.to_ascii_lowercase();
    let needle = format!("</{}", tag);
    let mut pos = from.min(lower.len());
    while let Some(rel) = lower[pos..].find(&needle) {
        let start = pos + rel;
        let after = start + needle.len();
        let rest = &text[after..];
        if let Some(gt) = rest.find('>') {
            let attr = &rest[..gt];
            if attr.trim().is_empty() {
                return Some((start, after + gt + 1));
            }
        }
        pos = start + 1;
    }
    None
}

/// 取 `<tag ...>value</tag>` 里的值（只取第一处）。
fn tag_value(body: &str, tag: &str) -> Option<String> {
    let (_, body_start) = find_tag_open(body, tag, 0)?;
    let (body_end, _) = find_tag_close(body, tag, body_start)?;
    let value = body[body_start..body_end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// 给 `/api/ai/exec` 用的危险命令判定（服务端复核，不信任前端）。
pub fn classify_for_exec(cmd: &str) -> ExtractedCommand {
    classify(cmd)
}

/// 从 Markdown 回复里抽出 shell 代码块。
///
/// 除了 ` ```sh ` / ` ```bash ` / ` ```shell ` / ` ```zsh ` 这类明确标注，
/// 也接受没有语言标注（或标成 `text`）但内容明显是命令的代码块——很多模型
/// 只写裸 ```，旧实现会把它当普通文本显示，用户就看到「命令念了一遍但没执行」。
pub fn extract_commands(text: &str) -> Vec<ExtractedCommand> {
    // XML 工具标签（chaterm / Cline 风格）与 Markdown 代码块两种格式都收
    let mut out = extract_tool_tags(text);
    let mut fence: Option<(char, String)> = None;
    let mut buf = String::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((ch, lang)) = fence.as_ref() {
            if is_fence_close(trimmed, *ch) {
                let cmds = split_commands(&buf);
                let shell_lang = is_shell_lang(lang);
                // 无语言 / text 代码块：只有每一行都像命令才执行，
                // 避免把命令输出、日志、示例文本误当命令。
                let content_is_command = !cmds.is_empty()
                    && cmds.iter().all(|c| crate::ai::agent::looks_like_command_line(c));
                if shell_lang || content_is_command {
                    for cmd in cmds {
                        out.push(classify(&cmd));
                    }
                }
                fence = None;
                buf.clear();
                continue;
            }
            buf.push_str(line);
            buf.push('\n');
            continue;
        }
        if let Some((ch, lang)) = parse_fence(trimmed) {
            fence = Some((ch, lang));
            buf.clear();
        }
    }
    out
}

/// 找到回复里「第一条真正会被执行的命令」的字节起点。
///
/// 流式输出时只能先扣住看起来像命令的标签/代码块；等整段回复收完，
/// 再用这个函数确认真正命令的位置。这样非命令代码块（输出示例、表格）
/// 可以补发，命令标签后面的「已完成」也不会提前显示。
pub fn first_command_start(text: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    let mut best = lower.find("<execute_command");
    let mut fence: Option<(char, String, usize, usize)> = None; // ch, lang, start, body_start
    let mut offset = 0usize;
    for line in text.split_inclusive('\n') {
        let raw = line.strip_suffix('\n').unwrap_or(line);
        let trimmed = raw.trim();
        if let Some((ch, lang, start, body_start)) = fence.as_ref() {
            if is_fence_close(trimmed, *ch) {
                let body = text.get(*body_start..offset).unwrap_or("");
                let cmds = split_commands(body);
                let command_block = is_shell_lang(lang)
                    || (!cmds.is_empty()
                        && cmds.iter().all(|c| crate::ai::agent::looks_like_command_line(c)));
                if command_block {
                    best = Some(best.map(|b| b.min(*start)).unwrap_or(*start));
                }
                fence = None;
            }
        } else if let Some((ch, lang)) = parse_fence(trimmed) {
            let body_start = offset + line.len();
            fence = Some((ch, lang, offset, body_start));
        }
        offset += line.len();
    }
    best
}

/// 识别代码块起始行，返回 (围栏字符, 语言标记)。
fn parse_fence(line: &str) -> Option<(char, String)> {
    for marker in ["```", "~~~"] {
        if let Some(rest) = line.strip_prefix(marker) {
            let ch = marker.chars().next().unwrap_or('`');
            let lang = rest
                .trim()
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_lowercase();
            return Some((ch, lang));
        }
    }
    None
}

fn is_fence_close(line: &str, ch: char) -> bool {
    line.len() >= 3 && line.chars().all(|c| c == ch || c.is_whitespace())
        && line.chars().filter(|c| *c == ch).count() >= 3
}

fn is_shell_lang(lang: &str) -> bool {
    matches!(
        lang,
        "sh" | "bash"
            | "shell"
            | "zsh"
            | "console"
            | "shell-session"
            | "terminal"
            | "command"
            | "cmd"
            | "powershell"
            | "pwsh"
    )
}

/// 规整模型给出的命令文本。
///
/// 模型偶尔会写成 `$ df -h`、`` `df -h` ``，或者把 XML 里的 `&` 转义成
/// `&amp;`。这些字节直接写进 shell 会被当成命令名的一部分，结果就是
/// 「命令念出来了但没有执行（或执行了错误的东西）」。
fn normalize_model_command(raw: &str) -> String {
    let mut s = raw.trim().to_string();
    s = s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    // 只去掉行首的提示符，不动命令中间的 $
    if let Some(rest) = s.strip_prefix("$ ") {
        s = rest.to_string();
    } else if let Some(rest) = s.strip_prefix("# ") {
        s = rest.to_string();
    }
    s = s.trim().to_string();
    // 整个命令被一对反引号包住时去掉它们；不能 trim_matches('`')，
    // 否则 `echo \`date\`` 这类合法的命令替换会被破坏。
    if s.len() >= 2 && s.starts_with('`') && s.ends_with('`') {
        let inner = &s[1..s.len() - 1];
        if !inner.contains('`') {
            s = inner.trim().to_string();
        }
    }
    s.trim_end_matches('\r').trim().to_string()
}

/// 一个代码块里可能有多行命令：按行拆开，跳过空行与纯注释。
fn split_commands(block: &str) -> Vec<String> {
    block
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        // 去掉提示符 / 反引号前缀（模型有时会把它们一起写进来）
        .map(normalize_model_command)
        .filter(|l| !l.is_empty())
        .collect()
}

/// 判断一条命令的危险程度，以及是否需要人工确认。
///
/// 1.2.3 起的产品规则：**只有「删除文件/目录」「改写或覆盖文件」以及
/// 关机/格式化/写块设备这类不可逆操作**需要用户点确认；其余命令
/// （查询、装包、启停服务、docker、网络变更…）一律自动执行，不再逐步打断。
fn classify(cmd: &str) -> ExtractedCommand {
    let (danger, danger_reason) = detect_danger(cmd);
    let approval = approval_reason(cmd);
    let needs_approval = danger || approval.is_some();
    let reason = if danger {
        danger_reason
    } else {
        approval.unwrap_or_default()
    };

    ExtractedCommand {
        command: cmd.to_string(),
        purpose: String::new(),
        danger,
        reason,
        needs_approval,
    }
}

/// 是否属于「不可逆 / 影响整机」的高危命令（卡片标红 + 二次确认）。
///
/// 旧实现是一张子串表，误报很多：`rm -rf /tmp/x` 会被当成「删除根目录」，
/// `grep reboot /var/log/syslog` 会被当成「要重启主机」。现在改成逐段看
/// 真正执行的命令与参数，只拦真正的灾难写法。
fn detect_danger(cmd: &str) -> (bool, String) {
    let lower = cmd.to_ascii_lowercase();

    // 这几类没法靠「命令名」判断，保留子串匹配
    const PATTERNS: &[(&str, &str)] = &[
        ("mkfs", "会格式化文件系统"),
        ("dd if=", "裸写块设备可能损坏数据"),
        ("> /dev/sd", "直接写块设备可能损坏数据"),
        (":(){", "fork 炸弹"),
    ];
    for (pat, why) in PATTERNS {
        if lower.contains(pat) {
            return (true, (*why).to_string());
        }
    }

    for seg in split_command_segments(cmd) {
        let tokens = strip_wrappers(&seg);
        let Some(name) = tokens.first().map(|s| s.as_str()) else {
            continue;
        };
        let args: Vec<&str> = tokens.iter().skip(1).map(|s| s.as_str()).collect();
        let has_root = args.iter().any(|a| matches!(*a, "/" | "/*" | "/."));
        match name {
            "reboot" | "shutdown" | "halt" | "poweroff" => {
                return (true, "会关闭或重启主机".to_string());
            }
            "init" if args.first() == Some(&"0") => {
                return (true, "会关闭主机".to_string());
            }
            "rm" if has_root => return (true, "会删除根目录".to_string()),
            "mv" if args.iter().any(|a| *a == "/*") => {
                return (true, "会移动根目录内容".to_string());
            }
            "chmod" | "chown" => {
                let recursive = args.iter().any(|a| {
                    let l = a.to_ascii_lowercase();
                    l == "-r" || l == "--recursive"
                });
                if recursive && has_root {
                    return (
                        true,
                        format!("会递归改动根目录{}", if name == "chmod" { "权限" } else { "属主" }),
                    );
                }
            }
            "kill" => {
                let force = args
                    .iter()
                    .any(|a| matches!(*a, "-9" | "-KILL" | "-kill" | "-s"));
                if force && args.iter().any(|a| *a == "1") {
                    return (true, "会杀死 init 进程".to_string());
                }
            }
            _ => {}
        }
    }
    (false, String::new())
}

/// 需要人工确认才执行的原因；`None` 表示可以直接自动执行。
///
/// 只认两类：**删除**、**改写/覆盖文件**（外加格式化/写块设备/关机）。
fn approval_reason(cmd: &str) -> Option<String> {
    // 1) 重定向写文件。`2>/dev/null`、`>/dev/null`、`&>/dev/null`、`2>&1`
    //    这类不影响任何文件的写法先剔除，剩下的 `>` 一律按写文件处理。
    let mut probe = cmd.to_ascii_lowercase();
    // 统一重定向两侧的空格（`> /dev/null` 与 `>/dev/null` 等价），再剔除安全写法
    probe = probe.replace("> ", ">").replace(" >", ">");
    for safe in [
        "2>/dev/null",
        "1>/dev/null",
        ">/dev/null",
        "&>/dev/null",
        "2>&1",
        "1>&2",
        "&>/dev/null",
    ] {
        probe = probe.replace(safe, " ");
    }
    if probe.contains('>') {
        return Some("会写入或覆盖文件".to_string());
    }

    // 2) 按 ; | && || 换行 拆段，逐段看真正执行的命令
    for seg in split_command_segments(cmd) {
        if let Some(reason) = segment_approval(&seg) {
            return Some(reason);
        }
    }

    // 3) 兜底：命令替换里藏了删除命令（`$(rm -rf x)`、反引号）
    let lower = format!(" {} ", cmd.to_ascii_lowercase().replace('\t', " "));
    for pat in ["$(rm ", "`rm ", "$(rmdir ", "$(shred ", "$(unlink "] {
        if lower.contains(pat) {
            return Some("会删除文件/数据".to_string());
        }
    }
    None
}

/// 按 shell 分隔符拆段（够用即可：不处理引号内的分隔符）。
fn split_command_segments(cmd: &str) -> Vec<String> {
    cmd.split(|c| c == ';' || c == '\n' || c == '|' || c == '&')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// 单段命令是否需要确认。
fn segment_approval(seg: &str) -> Option<String> {
    let tokens = strip_wrappers(seg);
    let Some(cmd) = tokens.first().map(|s| s.as_str()) else {
        return None;
    };
    let args: Vec<&str> = tokens.iter().skip(1).map(|s| s.as_str()).collect();
    let sub = args.first().copied().unwrap_or("");

    // 删除类
    if matches!(cmd, "rm" | "rmdir" | "unlink" | "shred" | "wipefs" | "mkswap") {
        return Some("会删除文件/数据".to_string());
    }
    if cmd == "truncate" {
        return Some("会清空/截断文件".to_string());
    }
    if cmd == "find"
        && args
            .iter()
            .any(|a| matches!(*a, "-delete" | "-exec" | "-execdir" | "-ok" | "-okdir"))
    {
        return Some("会删除或改写文件".to_string());
    }
    if cmd == "docker" || cmd == "podman" {
        if matches!(sub, "rm" | "rmi" | "prune")
            || (sub == "system" && args.get(1) == Some(&"prune"))
        {
            return Some("会删除容器/镜像/缓存".to_string());
        }
        // `docker compose down -v` 会连数据卷一起删
        if sub == "compose"
            && args.iter().any(|a| *a == "down")
            && args.iter().any(|a| *a == "-v" || *a == "--volumes")
        {
            return Some("会删除 compose 的数据卷".to_string());
        }
        return None;
    }
    if cmd == "kubectl" && sub == "delete" {
        return Some("会删除集群资源".to_string());
    }
    if matches!(cmd, "apt" | "apt-get") && matches!(sub, "remove" | "purge" | "autoremove") {
        return Some("会卸载/删除软件包".to_string());
    }
    if cmd == "dpkg" && args.iter().any(|a| matches!(*a, "-r" | "--remove" | "-P" | "--purge")) {
        return Some("会卸载/删除软件包".to_string());
    }
    if cmd == "snap" && sub == "remove" {
        return Some("会卸载软件包".to_string());
    }
    if matches!(cmd, "userdel" | "groupdel") {
        return Some("会删除用户/用户组".to_string());
    }
    if cmd == "crontab" && args.iter().any(|a| *a == "-r") {
        return Some("会删除计划任务".to_string());
    }
    if cmd == "git" {
        // 这些子命令会删文件或直接覆盖工作区内容
        let sub2 = args.get(1).copied().unwrap_or("");
        let hard_reset = sub == "reset" && args.iter().any(|a| *a == "--hard");
        // `git checkout -- .` / `git checkout .` 会用索引覆盖工作区
        let checkout_paths = sub == "checkout" && args.iter().skip(1).any(|a| *a == "." || *a == "--");
        if matches!(sub, "rm" | "clean" | "restore") || hard_reset || checkout_paths {
            return Some("会删除或覆盖工作区文件".to_string());
        }
        let _ = sub2;
    }
    if cmd == "eval" {
        return approval_reason(&args.join(" "));
    }

    // 改写 / 覆盖文件类
    if matches!(cmd, "cp" | "mv" | "install" | "rsync" | "patch") {
        return Some("会覆盖/改写文件".to_string());
    }
    if cmd == "tee" {
        return Some("会写入文件".to_string());
    }
    if cmd == "curl" || cmd == "wget" {
        // 下载到文件会覆盖同名文件（读接口不受影响）
        if args.iter().any(|a| {
            matches!(
                *a,
                "-o" | "-O" | "--output" | "--output-document" | "-P" | "--directory-prefix"
            ) || a.starts_with("--output=")
        }) {
            return Some("会写入/覆盖文件".to_string());
        }
    }
    if cmd == "dd" {
        return Some("会写入块设备/文件".to_string());
    }
    if cmd.starts_with("mkfs") {
        return Some("会格式化文件系统".to_string());
    }
    if cmd == "ln" && args.iter().any(|a| matches!(*a, "-f" | "--force")) {
        return Some("会覆盖已有文件/链接".to_string());
    }
    if cmd == "sed"
        && args
            .iter()
            .any(|a| a.starts_with("-i") || a.starts_with("--in-place"))
    {
        return Some("会原地改写文件".to_string());
    }
    if cmd == "perl" && args.iter().any(|a| a.starts_with("-i") || a.starts_with("-pi")) {
        return Some("会原地改写文件".to_string());
    }
    if cmd == "awk" && args.iter().any(|a| *a == "inplace" || a.starts_with("-i")) {
        return Some("会原地改写文件".to_string());
    }

    // `sh -c "…"` / `bash -lc "…"`：把脚本内容再判一遍
    if matches!(cmd, "sh" | "bash" | "zsh" | "dash" | "busybox") {
        for (i, a) in args.iter().enumerate() {
            // -c / -lc / -ic 这类组合短选项都算
            if a.starts_with('-') && !a.starts_with("--") && a.contains('c') {
                if let Some(script) = args.get(i + 1) {
                    return approval_reason(script);
                }
            }
        }
    }
    None
}

/// 剥掉 sudo / timeout / env / xargs 之类包装，返回真正的「命令 + 参数」。
fn strip_wrappers(seg: &str) -> Vec<String> {
    let mut tokens: Vec<String> = seg
        .split_whitespace()
        .map(|t| t.trim_matches(|c| c == '"' || c == '\'').to_string())
        .filter(|t| !t.is_empty())
        .collect();

    loop {
        let Some(head) = tokens.first().map(|s| s.as_str()) else {
            return tokens;
        };
        match head {
            "sudo" | "doas" | "command" | "builtin" | "time" | "nohup" | "stdbuf"
            | "unbuffer" | "busybox" => {
                tokens.remove(0);
                // `sudo -u root rm …`：选项可能带一个值，要一起跳过
                while skip_option(&mut tokens) {}
            }
            // shell 语法关键字：`then rm x` / `do rm x` / `{ rm x; }` 里的命令
            "then" | "do" | "else" | "elif" | "if" | "while" | "until" | "exec" | "{" => {
                tokens.remove(0);
            }
            "env" => {
                tokens.remove(0);
                while tokens
                    .first()
                    .map_or(false, |t| t.contains('=') || t.starts_with('-'))
                {
                    if tokens[0].starts_with('-') {
                        if !skip_option(&mut tokens) {
                            break;
                        }
                    } else {
                        tokens.remove(0);
                    }
                }
            }
            "nice" | "ionice" | "watch" => {
                tokens.remove(0);
                while skip_option(&mut tokens)
                    || tokens
                        .first()
                        .map_or(false, |t| t.chars().all(|c| c.is_ascii_digit()))
                {
                    if tokens
                        .first()
                        .map_or(false, |t| t.chars().all(|c| c.is_ascii_digit()))
                    {
                        tokens.remove(0);
                    }
                }
            }
            "timeout" => {
                tokens.remove(0);
                // `timeout -s KILL 10 cmd`：-s 带值，10 是时长
                while skip_option(&mut tokens) {}
                if !tokens.is_empty() {
                    tokens.remove(0);
                }
            }
            "xargs" => {
                tokens.remove(0);
                while skip_option(&mut tokens) {}
            }
            _ => break,
        }
    }

    // 去掉行首的 VAR=value 赋值
    while tokens.first().map_or(false, |t| {
        t.contains('=') && !t.starts_with('-') && t.split('=').next().map_or(false, |n| !n.is_empty())
    }) {
        tokens.remove(0);
    }
    tokens
}

/// 跳过命令行开头的一个选项；如果这个选项要带值（`-u root`、`-s KILL`），
/// 连同它的值一起跳过。返回是否跳过了一个选项。
fn skip_option(tokens: &mut Vec<String>) -> bool {
    let Some(tok) = tokens.first().cloned() else {
        return false;
    };
    if !tok.starts_with('-') {
        return false;
    }
    // 带取值的短选项 / 长选项（只列常见的，漏了也只是少跳一个值，不会误放行）
    const WITH_VALUE: &[&str] = &[
        "-u", "-g", "-p", "-C", "-T", "-r", "-t", "-s", "-n", "-k", "-c", "-o",
        "--user", "--group", "--signal", "--kill-after", "--class", "--classdata",
    ];
    // `--user=root` / `-uroot` 这种值写在同一个 token 里的，不能再吃掉下一个参数，
    // 否则 `sudo --user=root rm …` 会把 `rm` 也当成值吃掉，漏判成「普通命令」。
    let inline_value = tok.contains('=') || (tok.len() > 2 && !tok.starts_with("--"));
    let takes_value = !inline_value && WITH_VALUE.contains(&tok.as_str());
    tokens.remove(0);
    if takes_value && !tokens.is_empty() && !tokens[0].starts_with('-') {
        tokens.remove(0);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_prompt_is_upgraded() {
        let dir = std::env::temp_dir().join(format!("ai-mig-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai.json");
        let old = AiConfig {
            api_key: "sk-keep".to_string(),
            system_prompt: "你是一个嵌在 Linux 终端里的运维助手。回答用中文。".to_string(),
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();

        let store = AiStore::load(Some(path.clone()));
        let cfg = store.get();
        // 提示词升级，但用户配置的密钥原样保留
        assert!(cfg.system_prompt.contains("execute_command"));
        assert_eq!(cfg.api_key, "sk-keep");
        // 升级结果已落盘
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("execute_command"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn current_prompt_is_not_rewritten() {
        let dir = std::env::temp_dir().join(format!("ai-cur-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai.json");
        let cfg = AiConfig::default();
        // 故意写成紧凑 JSON：如果被判定为「旧版」就会重写成 pretty JSON
        std::fs::write(&path, serde_json::to_string(&cfg).unwrap()).unwrap();
        let before = std::fs::read_to_string(&path).unwrap();
        let _store = AiStore::load(Some(path.clone()));
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after, "当前版本提示词不该触发升级重写");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn custom_prompt_is_kept() {
        let dir = std::env::temp_dir().join(format!("ai-keep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ai.json");
        let mine = AiConfig {
            system_prompt: "你是我们公司的专属助手，只回答运维问题。".to_string(),
            ..Default::default()
        };
        std::fs::write(&path, serde_json::to_string(&mine).unwrap()).unwrap();

        let store = AiStore::load(Some(path));
        assert_eq!(store.get().system_prompt, mine.system_prompt);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mask_hides_middle() {
        assert_eq!(mask_key(""), "");
        assert_eq!(mask_key("short"), "*****");
        let m = mask_key("sk-1234567890abcdef");
        assert!(m.starts_with("sk-1"));
        assert!(m.ends_with("cdef"));
        assert!(!m.contains("23456789"));
    }

    #[test]
    fn url_is_normalized() {
        assert_eq!(
            completions_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            completions_url("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            completions_url("https://x/v1/chat/completions"),
            "https://x/v1/chat/completions"
        );
    }

    #[test]
    fn extracts_shell_blocks_only() {
        let reply = "先看看磁盘：\n\n```sh\ndf -h\n```\n\n再试：\n\n```python\nprint(1)\n```\n\n```bash\n# 注释会被丢掉\nls -la /tmp\n```\n";
        let cmds = extract_commands(reply);
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].command, "df -h");
        assert!(!cmds[0].needs_approval);
        assert_eq!(cmds[1].command, "ls -la /tmp");
        assert!(!cmds[1].needs_approval);
    }

    #[test]
    fn extracts_bare_and_text_fences() {
        // 模型只输出裸代码块（没有语言标注）时也必须执行，否则用户看到的是
        // 「命令被念了一遍但没有执行」。
        let reply = "先查内存：\n\n```\nfree -h\n```\n\n然后：\n\n```text\ndf -h\n```\n";
        let cmds = extract_commands(reply);
        assert_eq!(
            cmds.iter().map(|c| c.command.as_str()).collect::<Vec<_>>(),
            vec!["free -h", "df -h"]
        );
        // 纯输出 / 说明文字不能被当成命令
        let output = "```text\nFilesystem      Size  Used Avail Use% Mounted on\n/dev/sda1      100G   40G   60G  40% /\n```\n";
        assert!(extract_commands(output).is_empty());
    }

    #[test]
    fn extracts_tool_tag_variants() {
        // 属性、空格、大小写混写
        let reply = "<EXECUTE_COMMAND language=\"bash\">\n  <COMMAND>free -h</COMMAND>\n  <PURPOSE>查看内存</PURPOSE>\n</EXECUTE_COMMAND>\n";
        let cmds = extract_commands(reply);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].command, "free -h");
        assert_eq!(cmds[0].purpose, "查看内存");

        // 省略 <command> 包装的写法
        let reply = "<execute_command>df -h</execute_command>\n";
        let cmds = extract_commands(reply);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].command, "df -h");

        // 提示符前缀、反引号、XML 实体都要规整掉，否则写进 shell 会执行错误
        let reply = "<execute_command><command>$ `df -h &amp;&amp; echo ok`</command></execute_command>\n";
        let cmds = extract_commands(reply);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].command, "df -h && echo ok");
    }

    #[test]
    fn first_command_start_skips_non_command_code_blocks() {
        // 前面只是输出示例，后面才是真正要执行的命令：扣住的位置必须落在 XML 上
        let text = "参考输出：\n\n```text\nFilesystem  Size  Used\n```\n\n现在执行：\n\n<execute_command>\n<command>df -h</command>\n</execute_command>\n";
        let start = first_command_start(text).expect("应该找到命令");
        assert!(text[start..].starts_with("<execute_command"));
        assert_eq!(&text[..start], "参考输出：\n\n```text\nFilesystem  Size  Used\n```\n\n现在执行：\n\n");

        // 裸代码块里的命令也算
        let text = "先看：\n```\nfree -h\n```\n";
        let start = first_command_start(text).expect("应该找到命令");
        assert!(text[start..].starts_with("```"));

        // 纯说明文字没有命令
        assert!(first_command_start("内存看起来正常，不需要处理。").is_none());
    }

    #[test]
    fn command_extraction_ignores_unclosed_tags() {
        // 流式输出到一半：标签未闭合时不能抽半条命令
        assert!(extract_commands("<execute_command>\n<command>rm -rf /tmp/x").is_empty());
    }

    #[test]
    fn flags_dangerous_commands() {
        let cmds = extract_commands("```sh\nrm -rf / --no-preserve-root\n```\n");
        assert_eq!(cmds.len(), 1);
        assert!(cmds[0].danger);
        assert!(cmds[0].needs_approval);
        assert!(!cmds[0].reason.is_empty());
    }

    #[test]
    fn approval_handles_wrappers_and_vcs() {
        // 包装命令不能成为漏判的通道
        for cmd in [
            "sudo -u root rm -rf /tmp/x",
            "sudo --user=root rm -rf /tmp/x",
            "timeout --signal=KILL 10 rm /tmp/x",
            "sudo timeout -s KILL 10 rm /tmp/x",
            "timeout -s KILL 10 rm /tmp/x",
            "busybox rm /tmp/x",
            "xargs -0 rm -f",
            "xargs -i rm -f",
            "sh -c 'rm -rf /tmp/x'",
            "bash -lc 'rm -rf /tmp/x'",
            "eval \"rm -rf /tmp/x\"",
            "echo $(rm -rf /tmp/x)",
            "exec rm -rf /tmp/x",
            "if [ -f /tmp/x ]; then rm -f /tmp/x; fi",
            "for f in *; do rm -f \"$f\"; done",
            "git rm -f a.txt",
            "git clean -fd",
            "git reset --hard HEAD~1",
            "git restore .",
            "git checkout -- .",
            "curl -o /tmp/x http://127.0.0.1/",
            "docker system prune -af",
            "docker compose down -v",
        ] {
            assert!(classify(cmd).needs_approval, "{cmd} 应该需要确认");
        }
        // 但不该把普通命令误判成「需要确认」
        for cmd in [
            "git status",
            "git checkout main",
            "curl -s http://127.0.0.1:5666/api/healthz",
            "git log --oneline -5",
            "docker ps",
            "systemctl restart nginx",
            "grep reboot /var/log/syslog",
            "echo reboot",
            "cat /proc/sys/kernel/random/boot_id",
        ] {
            assert!(!classify(cmd).needs_approval, "{cmd} 应该自动执行");
        }
    }

    #[test]
    fn danger_only_for_catastrophic_targets() {
        // 删 /tmp 下的东西要确认，但不是「删除根目录」级别
        let c = classify("rm -rf /tmp/nas-webterm-probe");
        assert!(c.needs_approval);
        assert!(!c.danger, "绝对路径下的普通删除不该标红: {}", c.reason);
        // 真正的根目录删除才标红
        for cmd in [
            "rm -rf /",
            "rm -rf /*",
            "chmod -R 777 /",
            "chown -R root:root /",
            "reboot",
            "shutdown -h now",
            "mkfs.ext4 /dev/sdb1",
        ] {
            assert!(classify(cmd).danger, "{cmd} 应该是 danger");
        }
        // 只是文本里出现关键字，不能误判
        assert!(!classify("grep reboot /var/log/syslog").danger);
        assert!(!classify("chmod -R 777 /data/app").danger);
    }

    #[test]
    fn approval_rules_only_delete_and_overwrite() {
        // 除了「删除 / 改写文件」和不可逆整机操作，其余一律自动执行
        for cmd in [
            "df -h",
            "ls -la /tmp",
            "systemctl restart nginx",
            "apt-get install -y nginx",
            "docker ps",
            "docker restart web",
            "curl -s http://127.0.0.1:5666/api",
            "cat a.txt > /dev/null",
            "ps aux | grep nginx",
            "echo ok 2>/dev/null",
            "mkdir -p /tmp/x",
        ] {
            assert!(!classify(cmd).needs_approval, "{cmd} 应该自动执行");
        }
        for cmd in [
            "rm -rf /tmp/x",
            "rmdir /tmp/x",
            "echo hi > /tmp/a",
            "echo hi >> /tmp/a",
            "sed -i 's/a/b/' /etc/hosts",
            "cp a b",
            "mv a b",
            "tee /tmp/a",
            "dd if=/dev/zero of=/tmp/a bs=1M count=1",
            "truncate -s 0 /tmp/a",
            "find /tmp -name '*.log' -delete",
            "docker rm -f web",
            "sh -c 'rm -rf /tmp/x'",
            "reboot",
        ] {
            assert!(classify(cmd).needs_approval, "{cmd} 应该需要确认");
        }
    }

    #[test]
    fn budgets_scale_with_context_window() {
        let big = AiConfig {
            context_window: 1_000_000,
            ..Default::default()
        };
        let small = AiConfig {
            context_window: 32_000,
            ..Default::default()
        };
        assert!(big.context_chars() > small.context_chars() * 5);
        assert!(big.memory_max_chars() > small.memory_max_chars());
        assert!(big.history_turns() > small.history_turns());
        assert!(big.max_steps() > small.max_steps());
    }

    #[test]
    fn trim_messages_respects_budget() {
        let cfg = AiConfig {
            context_window: 8_000,
            ..Default::default()
        };
        let mut msgs = vec![serde_json::json!({"role":"user","content":"x".repeat(20_000)})];
        for _ in 0..10 {
            msgs.push(serde_json::json!({"role":"user","content":"y".repeat(5_000)}));
        }
        trim_messages_to_budget(&cfg, &mut msgs);
        let total: usize = msgs
            .iter()
            .map(|m| m["content"].as_str().unwrap_or("").chars().count())
            .sum();
        assert!(!msgs.is_empty());
        assert!(total <= 8_000 * 3 * 85 / 100, "total={total}");
    }

    #[test]
    fn parses_sse_delta() {
        let d = parse_sse_line(
            r#"data: {"choices":[{"delta":{"content":"你好"}}]}"#,
        )
        .unwrap();
        assert_eq!(d.text, "你好");
        assert!(!d.done);
        let done = parse_sse_line("data: [DONE]").unwrap();
        assert!(done.done);
        assert!(parse_sse_line("event: ping").is_none());
    }

    #[test]
    fn parses_stream_error() {
        let d = parse_sse_line(r#"data: {"error":{"message":"余额不足"}}"#).unwrap();
        assert_eq!(d.error.as_deref(), Some("余额不足"));
    }

    #[test]
    fn empty_key_is_not_a_patch() {
        let store = AiStore::load(None);
        store.update(&serde_json::json!({"apiKey":"sk-real"})).unwrap();
        // 前端回传空串（用户没改）不应清掉 key
        store.update(&serde_json::json!({"apiKey":""})).unwrap();
        assert_eq!(store.get().api_key, "sk-real");
        // 显式传 "-" 才清除
        store.update(&serde_json::json!({"apiKey":"-"})).unwrap();
        assert!(store.get().api_key.is_empty());
    }
}
