//! AI 聊天记录（会话历史）的持久化。
//!
//! 以前对话历史只活在浏览器内存里（`web/src/ai/agent.ts` 的 `turns` 数组）：
//! 刷新页面、换个浏览器、关掉标签页就没了；服务端只存了「长期记忆」
//! （机器配置、用户偏好这类事实），那不是聊天记录。
//!
//! 这里把每一轮对话落盘到 `${TRIM_PKGVAR}/ai-history.json`（和 `ai.json`、
//! `ai-memory.md` 放在一起），于是：
//!
//! * 刷新页面后对话还在，模型也能接着上次的上下文继续聊；
//! * 换一台设备打开同一个应用，看到的是同一份记录；
//! * 可以在「聊天记录」里翻出以前的对话、继续聊或者删掉。
//!
//! 写盘规则与长期记忆一致：先写 `.tmp` 再 rename（原子替换），权限 0600。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::ChatMessage;

/// 最多保留多少个会话（超了从最旧的开始丢）。
const MAX_CONVERSATIONS: usize = 50;
/// 单个会话最多保留多少轮（一问一答算一轮）。
const MAX_TURNS: usize = 200;
/// 历史文件最大字节数，超了继续丢最旧的会话。
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
/// 标题最多多少字符。
const MAX_TITLE_CHARS: usize = 28;
/// 预览最多多少字符。
const MAX_PREVIEW_CHARS: usize = 60;

/// 一轮对话里执行过的一条命令。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryCommand {
    pub command: String,
    #[serde(default)]
    pub purpose: String,
    #[serde(default)]
    pub output: String,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub danger: bool,
    #[serde(default)]
    pub auto: bool,
}

/// 一轮对话在界面上的回放块。
///
/// 顺序和用户当时看到的完全一致：文字、命令卡片、文字、命令卡片……
/// 这样从历史里打开一个会话时，界面和当时一模一样。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HistoryBlock {
    /// 模型输出的一段文字。
    Text { text: String },
    /// 一次命令执行。
    Command { command: HistoryCommand },
}

/// 一轮对话：用户问了一句，AI 答了一段，中间跑了哪些命令。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryTurn {
    /// 用户的原始输入。
    pub user: String,
    /// 助手这一轮的完整回复原文（含协议标签，用于模型上下文）。
    #[serde(default)]
    pub assistant: String,
    /// 界面回放用的块。
    #[serde(default)]
    pub blocks: Vec<HistoryBlock>,
    /// 发生时间（unix 毫秒）。
    #[serde(default)]
    pub at: u64,
}

/// 一个会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub title: String,
    /// 创建时间（unix 毫秒）。
    #[serde(default)]
    pub created_at: u64,
    /// 最后更新时间（unix 毫秒）。
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub turns: Vec<HistoryTurn>,
}

/// 会话列表里的一项（不含正文，列表页用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub id: String,
    pub title: String,
    /// 创建时间（unix 毫秒）。
    pub created_at: u64,
    /// 最后更新时间（unix 毫秒）。
    pub updated_at: u64,
    /// 轮数。
    pub turns: usize,
    /// 最后一句摘要。
    pub preview: String,
}

/// 聊天记录存储。
pub struct ChatHistory {
    /// 空路径 = 只在内存里保存（没配 --ai-config 的开发模式）。
    path: PathBuf,
    cache: Mutex<Vec<Conversation>>,
}

