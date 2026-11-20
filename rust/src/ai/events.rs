//! AI 任务的事件总线。
//!
//! 一个 agent 任务会产生一串事件（流式文本、命令卡片、命令输出、完成）。
//! 以前这些事件直接发给一个 mpsc 通道，前端断开就没了：
//!
//! * 手机上切后台、锁屏、地铁里网络抖动 → SSE 断开几秒；
//! * 服务端立刻中止任务，用户回来只看到半截输出，这次的模型调用也白花了；
//! * 客户端重新发消息还会撞上「该会话已有 AI 任务正在运行」。
//!
//! 这里把事件改成「先存下来，再广播」：
//!
//! * [`EventBus::publish`] 把事件追加到环形缓冲，并推给当前所有订阅者；
//! * 客户端断线重连时带上自己的序号，就能**补发漏掉的那几条**，
//!   接着看后面的实时输出，不用重跑任务；
//! * 客户端不在的期间，服务端最多等 [`DISCONNECT_GRACE_SECS`] 秒，
//!   这段时间里任务继续跑完，但**不会执行新命令**（没人看着不该改机器）。
//!
//! 缓冲上限 [`MAX_BUFFERED_BYTES`] / [`MAX_BUFFERED_EVENTS`]：一次任务的
//! 输出通常远小于这个数，超了就把最老的丢掉（宁可少看开头，也不能把内存吃满）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, watch};

/// 缓冲区的字节上限。
///
/// 一条回复可能被模型拆成上千个 `md` 分片，按「条数」限制会太早丢掉开头，
/// 断线重连时就补不全。这里改成按字节算：4MB 足够装下很长的回复，
/// 超出才丢最旧的（宁可少看开头，也不能把内存吃满）。
const MAX_BUFFERED_BYTES: usize = 4 * 1024 * 1024;

/// 缓冲区的条数上限（防止极端情况下海量一字节事件把 Vec 撑爆）。
const MAX_BUFFERED_EVENTS: usize = 20_000;

/// 客户端断开后，服务端最多等它多久（秒）。
///
/// 这段时间里：已经发出的模型输出会存进聊天记录；客户端重新接上就能
/// 接着看。超过这个时间就彻底收尾，不再占用会话名额。
pub const DISCONNECT_GRACE_SECS: u64 = 120;

/// 每个订阅者的通道容量。
const SUB_CHANNEL_CAP: usize = 1024;

