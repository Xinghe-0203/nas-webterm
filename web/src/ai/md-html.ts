/**
 * Markdown → HTML（AI 面板用）。
 *
 * 终端里显示 AI 回复的问题在于：终端只有字符网格，做不到真正的富文本，
 * 而且和 shell 输出挤在同一块缓冲区里，两边的边框、颜色、折行互相干扰。
 * 现在 AI 的内容渲染到右侧的 HTML 面板，这里是它的 Markdown 渲染器。
 *
 * 安全：先把整段文本转义，再套上我们自己的标签。模型输出里的任何 HTML
 * （包括 `<script>`、`<img onerror=…>`）都会变成普通文字，不会被执行。
 * 链接只允许 http/https，避免 `javascript:` 之类的伪协议。
 *
 * 不做完整的 CommonMark：只覆盖模型实际会用到的结构（标题、列表、表格、
 * 代码块、引用、分隔线、粗体/斜体/删除线/行内代码/链接）。
 */

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESC[ch] ?? ch);
}

const FENCE_RE = /^\s*(```|~~~)\s*([\w+#-]*)\s*$/;
const HR_RE = /^\s*([-*_])\1{2,}\s*$/;
const HEADING_RE = /^\s*(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * 把模型回复渲染成一段安全 HTML。
 * 每次增量到达时整段重渲染：消息通常只有几百字，重新渲染比增量修补可靠得多
 * （行内标记、列表、表格的结构会随新片段变化）。
 */
export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let para: string[] = [];
  let list: 'ul' | 'ol' | null = null;

  const flushPara = (): void => {
    if (!para.length) return;
    const text = para.join(' ');
    para = [];
    out.push(`<p>${inline(text)}</p>`);
  };
  const closeList = (): void => {
    if (!list) return;
    out.push(`</${list}>`);
    list = null;
  };

  while (i < lines.length) {
    const raw = lines[i];

    // 代码块
    const fence = FENCE_RE.exec(raw);
    if (fence) {
      flushPara();
      closeList();
      const lang = fence[2];
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const row = lines[i];
        const close = FENCE_RE.exec(row);
        if (close && !close[2]) {
          i += 1;
          break;
        }
        body.push(row);
        i += 1;
      }
      const cls = lang ? 'md-code' : 'md-code md-code-plain';
      out.push(
        `<pre class="${cls}"><code>${escapeHtml(body.join('\n'))}</code></pre>`,
      );
      continue;
    }

    if (!raw.trim()) {
      flushPara();
      closeList();
      i += 1;
      continue;
    }

    // 表格：当前行有竖线，且下一行是分隔行
    if (
      raw.includes('|') &&
      i + 1 < lines.length &&
      TABLE_SEP_RE.test(lines[i + 1]) &&
      lines[i + 1].includes('-')
    ) {
      flushPara();
      closeList();
      const head = splitRow(raw);
      i += 1; // 跳过表头
      i += 1; // 跳过分隔行
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(splitRow(lines[i]));
        i += 1;
      }
      const th = head.map((c) => `<th>${inline(c)}</th>`).join('');
      const rows = body
        .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table class="md-table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`);
      continue;
    }

    const heading = HEADING_RE.exec(raw);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1].length, 4);
      out.push(`<h${level} class="md-h">${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (HR_RE.test(raw)) {
      flushPara();
      closeList();
      out.push('<hr class="md-hr" />');
      i += 1;
      continue;
    }

    const quote = QUOTE_RE.exec(raw);
    if (quote) {
      flushPara();
      closeList();
      const parts: string[] = [quote[1]];
      i += 1;
      while (i < lines.length) {
        const next = QUOTE_RE.exec(lines[i]);
        if (!next) break;
        parts.push(next[1]);
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${inline(parts.join(' '))}</blockquote>`);
      continue;
    }

    const item = LIST_RE.exec(raw);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[2]);
      const kind = ordered ? 'ol' : 'ul';
      if (list !== kind) {
        closeList();
        out.push(`<${kind} class="md-list">`);
        list = kind;
      }
      out.push(`<li>${inline(item[3])}</li>`);
      i += 1;
      continue;
    }

    closeList();
    para.push(raw.trim());
    i += 1;
  }

  flushPara();
  closeList();
  return out.join('');
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/**
 * 行内格式。先抽出代码片段（避免里面的 `*`、`_` 被当成强调），
 * 整体转义后再套标签。
 */
function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`]+)`/g, (_m, code: string) => {
    codes.push(code);
    return `\u0001${codes.length - 1}\u0002`;
  });

  s = escapeHtml(s);

  // 链接：只接受 http(s)，标签文本已经转义
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noreferrer noopener">${label}</a>`,
  );

  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^A-Za-z0-9_])__([^_]+)__/g, '$1<strong>$2</strong>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/(^|[^*A-Za-z0-9])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  s = s.replace(/\u0001(\d+)\u0002/g, (_m, idx: string) => {
    return `<code class="md-inline-code">${escapeHtml(codes[Number(idx)])}</code>`;
  });

  return s;
}
