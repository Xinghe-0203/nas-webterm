#!/usr/bin/env node
/**
 * AI 任务断线重连回归。
 *
 * 背景：手机上切后台、锁屏、地铁里网络抖动都会让 SSE 断掉。原来的行为
 * 是服务端立刻中止任务——模型调用的钱花了、命令执行了一半，用户回来只
 * 看到半截输出，聊天记录里也只有残缺的一轮。
 *
 * 现在：客户端断开后任务进入宽限期等它回来；客户端带「已收到的序号」
 * 接回同一个任务，服务端把断线期间漏掉的事件补发过来。
 *
 * 断言：
 *   1. 任务跑着的时候断开连接 → 任务**没有**立刻死掉（还能接回）
 *   2. 用 resume 接口接回 → 拿到断线期间漏掉的事件（含最后的 done）
 *   3. 事件带 SSE id 字段，序号递增
 *   4. 带正确的 afterSeq 接回 → 不会重复收到已经处理过的事件
 *   5. 任务结束后再接回 → 404（前端据此提示「任务已结束」）
 *   6. 断线期间的结果仍然写进了聊天记录
 *
 * 用法：
 *   node tools/verify-ai-resume.mjs --url http://127.0.0.1:18086/app/nas-webterm-ai/
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

/**
 * 读 SSE 流，把事件收进数组。
 * `stopAfter` 个事件后主动放弃连接（模拟客户端掉线）。
 */
async function readStream(res, stopAfter = Infinity) {
  const events = [];
  const ids = [];
  if (!res.body) return { events, ids };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let id = null;
        let payload = null;
        for (const line of block.split('\n')) {
          if (line.startsWith('id:')) id = Number(line.slice(3).trim());
          if (line.startsWith('data:')) payload = line.slice(5).trim();
        }
        if (payload) {
          try {
            events.push(JSON.parse(payload));
          } catch {
            /* 忽略 */
          }
        }
        if (id !== null) ids.push(id);
        idx = buf.indexOf('\n\n');
        if (events.length >= stopAfter) {
          // 模拟客户端掉线：直接放弃这条流
          await reader.cancel().catch(() => {});
          return { events, ids };
        }
      }
    }
  } catch {
    /* 连接被掐断 */
  }
  return { events, ids };
}

// ---- 准备：建一个终端会话 ----
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

await json('api/ai/history', { method: 'DELETE' });

// ---- 1) 启动任务，读到一半就断开 ----
const res = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sid,
    text: '看看磁盘占用',
    conversationId: '',
    requestId: 'req-retry-test',
  }),
});
const runId = res.headers.get('x-run-id') || '';
check('任务返回 runId', Boolean(runId), runId.slice(0, 16));

const first = await readStream(res, 1);
check('断开前至少收到 1 个事件', first.events.length >= 1, `events=${first.events.length}`);
check('事件带 SSE id 字段', first.ids.length >= 1, `ids=${first.ids.join(',')}`);
const lastSeq = first.ids.length ? first.ids[first.ids.length - 1] : 0;

// ---- 2) 任务还在跑时，同一会话发**新消息** → 必须报冲突，不能静默吞掉 ----
// 刚掐断第一段流，任务还在跑（正在等模型/命令），这时发新消息。
const other = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sid, text: '这是一条全新的消息', conversationId: '' }),
});
const otherStatus = other.status;
const otherBody = await other.json().catch(() => null);
check(
  '任务运行中发新消息时明确报冲突（不静默吞掉）',
  otherStatus === 409 && otherBody?.code === 'busy',
  `status=${otherStatus} code=${otherBody?.code ?? '-'}`,
);
if (other.body) await other.body.cancel().catch(() => {});

// ---- 2b) 同一个 requestId 重发 → 接回同一个任务；换了 id 的同样文字 → 409 ----
// 场景：前端在首次响应丢失后重试（会带同一个 requestId）。服务端必须认出来
// 这是「同一条消息的重试」，而不是「用户又发了一条一样的话」。
const retryReq = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sid,
    text: '看看磁盘占用',
    conversationId: '',
    requestId: 'req-retry-test',
    afterSeq: lastSeq,
  }),
});
const retryStatus = retryReq.status;
const retryRun = retryReq.headers.get('x-run-id') || '';
check(
  '同一条消息的重试（同 requestId）接回原任务',
  retryStatus === 200 && retryRun === runId,
  `status=${retryStatus} ${retryRun.slice(0, 12)} vs ${runId.slice(0, 12)}`,
);
if (retryReq.body) await retryReq.body.cancel().catch(() => {});

// 同样的文字、但换了一个 requestId：这是用户真的又问了一遍 → 仍要 409
const dupText = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sid,
    text: '看看磁盘占用',
    conversationId: '',
    requestId: 'req-brand-new',
  }),
});
check(
  '同样文字但换了 requestId 时仍报冲突（不当成重试）',
  dupText.status === 409,
  `status=${dupText.status}`,
);
if (dupText.body) await dupText.body.cancel().catch(() => {});

