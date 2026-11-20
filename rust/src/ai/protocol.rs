//! 模型输出里的「协议标签」处理。
//!
//! 模型为了驱动 agent，会在回复里夹带这样的标签：
//!
//! ```text
//! <execute_command>
//! <command>df -h</command>
//! </execute_command>
//! ```
//!
//! 这些是给程序看的协议，**不该出现在用户眼前，也不该进聊天记录**。
//!
//! 麻烦在于它们是**分片到达**的：流式输出时一次可能只来 `"<exe"`，
//! 下一片才是 `"cute_command>"`。如果只看「当前这一片」，
//! `<exe` 会被当成普通文字吐出去——前端有专门的过滤器兜底，
//! 但服务端存进聊天记录、喂回模型上下文的是**原始文本**，
//! 于是历史里就多了一段 `<execute` 垃圾（用户会直接看到）。
//!
//! 所以这里做两件事：
//!
//! 1. [`ProtocolFilter`]：增量过滤器。喂进一段原始输出，返回**可以安全显示**
//!    的部分；看起来像标签开头的尾巴会被扣住，等下一片来确认。
//! 2. [`strip_protocol_tags`]：对**完整文本**做一次清理（去掉完整的协议标签、
//!    没闭合的尾巴、以及流式留下的半截标签），用于修复历史数据。

/// 我们认识的协议标签（小写比较）。
pub const PROTOCOL_TAGS: [&str; 5] = [
    "execute_command",
    "tool_use",
    "tool_call",
    "function_call",
    "remember",
];

/// 标签名允许的字符。
fn is_tag_name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// 取 `text` 里 `<` 后面的标签名（不含 `>`）。
fn tag_name_of(text: &str) -> &str {
    let len = text
        .as_bytes()
        .iter()
        .take_while(|b| is_tag_name_char(**b))
        .count();
    &text[..len]
}

/// 名字是否是我们认识的协议标签（或它的前缀）。
///
/// 前缀也算：流式输出时可能只到了 `<execute_comm`，此时还不能断定
/// 它不是标签，得扣住等下一片。
fn is_known_tag(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    PROTOCOL_TAGS
        .iter()
        .any(|t| *t == lower || t.starts_with(&lower))
}

/// 名字是否**正好**是某个协议标签（而不是它的前缀）。
fn is_exact_tag(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    PROTOCOL_TAGS.iter().any(|t| *t == lower)
}

/// 名字匹配到的完整标签（前缀也匹配，按清单顺序取第一个）。
fn matched_tag(name: &str) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    PROTOCOL_TAGS
        .iter()
        .copied()
        .find(|t| *t == lower || t.starts_with(&lower))
}

/// 找闭合标签 `</name` 的位置（不区分大小写）。找不到返回 None。
fn find_close(text: &str, tag: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    let needle = format!("</{}", tag);
    lower.find(&needle)
}

/// `text` 从 `start`（指向 `</name` 的 `<`）开始，是否是一个完整的闭合标签，
/// 返回闭合 `>` 之后的位置。
fn close_tag_end(text: &str, start: usize, tag: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut i = start + 2 + tag.len();
    // `</tag   >` 中间允许空白（含换行：模型偶尔会把标签折行写）
    while i < bytes.len() && bytes[i].is_ascii_whitespace() {
        i += 1;
    }
    if i < bytes.len() && bytes[i] == b'>' {
        Some(i + 1)
    } else {
        None
    }
}

/// 增量过滤模型输出里的协议标签。
///
/// 与前端 `ToolFilter` 保持同样的规则：
///
/// * 普通文字立即返回；
/// * 看起来像协议标签开头（含标签名的前缀，如 `<exe`）就先扣住，
///   等闭合标签出现后整段丢掉；
/// * [`ProtocolFilter::finish`] 收尾：一直没闭合的标签碎片直接丢掉。
///
/// 为什么服务端也要做：前端只挡界面，存进聊天记录的是服务端这份原文。
pub struct ProtocolFilter {
    /// 还没确定的部分（总是从 `<` 开始）
    pending: String,
}

impl Default for ProtocolFilter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProtocolFilter {
    pub fn new() -> Self {
        Self {
            pending: String::new(),
        }
    }