/// 事件总线。
pub struct EventBus {
    /// 已产生的事件：(序号, 内容)。序号从 1 开始。
    buffer: Mutex<Vec<(u64, String)>>,
    /// 缓冲里这些事件的总字节数（按字节封顶比按条数封顶更合理）
    buffered_bytes: AtomicU64,
    /// 当前订阅者：(订阅 id, 通道)
    subs: Mutex<Vec<(u64, mpsc::Sender<(u64, String)>)>>,
    /// 订阅者数量（watch：让等待方能被唤醒）
    sub_count: watch::Sender<usize>,
    next_sub_id: AtomicU64,
    next_seq: AtomicU64,
    /// 任务是否已经结束
    done: AtomicBool,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(0usize);
        Self {
            buffer: Mutex::new(Vec::new()),
            buffered_bytes: AtomicU64::new(0),
            subs: Mutex::new(Vec::new()),
            sub_count: tx,
            next_sub_id: AtomicU64::new(0),
            next_seq: AtomicU64::new(0),
            done: AtomicBool::new(false),
        }
    }

    /// 发布一条事件，返回它的序号。
    ///
    /// 事件会被加上 SSE 的 `id:` 字段：客户端据此记住「收到第几条」，
    /// 断线重连时带着这个序号来，服务端把漏掉的补给它。
    pub fn publish(&self, frame: String) -> u64 {
        let seq = self.next_seq.fetch_add(1, Ordering::SeqCst) + 1;
        let frame = with_sse_id(&frame, seq);
        {
            let mut buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
            buf.push((seq, frame.clone()));
            // 封顶：先按字节数丢最旧的，再兜一层条数上限
            let mut bytes = self.buffered_bytes.load(Ordering::Relaxed) + frame.len() as u64;
            let mut drop = 0usize;
            while bytes > MAX_BUFFERED_BYTES as u64 && drop < buf.len() - 1 {
                bytes -= buf[drop].1.len() as u64;
                drop += 1;
            }
            let overflow = buf.len().saturating_sub(MAX_BUFFERED_EVENTS).max(drop);
            if overflow > 0 {
                // 0..drop 的字节数上面已经减过了；这里把 0..overflow 整段
                // 从缓冲里移除，只对 drop..overflow 这段再扣一次字节数。
                for (_, f) in buf.drain(0..overflow).skip(drop) {
                    bytes = bytes.saturating_sub(f.len() as u64);
                }
            }
            self.buffered_bytes.store(bytes, Ordering::Relaxed);
        }
        // 推给所有订阅者。通道满了就把这个订阅者踢掉：它已经跟不上了，
        // 留着只会让它少看内容还不自知——不如断开，让它走重连续传补齐。
        let (count, dropped) = {
            let mut subs = self.subs.lock().unwrap_or_else(|e| e.into_inner());
            let before = subs.len();
            subs.retain(|(_, tx)| {
                // 注意：try_send 有副作用（真的往通道里塞一条），
                // 不能放在会重复执行的判断里——这里 retain 每条只判一次。
                if tx.is_closed() {
                    return false;
                }
                tx.try_send((seq, frame.clone())).is_ok()
            });
            (subs.len(), subs.len() != before)
        };
        if dropped {
            // 订阅数变了要通知等待者，否则 agent 会以为「还有人看」，
            // 一直等下去（宽限期永远不开始）。
            let _ = self.sub_count.send_replace(count);
        }
        seq
    }

    /// 订阅事件流。返回 `(订阅 id, 接收端)`：调用方用 id 取消订阅。
    ///
    /// 任务已经结束时返回一个**已关闭**的通道：调用方的流会立刻收尾，
    /// 而不是挂在那里永远等不到新事件。
    pub fn subscribe(&self) -> (u64, mpsc::Receiver<(u64, String)>) {
        let (tx, rx) = mpsc::channel(SUB_CHANNEL_CAP);
        let id = self.next_sub_id.fetch_add(1, Ordering::SeqCst) + 1;
        if self.done.load(Ordering::SeqCst) {
            drop(tx);
            return (id, rx);
        }
        let count = {
            let mut subs = self.subs.lock().unwrap_or_else(|e| e.into_inner());
            // 拿到锁之后再确认一次：mark_done 先置 done、再清空订阅表，
            // 如果它刚好在两次检查之间完成，这里就能发现，不会留下一个
            // 永远等不到新事件、也不会被关闭的订阅。
            if self.done.load(Ordering::SeqCst) {
                drop(tx);
                return (id, rx);
            }
            subs.retain(|(_, t)| !t.is_closed());
            subs.push((id, tx));
            subs.len()
        };
        let _ = self.sub_count.send_replace(count);
        (id, rx)
    }

    /// 取消订阅。
    pub fn unsubscribe(&self, id: u64) {
        let count = {
            let mut subs = self.subs.lock().unwrap_or_else(|e| e.into_inner());
            subs.retain(|(i, _)| *i != id);
            subs.len()
        };
        let _ = self.sub_count.send_replace(count);
    }

    /// 当前有没有客户端在看。
    pub fn has_subscribers(&self) -> bool {
        let mut subs = self.subs.lock().unwrap_or_else(|e| e.into_inner());
        subs.retain(|(_, t)| !t.is_closed());
        !subs.is_empty()
    }

    /// 补发序号大于 `seq` 的事件（客户端断线期间漏掉的那些）。
    pub fn replay_since(&self, seq: u64) -> Vec<(u64, String)> {
        let buf = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        buf.iter()
            .filter(|(s, _)| *s > seq)
            .cloned()
            .collect()
    }

    /// 等到「一个订阅者都没有」为止。
    ///
    /// 用于「客户端是不是还在」的判断：有人 → 继续；没人 → 进入宽限期。
    pub async fn wait_no_subscribers(&self) {
        let mut rx = self.sub_count.subscribe();
        loop {
            if *rx.borrow_and_update() == 0 {
                return;
            }
            if rx.changed().await.is_err() {
                return;
            }
        }
    }

    /// 任务结束：关闭所有订阅通道，客户端的流自然收尾。
    pub fn mark_done(&self) {
        self.done.store(true, Ordering::SeqCst);
        let count = {
            let mut subs = self.subs.lock().unwrap_or_else(|e| e.into_inner());
            subs.clear();
            subs.len()
        };
        let _ = self.sub_count.send_replace(count);
    }}

/// 客户端掉线后的宽限计时器。
///
/// 记录「从什么时候开始没人看着」，让 agent 知道：
/// 该继续等它回来，还是彻底收尾。
pub struct GraceTimer {
    gone_since: Mutex<Option<Instant>>,
}

impl Default for GraceTimer {
    fn default() -> Self {
        Self::new()
    }
}

impl GraceTimer {
    pub fn new() -> Self {
        Self {
            gone_since: Mutex::new(None),
        }
    }

    /// 客户端还在 → 清掉计时。
    pub fn seen(&self) {
        let mut g = self.gone_since.lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }

    /// 客户端没了 → 开始计时（第一次调用时记录时刻）。
    pub fn gone(&self) {
        let mut g = self.gone_since.lock().unwrap_or_else(|e| e.into_inner());
        if g.is_none() {
            *g = Some(Instant::now());
        }
    }

    /// 客户端离开多久了。
    pub fn gone_for(&self) -> Option<Duration> {
        let g = self.gone_since.lock().unwrap_or_else(|e| e.into_inner());
        g.map(|t| t.elapsed())
    }

    /// 宽限期是否已过。
    pub fn expired(&self) -> bool {
        self.gone_for()
            .map(|d| d.as_secs() >= DISCONNECT_GRACE_SECS)
            .unwrap_or(false)
    }
}

