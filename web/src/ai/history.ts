/**
 * AI 聊天记录（服务端持久化）的类型与接口。
 *
 * 以前对话只存在浏览器内存里（`AgentRunner.turns`），刷新页面就没了。
 * 现在服务端把每一轮对话存到 `${TRIM_PKGVAR}/ai-history.json`，
 * 前端通过下面这几个接口列出来、打开、删除。
 */

/** 一轮里执行过的一条命令。 */
export interface HistoryCommand {
  command: string;
  purpose: string;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  danger: boolean;
  auto: boolean;
}

/** 一轮对话里按显示顺序排列的块。 */
export type HistoryBlock =
  | { type: 'text'; text: string }
  | { type: 'command'; command: HistoryCommand };

/** 一轮对话：用户问 + 助手答 + 命令。 */
export interface HistoryTurn {
  user: string;
  assistant: string;
  blocks: HistoryBlock[];
  at: number;
}

/** 完整会话。 */
export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: HistoryTurn[];
}

/** 会话列表项（不含正文）。 */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: number;
  preview: string;
}

/** 列表：最近更新的在前。 */
export async function listConversations(
  base: string,
): Promise<ConversationSummary[]> {
  try {
    const res = await fetch(`${base}api/ai/history`, { credentials: 'same-origin' });
    const json = await res.json();
    if (json?.ok && Array.isArray(json.data?.items)) {
      return json.data.items as ConversationSummary[];
    }
  } catch {
    /* 拉不到就当没有记录 */
  }
  return [];
}

/** 取某个会话的完整内容。
 *
 *  返回 `null` 表示服务端明确说「不存在」，`undefined` 表示网络/服务异常
 *  （不确定）——调用方据此决定是清掉本地记录还是下次再试。
 */
export async function getConversation(
  base: string,
  id: string,
): Promise<Conversation | null | undefined> {
  try {
    const res = await fetch(`${base}api/ai/history/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
    });
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const json = await res.json().catch(() => null);
    if (json?.ok && json.data?.id) return json.data as Conversation;
  } catch {
    /* 网络异常：不确定记录是否还在 */
  }
  return undefined;
}

/** 删除一个会话。 */
export async function deleteConversation(base: string, id: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}api/ai/history/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => null);
    return Boolean(json?.ok);
  } catch {
    return false;
  }
}

/** 清空全部聊天记录。 */
export async function clearConversations(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}api/ai/history`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const json = await res.json().catch(() => null);
    return Boolean(json?.ok);
  } catch {
    return false;
  }
}

/** 会话时间的显示文案。 */
export function formatTime(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