// ---- 3) 断线后任务还活着：能接回 ----
await sleep(300);
const resume = await fetch(`${BASE}api/ai/agent/resume`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, afterSeq: lastSeq }),
});
check('断线后可以接回任务', resume.status === 200, `status=${resume.status}`);

const second = await readStream(resume);
const all = [...first.events, ...second.events];
check('接回后收到了完成事件', all.some((e) => e.type === 'done'), `events=${all.length}`);
check(
  '接回后能看到命令卡片',
  all.some((e) => e.type === 'command'),
  `types=${[...new Set(all.map((e) => e.type))].join(',')}`,
);
check(
  '接回后的事件序号接着往下走',
  second.ids.length === 0 || second.ids[0] > lastSeq,
  `first=${second.ids[0] ?? '-'} last=${lastSeq}`,
);

// ---- 3) 带正确的 afterSeq 接回不会重复 ----
const again = await fetch(`${BASE}api/ai/agent/resume`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, afterSeq: lastSeq }),
});
const dup = await readStream(again);
const dupTypes = dup.events.map((e) => e.type);
check(
  '带 afterSeq 接回不重复发已处理的事件',
  !dupTypes.includes('command'),
  `types=${[...new Set(dupTypes)].join(',') || '(空)'}`,
);

// ---- 3b) 点了「停止」→ 任务立刻结束，不占着会话名额 ----
const stopRun = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sid, text: '一条会被停掉的任务', conversationId: '' }),
});
const stopRunId = stopRun.headers.get('x-run-id') || '';
check('新任务拿到 runId', Boolean(stopRunId), stopRunId.slice(0, 16));
await sleep(300);
const stopRes = await json('api/ai/agent/decide', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId: stopRunId, decision: 'stop' }),
});
check(
  '没有待审批命令时「停止」也能叫停任务',
  stopRes.status === 200 && stopRes.body?.ok === true,
  `status=${stopRes.status}`,
);
// 停止后应能立刻开新任务（没有占着名额）
await sleep(500);
const afterStop = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sid, text: '停止之后的新任务', conversationId: '' }),
});
const afterStopStatus = afterStop.status;
check('停止后可以立刻开始新任务', afterStopStatus === 200, `status=${afterStopStatus}`);
// 读完这条流，让它正常结束；否则下面的「重发测试」会撞上它还在跑
await readStream(afterStop);

// ---- 3c) 任务跑完之后重发同一条请求 → 接回原来那条（不重跑） ----
await sleep(1500);
const before = (await json('api/ai/history')).body?.data?.items?.length ?? 0;
const again1 = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sid, text: '重发测试', conversationId: '' }),
});
const againRun1 = again1.headers.get('x-run-id') || '';
check('重发测试任务拿到 runId', Boolean(againRun1), againRun1.slice(0, 16));
await readStream(again1);
await sleep(1200);
// 任务已 done（前端也是这样：收到 done 就允许下一条）；带同一个 runId 重发
const again2 = await fetch(`${BASE}api/ai/agent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    sid,
    text: '重发测试',
    conversationId: '',
    resumeRunId: againRun1,
    afterSeq: 9999,
  }),
});
const againRun2 = again2.headers.get('x-run-id') || '';
check(
  '重发同一条请求接回同一个任务（不重跑）',
  Boolean(againRun2) && againRun2 === againRun1,
  `${againRun1.slice(0, 16)} vs ${againRun2.slice(0, 16)}`,
);
if (again2.body) await again2.body.cancel().catch(() => {});
await sleep(500);
const after = (await json('api/ai/history')).body?.data?.items?.length ?? 0;
check('重发同一条请求没有多写一条聊天记录', after === before + 1, `before=${before} after=${after}`);

// ---- 4) 任务结束后接回 → 404 ----
await sleep(800);
const gone = await json('api/ai/agent/resume', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ runId, afterSeq: 0 }),
});
check('任务结束后接回返回 404', gone.status === 404, `status=${gone.status}`);

// ---- 5) 断线期间的结果写进了聊天记录 ----
await sleep(400);
const list = (await json('api/ai/history')).body?.data?.items ?? [];
check('断线期间的结果仍然写进了聊天记录', list.length >= 1, `count=${list.length}`);
if (list.length) {
  const detail = (await json(`api/ai/history/${list[0].id}`)).body?.data;
  const turn = detail?.turns?.[0];
  check(
    '聊天记录里的助手回复不是空的',
    Boolean(turn?.assistant?.trim().length),
    `${(turn?.assistant?.length ?? 0)} 字符`,
  );
  check(
    '聊天记录里没有协议标签碎片',
    !/<execute\b/.test(JSON.stringify(detail ?? {})),
    '',
  );
}

await json(`api/sessions/${sid}`, { method: 'DELETE' }).catch(() => {});

const failed = checks.filter((c) => !c.ok);
console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
  process.exit(1);
}