    /// 喂进一段原始输出，返回**可以安全显示**的部分。
    pub fn push(&mut self, delta: &str) -> String {
        if delta.is_empty() {
            return String::new();
        }
        self.pending.push_str(delta);
        let buf = std::mem::take(&mut self.pending);
        let mut out = String::with_capacity(buf.len());
        let mut i = 0usize;
        loop {
            let Some(rel) = buf[i..].find('<') else {
                out.push_str(&buf[i..]);
                break;
            };
            let lt = i + rel;
            out.push_str(&buf[i..lt]);
            let rest = &buf[lt..];
            if rest.len() == 1 {
                // `<` 正好是这一片的结尾：下一片才知道是不是标签，先扣住
                self.pending.push_str(rest);
                return out;
            }
            let after = &rest[1..];
            let name = tag_name_of(after);
            if name.is_empty() {
                // `<` 后面不是标签名（比如 "a < b"），当普通文字输出
                out.push('<');
                i = lt + 1;
                continue;
            }
            let Some(known) = matched_tag(name) else {
                // 不是我们认识的标签，`<` 当普通文字输出
                out.push('<');
                i = lt + 1;
                continue;
            };
            // 是协议标签（或它的前缀）：等闭合标签出现才敢整段丢掉
            let Some(close_rel) = find_close(rest, known) else {
                // 还没闭合：扣住，等下一片
                self.pending.push_str(rest);
                return out;
            };
            // 闭合标签的 `>` 还没到（可能下一片才到）：继续扣住
            let Some(end) = close_tag_end(rest, close_rel, known) else {
                self.pending.push_str(rest);
                return out;
            };
            i = lt + end;
        }
        out
    }

    /// 收尾：一直没闭合的标签碎片丢掉，剩下的普通文字输出。
    pub fn finish(&mut self) -> String {
        let buf = std::mem::take(&mut self.pending);
        // pending 一定从 `<` 开始；后面跟着已知标签名/前缀 → 是没闭合的
        // 协议标签，整段丢掉（和前端的处理一致）。
        if let Some(after) = buf.strip_prefix('<') {
            let name = tag_name_of(after);
            if !name.is_empty() && is_known_tag(name) {
                return String::new();
            }
        }
        buf
    }
}

