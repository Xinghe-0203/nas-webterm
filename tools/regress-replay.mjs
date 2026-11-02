#!/usr/bin/env node
/**
 * S1 回归：重连回放必须分片发送。
 * 整块塞进一个 S_OUTPUT 帧的话，前端（待发队列上限 1MB）会把整帧丢掉，
 * 重连后终端就是一片空白。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2] || '/tmp/nas-webterm/rust/target/release/nas-webterm';
const PORT = Number(process.argv[3] || 19930);
const PREFIX = '/app/nas-webterm';
const BASE = `http://127.0.0.1:${PORT}${PREFIX}`;
const TMP = mkdtempSync(join(tmpdir(), 'wts1-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`);
  }
};

const child = spawn(
  BIN,
  [
    '--host', '127.0.0.1', '--port', String(PORT), '--gateway-prefix', PREFIX,
    '--shell', '/bin/bash', '--cwd', TMP, '--idle-minutes', '0', '--max-sessions', '4',
    '--require-admin', 'false', '--log-file', join(TMP, 's.log'),
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function openWs(sid) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${PREFIX}/api/ws?sid=${encodeURIComponent(sid)}`);
  const frames = [];
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (ev) => {
    const buf = new Uint8Array(ev.data);
    frames.push({ kind: buf[0], payload: buf.slice(1) });
  });
  return {
    ws,
    frames,
    ready: new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS 超时')), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error('WS 失败'));
      });
    }),
    send(kind, payload) {
      const b = new Uint8Array(payload.length + 1);
      b[0] = kind;
      b.set(payload, 1);
      ws.send(b);
    },
  };
}

try {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await api('GET', '/api/healthz')).status === 200) break;
    } catch { /* wait */ }
    await sleep(100);
  }

  const s = await api('POST', '/api/sessions', { cols: 200, rows: 50 });
  const sid = s.json?.data?.id;
  console.log(`会话 ${sid}`);

  const c1 = openWs(sid);
  await c1.ready;
  await sleep(500);
  // 让 shell **输出**备用屏幕序列（服务端是靠输出判断是否进入备用屏幕的），
  // 再制造 3MB+ 输出
  c1.send(0x01, new TextEncoder().encode("printf '\\033[?1049h'; seq 1 400000\n"));
  const deadline = Date.now() + 20000;
  let got = 0;
  while (Date.now() < deadline) {
    got = c1.frames.filter((f) => f.kind === 0x01).reduce((a, f) => a + f.payload.length, 0);
    if (got > 2 * 1024 * 1024) break;
    await sleep(200);
  }
  check('产生了 2MB+ 输出', got > 2 * 1024 * 1024, `${(got / 1024 / 1024).toFixed(2)} MiB（客户端消费慢时会被主动断开，属预期）`);
  c1.ws.close();
  await sleep(1500);

  // 重连：回放应当分片送达
  const c2 = openWs(sid);
  await c2.ready;
  await sleep(3000);
  const outs = c2.frames.filter((f) => f.kind === 0x01);
  const total = outs.reduce((a, f) => a + f.payload.length, 0);
  const maxFrame = outs.reduce((a, f) => Math.max(a, f.payload.length), 0);
  console.log(`  回放：${outs.length} 帧，合计 ${(total / 1024 / 1024).toFixed(2)} MiB，最大单帧 ${maxFrame} 字节`);
  check('回放被拆成多帧（不再是单个大帧）', outs.length > 1, `${outs.length} 帧`);
  check('单帧不超过 64KiB+1', maxFrame <= 64 * 1024 + 1, `${maxFrame} 字节`);
  check('回放总量大于 1MiB（前端不会再整帧丢弃）', total > 1024 * 1024, `${(total / 1024 / 1024).toFixed(2)} MiB`);
} catch (e) {
  fail += 1;
  console.error('异常：', e);
} finally {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail) console.log(out.slice(-1500));
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}