impl ChatHistory {
    /// 载入历史文件。文件损坏时只告警、不让整个 AI 起不来。
    pub fn load(path: Option<PathBuf>) -> Self {
        let path = path.unwrap_or_default();
        let mut conversations = Vec::new();
        if !path.as_os_str().is_empty() {
            match std::fs::read_to_string(&path) {
                Ok(raw) => match serde_json::from_str::<Vec<Conversation>>(&raw) {
                    Ok(list) => conversations = list,
                    Err(e) => crate::log_warn!("AI 聊天记录解析失败，已忽略旧记录: {}", e),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => crate::log_warn!("AI 聊天记录读取失败: {}", e),
            }
        }
        // 1.2.5 之前的服务端没有过滤协议标签，历史里可能留着
        // `<execute` 这种半截标签碎片（界面上的 ToolFilter 挡住了，
        // 但存盘的是原文）。载入时清一遍，脏数据不会一直留着。
        //
        // 注意：要清理两种形态——
        //   * 整段回复（assistant / 文本块）里的标签；
        //   * 模型上下文里那条「已执行命令」说明也是自己拼的，不含标签。
        // 只要清洗结果变了就记一次，用来决定是否写回磁盘。
        let mut cleaned = 0usize;
        for c in conversations.iter_mut() {
            for t in c.turns.iter_mut() {
                let before: usize = t.assistant.len()
                    + t.blocks
                        .iter()
                        .map(|b| match b {
                            HistoryBlock::Text { text } => text.len(),
                            HistoryBlock::Command { .. } => 0,
                        })
                        .sum::<usize>();
                t.assistant = crate::ai::protocol::strip_protocol_tags(&t.assistant);
                for b in t.blocks.iter_mut() {
                    if let HistoryBlock::Text { text } = b {
                        *text = crate::ai::protocol::strip_protocol_tags(text);
                    }
                }
                let after: usize = t.assistant.len()
                    + t.blocks
                        .iter()
                        .map(|b| match b {
                            HistoryBlock::Text { text } => text.len(),
                            HistoryBlock::Command { .. } => 0,
                        })
                        .sum::<usize>();
                if after != before {
                    cleaned += 1;
                }
            }
        }
        let store = Self {
            path,
            cache: Mutex::new(conversations),
        };
        if cleaned > 0 {
            crate::log_info!("已清理 {} 条聊天记录里的协议标签碎片", cleaned);
            // 顺手写回磁盘：否则每次启动都要重新清理一遍，
            // 而且旧文件里的脏数据会一直留着（导出 / 手工查看时会看到）。
            let guard = store.cache.lock().unwrap_or_else(|e| e.into_inner());
            store.save(&guard);
        }
        store
    }

    /// 会话列表，按最近更新排序。
    ///
    /// 内部用 `Vec` 的顺序表示更新时间顺序（越靠后越新），所以即使两条
    /// 会话在同一毫秒内被更新过，先后顺序也不会乱。
    pub fn list(&self) -> Vec<ConversationSummary> {
        let guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        guard
            .iter()
            .rev()
            .map(|c| ConversationSummary {
                id: c.id.clone(),
                title: c.title.clone(),
                created_at: c.created_at,
                updated_at: c.updated_at,
                turns: c.turns.len(),
                preview: preview_of(c),
            })
            .collect()
    }

    /// 取一个会话的完整内容。
    pub fn get(&self, id: &str) -> Option<Conversation> {
        let guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        guard.iter().find(|c| c.id == id).cloned()
    }

    /// 删除一个会话。
    pub fn delete(&self, id: &str) -> bool {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let before = guard.len();
        guard.retain(|c| c.id != id);
        if guard.len() == before {
            return false;
        }
        self.save(&guard);
        true
    }

    /// 清空全部会话。
    pub fn clear(&self) {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();
        self.save(&guard);
    }

    /// 追加一轮对话。`id` 不存在时就用这个 id 新建会话。
    pub fn append_turn(&self, id: &str, turn: HistoryTurn) {
        let mut guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let now = now_millis();
        // 先把这个会话从原位摘掉，再追加到末尾 —— Vec 的顺序即「最近更新」顺序。
        let mut pos = guard.iter().position(|c| c.id == id);
        match pos.take() {
            Some(i) => {
                let mut c = guard.remove(i);
                if c.title.is_empty() {
                    c.title = title_of(&turn.user);
                }
                c.updated_at = now;
                c.turns.push(turn);
                while c.turns.len() > MAX_TURNS {
                    c.turns.remove(0);
                }
                guard.push(c);
            }
            None => {
                guard.push(Conversation {
                    id: id.to_string(),
                    title: title_of(&turn.user),
                    created_at: now,
                    updated_at: now,
                    turns: vec![turn],
                });
            }
        }
        // 只保留最近的会话（最旧的在最前面）
        while guard.len() > MAX_CONVERSATIONS {
            guard.remove(0);
        }
        self.save(&guard);
    }

    /// 取某个会话的历史，转成模型能直接用的消息列表。
    ///
    /// `max_turns` 是「保留多少轮」，与服务端设置里的「对话历史轮数」一致。
    pub fn model_context(&self, id: &str, max_turns: usize) -> Vec<ChatMessage> {
        let guard = self.cache.lock().unwrap_or_else(|e| e.into_inner());
        let Some(c) = guard.iter().find(|c| c.id == id) else {
            return Vec::new();
        };
        let start = c.turns.len().saturating_sub(max_turns);
        let mut out = Vec::new();
        for t in &c.turns[start..] {
            if !t.user.trim().is_empty() {
                out.push(ChatMessage {
                    role: "user".to_string(),
                    content: t.user.clone(),
                });
            }
            if !t.assistant.trim().is_empty() {
                out.push(ChatMessage {
                    role: "assistant".to_string(),
                    content: t.assistant.clone(),
                });
            }
        }
        out
    }

    /// 原子写盘。调用方必须已经拿到锁。
    fn save(&self, conversations: &[Conversation]) {
        if self.path.as_os_str().is_empty() {
            return;
        }
        if let Some(dir) = self.path.parent() {
            if !dir.as_os_str().is_empty() {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    crate::log_warn!("创建聊天记录目录失败: {}", e);
                    return;
                }
            }
        }
        let mut list: Vec<Conversation> = conversations.to_vec();
        let mut raw = match serde_json::to_string_pretty(&list) {
            Ok(r) => r,
            Err(e) => {
                crate::log_warn!("序列化聊天记录失败: {}", e);
                return;
            }
        };
        // 文件太大就丢最旧的会话
        while raw.len() > MAX_FILE_BYTES && list.len() > 1 {
            list.remove(0);
            raw = match serde_json::to_string_pretty(&list) {
                Ok(r) => r,
                Err(_) => return,
            };
        }
        let tmp = self.path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, raw.as_bytes()) {
            crate::log_warn!("写入聊天记录失败: {}", e);
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        if let Err(e) = std::fs::rename(&tmp, &self.path) {
            crate::log_warn!("保存聊天记录失败: {}", e);
        }
    }
}

