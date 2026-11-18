/**
 * 模型输出里的"工具标签"过滤器。
 *
 * 模型为了驱动 agent，会在回复里夹带这样的标签：
 *
 *     <execute_command>
 *     <command>df -h</command>
 *     <requires_approval>false</requires_approval>
 *     </execute_command>
 *
 * 这些是给程序看的协议，不该出现在用户的终端里。但也不能简单地用正则
 * 一把梭——流式输出时标签是**分片**到达的：
 *
 *     "<exe"  "<exec"  "<execute_co"  ...  "<execute_command>" ...
 *
 * 一旦正则没匹配上就把它当普通文字吐出去，终端里就会出现半截标签
 * （`<execute_co` 这种），而且这段"垃圾"会占掉后续文本的偏移量，
 * 导致真正的结论开头被吃掉。
 *
 * 所以这里用**增量**的方式处理：识别到可能是标签开头就**扣住**不输出，
 * 等标签闭合（或确定不是标签）再决定放不放。
 */

/** 我们认识的协议标签（小写比较）。 */
const KNOWN_TAGS = ['execute_command', 'tool_use', 'tool_call', 'function_call', 'remember'];

/** 匹配 `<name` 的开头 */
const TAG_OPEN_RE = /^<([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * 收尾用：从**完整文本**里删掉所有协议标签（含 `<remember>`）。
 *
 * 面板每次重渲染都会走一遍这里，作为流式过滤之外的第二道保险：
 * 无论流怎么分片，最终显示的内容里都不会残留 `<execute_command>`。
 */
export function stripProtocolTags(text: string): string {
  let out = text;
  for (const tag of KNOWN_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi');
    out = out.replace(re, '');
  }
  // 流还没给完、标签没闭合：把结尾的半截标签也切掉
  const dangling = out.search(new RegExp(`<(${KNOWN_TAGS.join('|')})\\b`, 'i'));
  if (dangling >= 0) out = out.slice(0, dangling);
  return out;
}

export class ToolFilter {
  /** 还没输出的原始文本 */
  private pending = '';

  /**
   * 喂进一段模型输出，返回**可以安全显示**的文本。
   * 未闭合的标签会被扣住，下次调用时再决定。
   */
  push(delta: string): string {
    if (!delta) return '';
    this.pending += delta;
    let buf = this.pending;
    let out = '';
    let i = 0;

    for (;;) {
      const lt = buf.indexOf('<', i);
      if (lt < 0) {
        out += buf.slice(i);
        buf = '';
        i = 0;
        break;
      }
      out += buf.slice(i, lt);
      const rest = buf.slice(lt);
      const m = TAG_OPEN_RE.exec(rest);
      if (!m) {
        // `<` 正好是这一片的结尾：标签名还没到，**不能**先把 `<` 吐出去。
        // 吐了之后下一片的 `execute_command>` 就是普通文字，整段标签会漏到屏幕上。
        if (rest === '<') {
          buf = rest;
          break;
        }
        // `<` 后面不是标签名（可能是 "a < b"），当普通文字输出
        out += '<';
        i = lt + 1;
        continue;
      }
      const name = m[1].toLowerCase();
      const known = KNOWN_TAGS.find((k) => k === name || k.startsWith(name));
      if (!known) {
        // 不是我们认识的标签，当普通文字输出（只放行 '<'，其余下次再看）
        out += '<';
        i = lt + 1;
        continue;
      }
      // 是协议标签：必须等到闭合标签出现才敢整段丢掉
      const closeRe = new RegExp(`</${known}\\s*>`, 'i');
      const closeIdx = rest.search(closeRe);
      if (closeIdx < 0) {
        // 还没闭合：扣住，等下一片
        buf = rest;
        break;
      }
      const closeMatch = closeRe.exec(rest.slice(closeIdx));
      const end = closeIdx + (closeMatch ? closeMatch[0].length : 0);
      buf = rest.slice(end);
      i = 0;
    }

    this.pending = buf;
    return out;
  }

  /**
   * 收尾：把还没闭合的标签尾巴丢掉，剩下的普通文字输出。
   */
  finish(): string {
    let buf = this.pending;
    this.pending = '';
    const m = TAG_OPEN_RE.exec(buf);
    if (m) {
      const name = m[1].toLowerCase();
      if (KNOWN_TAGS.find((k) => k === name || k.startsWith(name))) {
        buf = buf.slice(0, m.index);
      }
    }
    return buf;
  }
}
