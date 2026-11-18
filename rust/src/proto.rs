//! WebSocket 二进制帧协议。
//!
//! 帧格式：`[1 字节类型][负载]`。输出/输入负载是原始字节（终端转义序列不做任何转义），
//! 控制类负载是 UTF-8 JSON。这样高频重绘的 TUI 程序不会有 base64/JSON 的额外开销。

/// 客户端 → 服务端：终端输入（键盘、粘贴）
pub const C_INPUT: u8 = 0x01;
/// 客户端 → 服务端：窗口尺寸变化，JSON `{"cols":N,"rows":M}`
pub const C_RESIZE: u8 = 0x02;
/// 客户端 → 服务端：发送信号，JSON `{"signal":"INT"}`
pub const C_SIGNAL: u8 = 0x03;
/// 客户端 → 服务端：终端对 OSC/DA 查询的自动应答。
///
/// 必须和普通键盘输入区分开：服务端会核对这是否来自仍在读取输入的
/// 发起进程；核对不通过就丢弃，绝不能写进 Shell 的 stdin。
pub const C_TERM_RESPONSE: u8 = 0x05;

/// 服务端 → 客户端：终端输出
pub const S_OUTPUT: u8 = 0x01;
/// 服务端 → 客户端：会话结束，JSON `{"code":N,"signal":N|null}`
pub const S_EXIT: u8 = 0x02;
/// 服务端 → 客户端：会话就绪，JSON `{"sid":"...","cols":N,"rows":N,...}`
pub const S_READY: u8 = 0x03;
/// 服务端 → 客户端：错误，JSON `{"code":"...","error":"..."}`
///
/// 会话数达上限时服务端无法在握手阶段返回 HTTP 状态码（浏览器拿不到），
/// 于是用这一帧把原因告诉前端，前端据此停止重连并显示提示。
pub const S_ERROR: u8 = 0x04;

/// 拼装一帧。
pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 1);
    out.push(kind);
    out.extend_from_slice(payload);
    out
}

/// 拆出一帧，返回 (类型, 负载)。
pub fn split(raw: &[u8]) -> Option<(u8, &[u8])> {
    raw.split_first().map(|(k, rest)| (*k, rest))
}