/// 给 SSE 事件加上 `id:` 字段。
///
/// 事件原文是 `data: {...}\n\n`，这里改成：
/// `id: 3\ndata: {...}\n\n`——标准 SSE 的事件 id，前端读它就知道序号。
fn with_sse_id(frame: &str, seq: u64) -> String {
    if let Some(rest) = frame.strip_prefix("data: ") {
        format!("id: {}\ndata: {}", seq, rest)
    } else {
        frame.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn publish_and_replay() {
        let bus = EventBus::new();
        bus.publish("a".to_string());
        bus.publish("b".to_string());
        // 从 0 开始补发：全部
        let texts = |v: Vec<(u64, String)>| v.into_iter().map(|(_, f)| f).collect::<Vec<_>>();
        assert_eq!(texts(bus.replay_since(0)), vec!["a", "b"]);
        // 从 1 开始：只剩第二条
        assert_eq!(texts(bus.replay_since(1)), vec!["b"]);
        // 已经是最新的：没有要补的
        assert!(bus.replay_since(2).is_empty());
    }

    #[test]
    fn subscriber_receives_events() {
        let bus = EventBus::new();
        let (id, mut rx) = bus.subscribe();
        assert!(bus.has_subscribers());
        bus.publish("x".to_string());
        assert_eq!(rx.try_recv().ok(), Some((1, "x".to_string())));
        bus.unsubscribe(id);
        assert!(!bus.has_subscribers());
    }

    #[test]
    fn published_event_carries_sse_id() {
        let bus = EventBus::new();
        bus.publish("data: {\"type\":\"md\"}\n\n".to_string());
        let (seq, frame) = bus.replay_since(0).into_iter().next().unwrap();
        assert_eq!(seq, 1);
        assert!(frame.starts_with("id: 1\n"));
        assert!(frame.contains("data: {"));
    }

    #[test]
    fn subscribe_after_done_closes_immediately() {
        let bus = EventBus::new();
        bus.mark_done();
        let (_id, mut rx) = bus.subscribe();
        // 任务已结束：订阅通道直接关闭，流不会挂住
        assert!(rx.try_recv().is_err());
        assert!(!bus.has_subscribers());
    }

    #[test]
    fn mark_done_closes_subscribers() {
        let bus = EventBus::new();
        let (_id, mut rx) = bus.subscribe();
        bus.mark_done();
        // 订阅通道被清空 → 客户端的流自然结束
        assert!(rx.try_recv().is_err());
        assert!(!bus.has_subscribers());
    }

    #[test]
    fn unsubscriber_is_removed() {
        let bus = EventBus::new();
        let (id, mut rx) = bus.subscribe();
        assert!(bus.has_subscribers());
        bus.unsubscribe(id);
        assert!(!bus.has_subscribers());
        // 订阅被撤销后，事件不再推给它
        bus.publish("x".to_string());
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn wait_no_subscribers_returns_when_all_leave() {
        let bus = std::sync::Arc::new(EventBus::new());
        let (id, _rx) = bus.subscribe();
        let b = bus.clone();
        let h = tokio::spawn(async move {
            b.wait_no_subscribers().await;
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        bus.unsubscribe(id);
        tokio::time::timeout(Duration::from_secs(2), h)
            .await
            .expect("应该返回")
            .unwrap();
    }

    #[test]
    fn buffer_keeps_recent_events_under_byte_cap() {
        let bus = EventBus::new();
        // 每条 64KB，发 100 条 = 6.4MB，超过 4MB 上限：最老的应被丢掉，
        // 最新的必须还在（断线重连补发靠的是最近的输出）。
        let payload = "x".repeat(64 * 1024);
        for _ in 0..100 {
            bus.publish(format!("data: {{\"t\":\"{}\"}}\n\n", payload));
        }
        let buf = bus.replay_since(0);
        assert!(buf.len() < 100, "应该丢掉最老的: {}", buf.len());
        // 最后一条一定在
        assert_eq!(buf.last().unwrap().0, 100);
        // 序号仍然连续可用（客户端带最新序号接回时不会漏）
        assert!(bus.replay_since(buf.last().unwrap().0).is_empty());
    }

    #[test]
    fn grace_timer_tracks_gone_duration() {
        let t = GraceTimer::new();
        assert!(!t.expired());
        t.gone();
        assert!(!t.expired());
        t.seen();
        assert!(!t.expired());
        assert!(t.gone_for().is_none());
    }

    #[test]
    fn subscriber_that_falls_behind_is_dropped() {
        // 客户端跟不上（通道塞满）时应该被踢掉，而不是悄悄少看内容：
        // 它走重连续传还能补回来。这里用很小的容量验证行为。
        let bus = EventBus::new();
        let (id, _rx) = bus.subscribe();
        // 填满通道（容量 1024）+ 再多发一条
        for _ in 0..SUB_CHANNEL_CAP + 10 {
            bus.publish("x".to_string());
        }
        // 没有读的一方已被移除
        assert!(!bus.has_subscribers());
        // 再取消也不会出问题
        bus.unsubscribe(id);
    }

}