/// 聊天记录文件路径（跟 ai.json 同目录）。
pub fn history_path_for(config_path: &Path) -> PathBuf {
    config_path.with_file_name("ai-history.json")
}

/// 生成一个新的会话 id。
pub fn new_conversation_id() -> String {
    format!("conv-{}", random_hex(12))
}

fn random_hex(len: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; len];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 当前时间（unix 毫秒）。
///
/// 用毫秒而不是秒：同一秒内连续问两句话时，列表排序必须能区分先后，
/// 否则「最近更新」会随机跳。
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 用第一句用户输入当会话标题。
fn title_of(user: &str) -> String {
    let first = user.lines().next().unwrap_or("").trim();
    let mut chars: Vec<char> = first.chars().collect();
    if chars.len() > MAX_TITLE_CHARS {
        chars.truncate(MAX_TITLE_CHARS);
        chars.push('…');
    }
    let title: String = chars.into_iter().collect();
    if title.is_empty() {
        "（空对话）".to_string()
    } else {
        title
    }
}

/// 列表里的摘要：优先用助手最后一段话。
fn preview_of(c: &Conversation) -> String {
    let raw = c
        .turns
        .last()
        .map(|t| {
            if t.assistant.trim().is_empty() {
                t.user.clone()
            } else {
                t.assistant.clone()
            }
        })
        .unwrap_or_default();
    let cleaned = crate::ai::protocol::strip_protocol_tags(&raw);
    let first = cleaned.lines().next().unwrap_or("").trim();
    let mut chars: Vec<char> = first.chars().collect();
    if chars.len() > MAX_PREVIEW_CHARS {
        chars.truncate(MAX_PREVIEW_CHARS);
        chars.push('…');
    }
    chars.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ai-hist-{}-{}", tag, std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("ai-history.json")
    }

    fn turn(user: &str, assistant: &str) -> HistoryTurn {
        HistoryTurn {
            user: user.to_string(),
            assistant: assistant.to_string(),
            blocks: vec![HistoryBlock::Text {
                text: assistant.to_string(),
            }],
            at: now_millis(),
        }
    }

    #[test]
    fn append_and_read_back() {
        let path = tmp_path("append");
        let _ = std::fs::remove_file(&path);
        let store = ChatHistory::load(Some(path.clone()));
        store.append_turn("conv-a", turn("帮我看看磁盘", "根分区还有 58%"));
        store.append_turn("conv-a", turn("那内存呢", "内存 7.4Gi"));
        store.append_turn("conv-b", turn("换个话题", "好的"));

        let list = store.list();
        assert_eq!(list.len(), 2);
        // 最近的会话排前面
        assert_eq!(list[0].id, "conv-b");

        let one = store.get("conv-a").expect("会话应存在");
        assert_eq!(one.turns.len(), 2);
        assert_eq!(one.title, "帮我看看磁盘");

        // 落盘后重新载入，内容还在
        let again = ChatHistory::load(Some(path.clone()));
        let one = again.get("conv-a").expect("重新载入后仍在");
        assert_eq!(one.turns.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn model_context_is_turn_limited() {
        let path = tmp_path("ctx");
        let _ = std::fs::remove_file(&path);
        let store = ChatHistory::load(Some(path.clone()));
        store.append_turn("c", turn("问题1", "回答1"));
        store.append_turn("c", turn("问题2", "回答2"));
        store.append_turn("c", turn("问题3", "回答3"));

        let ctx = store.model_context("c", 2);
        // 只保留最近 2 轮 = 4 条消息
        assert_eq!(ctx.len(), 4);
        assert_eq!(ctx[0].content, "问题2");
        assert_eq!(ctx[1].content, "回答2");
        assert_eq!(ctx[3].content, "回答3");

        // 不存在的会话没有上下文
        assert!(store.model_context("nope", 4).is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn delete_and_clear() {
        let path = tmp_path("del");
        let _ = std::fs::remove_file(&path);
        let store = ChatHistory::load(Some(path.clone()));
        store.append_turn("c1", turn("a", "b"));
        store.append_turn("c2", turn("c", "d"));
        assert!(store.delete("c1"));
        assert!(!store.delete("c1"));
        assert_eq!(store.list().len(), 1);
        store.clear();
        assert!(store.list().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn preview_skips_protocol_tags() {
        let c = Conversation {
            id: "x".to_string(),
            title: "t".to_string(),
            created_at: 0,
            updated_at: 0,
            turns: vec![turn(
                "问题",
                "先看磁盘<execute_command><command>df -h</command></execute_command>",
            )],
        };
        let p = preview_of(&c);
        assert!(!p.contains("execute_command"));
        assert!(p.contains("先看磁盘"));
    }

    #[test]
    fn load_cleans_protocol_tag_fragments() {
        let path = tmp_path("clean");
        let _ = std::fs::remove_file(&path);
        // 模拟旧版本写下的脏数据：助手文本里有半截标签
        let mut t = turn("问题", "<execute\n> 已执行命令：df -h\n结果");
        t.blocks = vec![HistoryBlock::Text {
            text: "<execute".to_string(),
        }];
        let raw = serde_json::to_string_pretty(&vec![Conversation {
            id: "c1".to_string(),
            title: "t".to_string(),
            created_at: 0,
            updated_at: 0,
            turns: vec![t],
        }])
        .unwrap();
        std::fs::write(&path, raw).unwrap();

        let store = ChatHistory::load(Some(path.clone()));
        let one = store.get("c1").expect("会话应存在");
        assert!(!one.turns[0].assistant.contains("<execute"));
        assert!(one.turns[0].assistant.contains("已执行命令"));
        if let HistoryBlock::Text { text } = &one.turns[0].blocks[0] {
            assert!(!text.contains("<execute"));
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn broken_file_does_not_break_startup() {
        let path = tmp_path("broken");
        std::fs::write(&path, b"{ not json").unwrap();
        let store = ChatHistory::load(Some(path.clone()));
        assert!(store.list().is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