/// 去掉文本里的协议标签。
///
/// 规则：
///
/// * 完整的 `<tag …>……</tag>` 整段去掉；
/// * 开标签没写完（`<tag …` 一直到文本结尾）丢掉标签本身，后面的正文保留；
/// * 流式留下的半截标签（`<execute` 这种，标签名是已知标签的**前缀**
///   但不是完整的标签）只去掉这一小段，后面的正文保留；
/// * 孤立的闭合标签（`</tag>`）也去掉，避免清理后剩一个尾巴。
pub fn strip_protocol_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let Some(lt) = rest.find('<') else {
            out.push_str(rest);
            break;
        };
        let after = &rest[lt + 1..];
        let closing = after.starts_with('/');
        let name = if closing {
            tag_name_of(&after[1..])
        } else {
            tag_name_of(after)
        };
        let known = is_known_tag(name);
        if !known {
            // 不是协议标签：'<' 就是普通文字，原样保留
            out.push_str(&rest[..lt + 1]);
            rest = after;
            continue;
        }
        // 标签前面那段正文一定要先收进 out，否则会丢字
        out.push_str(&rest[..lt]);

        if closing {
            // 孤立的闭合标签：有 '>' 就整段丢掉，没有就只丢 `</name`
            if is_exact_tag(name) {
                if let Some(end) = close_tag_end(rest, 0, name) {
                    rest = &rest[end..];
                    continue;
                }
            }
            rest = if name.is_empty() { after } else { &after[1 + name.len()..] };
            continue;
        }

        if !is_exact_tag(name) {
            // 半截标签（流式碎片）：只去掉 '<name' 这一小段，正文留着
            rest = &after[name.len()..];
            continue;
        }
        // 完整标签：找开标签的 '>' 与闭合标签
        let Some(gt_rel) = after[name.len()..].find('>') else {
            // 开标签都没写完：只丢掉 `<name`，后面的正文留着
            rest = &after[name.len()..];
            continue;
        };
        let body_start = lt + 1 + name.len() + gt_rel + 1;
        let Some(close_rel) = find_close(&rest[body_start..], name) else {
            // 没有闭合标签：丢掉开标签，正文留着（正文里的孤立闭合标签
            // 会在下一轮被 `closing` 分支清掉）
            rest = &rest[body_start..];
            continue;
        };
        let close_at = body_start + close_rel;
        let Some(end) = close_tag_end(rest, close_at, name) else {
            // 闭合标签都没写完：后面的正文留着
            rest = &rest[body_start..];
            continue;
        };
        rest = &rest[end..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_complete_tags() {
        let text = "前面\n<execute_command>\n<command>df -h</command>\n</execute_command>\n后面";
        let out = strip_protocol_tags(text);
        assert_eq!(out, "前面\n\n后面");
        assert!(!out.contains("execute_command"));
    }

    #[test]
    fn strips_remember_blocks() {
        let text = "结论\n<remember>用户偏好简洁</remember>\n结束";
        let out = strip_protocol_tags(text);
        assert_eq!(out, "结论\n\n结束");
    }

    #[test]
    fn strips_partial_tag_but_keeps_body() {
        // 流式留下的碎片：'<execute' 后面接的是正文（旧历史里的真实形态）
        let text = "<execute\n> 已执行命令：df -h\n结果";
        let out = strip_protocol_tags(text);
        assert_eq!(out, "\n> 已执行命令：df -h\n结果");
        assert!(!out.contains("<execute"));
    }

    #[test]
    fn strips_unclosed_full_name_tag() {
        // 只有开标签名、连 '>' 都没到：不能把 `<execute_command` 留在正文里
        let text = "先看\n<execute_command";
        let out = strip_protocol_tags(text);
        assert_eq!(out, "先看\n");
        assert!(!out.contains("execute_command"));
    }

    #[test]
    fn strips_orphan_closing_tag() {
        // 半截开标签被清掉后，尾巴上的闭合标签不能留下
        let text = "结果\n<execute\n成功\n</execute_command>\n结束";
        let out = strip_protocol_tags(text);
        assert!(!out.contains("execute"));
        assert!(out.contains("成功") && out.contains("结束"));
    }

    #[test]
    fn strips_multiline_closing_tag() {
        // 模型偶尔会把闭合标签折行写
        let text = "<execute_command>\n<command>df -h</command>\n</execute_command\n>\n结果";
        let out = strip_protocol_tags(text);
        assert_eq!(out, "\n结果");
    }

    #[test]
    fn strip_is_idempotent() {
        // 清理两次结果一致：载入历史时反复清理不会越删越多
        let text = "结论 <execute>x</execute> 结束 <remember>y</remember>";
        let once = strip_protocol_tags(text);
        let twice = strip_protocol_tags(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn keeps_normal_angle_brackets() {
        let text = "a < b 和 3<4";
        assert_eq!(strip_protocol_tags(text), text);
    }

    #[test]
    fn filter_drops_complete_block_across_chunks() {
        let mut f = ProtocolFilter::new();
        assert_eq!(f.push("结论："), "结论：");
        assert_eq!(f.push("<exec"), "");
        assert_eq!(f.push("ute_command>\n<command>df -h</command>"), "");
        assert_eq!(f.push("\n</execute_command>\n后续"), "\n后续");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn filter_handles_partial_name_reparse() {
        // 先到的 `<tool_` 既可能是 tool_use 也可能是 tool_call：
        // 下一片补齐后要重新解析，不能按前一片的猜测去等错误的闭合标签。
        let mut f = ProtocolFilter::new();
        assert_eq!(f.push("<tool_"), "");
        assert_eq!(f.push("call>查一下</tool_call>结果"), "结果");
    }

    #[test]
    fn filter_drops_dangling_tag_at_finish() {
        let mut f = ProtocolFilter::new();
        assert_eq!(f.push("结论<rememb"), "结论");
        assert_eq!(f.finish(), "");
    }

    #[test]
    fn filter_keeps_normal_text() {
        let mut f = ProtocolFilter::new();
        assert_eq!(f.push("a < b，3<4"), "a < b，3<4");
        assert_eq!(f.finish(), "");
    }
}
