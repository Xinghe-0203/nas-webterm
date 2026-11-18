/**
 * 本地 mock：OpenAI 兼容的 /v1/chat/completions（流式）。
 *
 * 只用于本地界面验证，不进安装包。
 *
 *   node tools/mock-ai.mjs --port 18121                 # 常规多行标签
 *   node tools/mock-ai.mjs --port 18121 --style leak    # 标签与命令压成一行（最容易漏标签的写法）
 *   node tools/mock-ai.mjs --port 18121 --long          # 命令输出后再吐一大段长文本
 *   node tools/mock-ai.mjs --port 18121 --slow          # 给一条中途 sleep 2 的慢命令（验证等待）
 *
 * 剧本：第 1 轮给「说明 + 一条 df -h 命令」，第 2 轮（消息里已带命令输出）给结论；
 * `--long` 会在结论前塞进几十行，用来验证「展开的命令卡片不会被后续输出顶出屏幕」；
 * `--slow` 用 `printf; sleep 2; printf` 验证「命令中途停顿不能被当成执行完成」，
 * 配合 tools/verify-agent-wait.mjs 使用。
 */

import http from 'node:http';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  // 支持 --long / --slow 这类无值开关；有值的（--port 18121 / --style leak）照常取下一项
  if (next === undefined || next.startsWith('--')) {
    args[key] = true;
  } else {
    args[key] = next;
    i += 1;
  }
}

const PORT = Number(args.port || 18121);
const STYLE = args.style === 'leak' ? 'leak' : 'multiline';
const LONG = Boolean(args.long);
const SLOW = Boolean(args.slow);

const INTRO = SLOW
  ? '先跑一条会中途停顿的命令，验证 agent 会等它真正结束。\n\n'
  : '磁盘可能有压力，先看整体使用率。\n\n';

const CMD = SLOW
  ? 'printf "slow-start\\n"; sleep 2; printf "slow-end\\n"'
  : 'df -h';

const SLOW_CONCLUSION =
  '命令已完整执行：先输出了 `slow-start`，停顿 2 秒后输出了 `slow-end`，退出码 0。\n';

const TAG_MULTILINE =
  `<execute_command>\n<command>${CMD}</command>\n<purpose>查看各分区使用率</purpose>\n` +
  '<requires_approval>false</requires_approval>\n</execute_command>\n';

const TAG_SINGLE_LINE =
  `<execute_command> <command>${CMD}</command> <purpose>查看各分区使用率</purpose>` +
  ' <requires_approval>false</requires_approval> </execute_command>\n';

const FILLER = Array.from(
  { length: 40 },
  (_v, i) => `${i + 1}. 第 ${i + 1} 条检查项：这一行只是用来把气泡撑高，验证命令卡片不会被顶出屏幕。\n`,
).join('');

const CONCLUSION =
  '## 结论\n\n' +
  '根分区还有 **58%** 可用，没有接近写满。\n\n' +
  '| 分区 | 使用率 |\n| --- | --- |\n| / | 42% |\n| /vol2 | 61% |\n\n' +
  '如果要清理，`/vol2` 上的旧备份最占空间。\n';

/** 第 2 轮的正文：--long 时在前面塞一大段，制造「后面的输出盖住卡片」的场景 */
const SECOND_BODY = LONG ? `${FILLER}\n${CONCLUSION}` : CONCLUSION;

/** 按固定大小切片，模拟模型逐片吐字（包括把标签切成「单个 `<`」这种极端情况） */
function slices(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404).end('not found');
    return;
  }
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let messages = [];
    try {
      messages = JSON.parse(body).messages || [];
    } catch {
      /* 忽略 */
    }
    const last = messages[messages.length - 1]?.content || '';
    // agent 回灌命令输出时用的措辞（1.2.4 起带上了退出码和「已执行结束」）
    const hasOutput = last.includes('执行输出') || last.includes('已执行结束');

    const script = hasOutput
      ? slices(SLOW ? SLOW_CONCLUSION : SECOND_BODY, 7)
      : STYLE === 'leak'
        ? slices(INTRO + TAG_SINGLE_LINE, 9)
        : slices(INTRO + TAG_MULTILINE, 11);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let i = 0;
    const timer = setInterval(() => {
      if (i >= script.length) {
        clearInterval(timer);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const payload = {
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: script[i] }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      i += 1;
    }, 45);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `mock AI listening on http://127.0.0.1:${PORT}/v1 (style=${STYLE}${SLOW ? ', slow' : ''})`,
  );
});
