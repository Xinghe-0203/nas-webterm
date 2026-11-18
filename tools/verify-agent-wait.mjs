#!/usr/bin/env node
/**
 * 回归：慢命令必须等真正执行完，再继续下一步；不能把中途停顿当结束。
 *
 * 避免以后再退回「输出安静 900ms 就判定完成」——那种实现会把 apt / docker pull
 * 的中间停顿当结束，下一条命令被仍在运行的程序吃掉；也会把命令输出里
 * 与命令片段相同的行当回显丢掉，模型因此反复重试。
 *
 * 需要一个「慢命令 mock」模型（第一轮给
 * `printf "slow-start\n"; sleep 2; printf "slow-end\n"`，第二轮按
 * 「已执行结束」回灌输出给结论）。本脚本不起 mock，由调用方提供：
 *
 *   node tools/verify-agent-wait.mjs --url http://127.0.0.1:18086/app/nas-webterm-ai/
 *
 * 断言：
 *   1. 只生成一张命令卡片、命令只写 PTY 一次
 *   2. observed 至少等了 1.5s（没有把 sleep 2 的停顿当完成）
 *   3. 输出包含停顿后的第二段
 *   4. 退出码解析为 0
 *   5. 命令执行完之前没有提前汇报结论
 */
const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) continue;
  args[key] = next;
  i += 1;
}
const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm-ai/').replace(/\/+$/, '');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

const created = await (await fetch(`${BASE}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json();
const sid = created?.data?.id;
if (!sid) throw new Error('创建会话失败');

let observedAt = 0;
let observed = null;
let commandEvents = 0;
let mdAfterCommand = 0;
let commandSeen = false;
let execEvents = 0;
let doneAt = 0;
const started = Date.now();

const res = await fetch(`${BASE}/api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sid, text: '测试慢命令等待' }),
});
if (!res.ok || !res.body) throw new Error(`agent HTTP ${res.status}`);

const reader = res.body.getReader();
const hardTimeout = setTimeout(() => {
  console.error('\x1b[31m✗\x1b[0m 等待超时（30s）：agent 没有在慢命令结束后继续');
  fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' }).finally(() => process.exit(1));
}, 30000);
const decoder = new TextDecoder();
let buf = '';
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === 'md' && commandSeen && !observed) mdAfterCommand += 1;
      if (ev.type === 'observed') observedAt = Date.now();
      if (ev.type === 'command') commandSeen = true;
      if (ev.type === 'command') commandEvents += 1;
      if (ev.type === 'exec') execEvents += 1;
      if (ev.type === 'observed') observed = ev;
      if (ev.type === 'done') doneAt = Date.now();
    }
  }
}
clearTimeout(hardTimeout);

check('收到命令卡片', commandEvents === 1, `count=${commandEvents}`);
check('命令只写入 PTY 一次', execEvents === 1, `count=${execEvents}`);
check('observed 至少等了 1.5 秒（没有把 sleep 2 的停顿当完成）', observedAt - started >= 1500, `${observedAt - started}ms`);
check('命令输出包含停顿后的第二段', Boolean(observed?.output?.includes('slow-end')), JSON.stringify(observed?.output ?? '').slice(0, 120));
check('退出码为 0（PROMPT_COMMAND 标记解析正确）', observed?.exitCode === 0, String(observed?.exitCode));
check('命令结束前没有提前汇报结论', mdAfterCommand === 0, `md=${mdAfterCommand}`);
check('最后有 done 事件', doneAt > 0, `${doneAt - started}ms`);

await fetch(`${BASE}/api/sessions/${sid}`, { method: 'DELETE' });

const failed = checks.filter((c) => !c.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) process.exit(1);
