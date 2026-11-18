#!/usr/bin/env node
/**
 * AI 聊天记录（会话历史）回归。
 *
 * 背景：以前对话只存在浏览器内存里，刷新页面就没了；服务端只存了
 * 「长期记忆」（机器配置/偏好），不是聊天记录。现在每一轮都落盘到
 * `${TRIM_PKGVAR}/ai-history.json`，可以列出来、打开、删除、清空。
 *
 * 断言：
 *   1. 跑一轮任务后 /api/ai/history 里出现一个会话，标题是用户第一句话
 *   2. 会话详情含这一轮的 user / assistant / blocks（文字 + 命令卡片）
 *   3. 同一 conversationId 再跑一轮 → 仍是一个会话，轮数变 2（不分裂）
 *   4. 不带 conversationId 再跑 → 新会话
 *   5. 删除指定会话 → 列表少一条
 *   6. 清空全部 → 列表为空
 *
 * 用法：
 *   node tools/verify-ai-history.mjs --url http://127.0.0.1:18086/app/nas-webterm-ai/
 *
 * 需要一个会下发命令的 mock 模型（tools/mock-ai.mjs）。
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
const BASE = `${(args.url || 'http://127.0.0.1:18086/app/nas-webterm-ai/').replace(/\/+$/, '')}/`;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** 跑一次 agent 任务，返回 { conversationId, events }。 */
async function runAgent(sid, text, conversationId) {
  const res = await fetch(`${BASE}api/ai/agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid, text, conversationId: conversationId || '' }),
  });
  const conv = res.headers.get('x-conversation-id') || '';
  const events = [];
  if (res.body) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try { events.push(JSON.parse(payload)); } catch { /* 忽略 */ }
        }
      }
    }
  }
  return { conversationId: conv, events };
}

// 先清掉旧记录，保证断言不受之前跑过的任务影响
await json('api/ai/history', { method: 'DELETE' });
check('清空历史记录', (await json('api/ai/history')).body?.data?.items?.length === 0, '');

// 新建一个终端会话
const created = await json('api/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
});
const sid = created.body?.data?.id;
if (!sid) {
  console.error('创建终端会话失败');
  process.exit(1);
}

// ---- 第 1 轮：新会话 ----
const first = await runAgent(sid, '看看磁盘占用');
check('第一轮返回 conversationId', Boolean(first.conversationId), first.conversationId);
check(
  '第一轮识别并执行了命令',
  first.events.some((e) => e.type === 'command') && first.events.some((e) => e.type === 'observed'),
  '',
);

await sleep(200);
const list1 = (await json('api/ai/history')).body?.data?.items ?? [];
check('历史列表出现 1 个会话', list1.length === 1, `count=${list1.length}`);
check('会话标题取自用户第一句话', (list1[0]?.title ?? '') === '看看磁盘占用', list1[0]?.title ?? '');
check('会话轮数为 1', list1[0]?.turns === 1, String(list1[0]?.turns));

const detail1 = (await json(`api/ai/history/${first.conversationId}`)).body?.data;
check('会话详情包含用户消息', detail1?.turns?.[0]?.user === '看看磁盘占用', detail1?.turns?.[0]?.user ?? '');
check(
  '会话详情包含助手回复',
  Boolean(detail1?.turns?.[0]?.assistant?.length),
  `${detail1?.turns?.[0]?.assistant?.length ?? 0} 字符`,
);
const blocks = detail1?.turns?.[0]?.blocks ?? [];
check(
  '回放块里有命令卡片',
  blocks.some((b) => b.type === 'command' && b.command?.command),
  JSON.stringify(blocks.map((b) => b.type)),
);
const cmdBlock = blocks.find((b) => b.type === 'command');
check(
  '命令卡片带回了输出',
  Boolean(cmdBlock?.command?.output?.length),
  `${cmdBlock?.command?.output?.length ?? 0} 字符`,
);

// ---- 第 2 轮：同一个 conversationId ----
const second = await runAgent(sid, '那内存呢', first.conversationId);
check('第二轮沿用同一个 conversationId', second.conversationId === first.conversationId, second.conversationId);
await sleep(200);
const list2 = (await json('api/ai/history')).body?.data?.items ?? [];
check('同一会话不会分裂成两条', list2.length === 1, `count=${list2.length}`);
check('轮数增加到 2', list2[0]?.turns === 2, String(list2[0]?.turns));
const detail2 = (await json(`api/ai/history/${first.conversationId}`)).body?.data;
check('详情里有第二轮的提问', detail2?.turns?.[1]?.user === '那内存呢', detail2?.turns?.[1]?.user ?? '');

// ---- 第 3 轮：不带 conversationId = 新会话 ----
const third = await runAgent(sid, '换个话题');
check('不带 id 时分配新的 conversationId', third.conversationId && third.conversationId !== first.conversationId, third.conversationId);
await sleep(200);
const list3 = (await json('api/ai/history')).body?.data?.items ?? [];
check('历史列表变成 2 条', list3.length === 2, `count=${list3.length}`);
check('最近更新的排在前面', list3[0]?.id === third.conversationId, list3[0]?.id ?? '');

// ---- 删除单条 ----
const del = await json(`api/ai/history/${first.conversationId}`, { method: 'DELETE' });
check('删除指定会话成功', del.status === 200 && del.body?.ok === true, `status=${del.status}`);
const list4 = (await json('api/ai/history')).body?.data?.items ?? [];
check('删除后只剩 1 条', list4.length === 1, `count=${list4.length}`);
const delAgain = await json(`api/ai/history/${first.conversationId}`, { method: 'DELETE' });
check('重复删除返回 404', delAgain.status === 404 && delAgain.body?.code === 'not_found', `status=${delAgain.status}`);

// ---- 清空全部 ----
const cleared = await json('api/ai/history', { method: 'DELETE' });
check('清空全部成功', cleared.status === 200 && cleared.body?.ok === true, `status=${cleared.status}`);
const list5 = (await json('api/ai/history')).body?.data?.items ?? [];
check('清空后列表为空', list5.length === 0, `count=${list5.length}`);

await json(`api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});

const failed = checks.filter((c) => !c.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
  process.exit(1);
}
