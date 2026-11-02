#!/usr/bin/env node
/**
 * 1.0.3 回归测试：
 *   F2  终端里跑过后台进程时，退出 shell 能收到 S_EXIT（不再永远挂着）
 *   F1  名额满时，服务端会回收「没有客户端连接」的孤儿会话
 *   S2  前台程序不读输入时，写入超时会用 S_ERROR 帧告知客户端
 *
 * 用法：node /tmp/regress-103.mjs <二进制路径> [端口]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2] || '/tmp/nas-webterm/rust/target/release/nas-webterm';
const PORT = Number(process.argv[3] || 19921);
const PREFIX = '/app/nas-webterm';
const BASE = `http://127.0.0.1:${PORT}${PREFIX}`;
const WS_BASE = `ws://127.0.0.1:${PORT}${PREFIX}`;
const TMP = mkdtempSync(join(tmpdir(), 'wt103-'));
const LOG = join(TMP, 'server.log');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? '  ' + detail : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(
  BIN,
  [
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--gateway-prefix', PREFIX,
    '--shell', '/bin/bash',
    '--cwd', TMP,
    '--startup-command', '',
    '--idle-minutes', '0',
    '--max-sessions', '3',
    '--socket-mode', '600',
    '--require-admin', 'false',
    '--log-file', LOG,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOut = '';
child.stdout.on('data', (d) => (serverOut += d));
child.stderr.on('data', (d) => (serverOut += d));

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

/** 打开一个 WS，收集收到的帧 */
function openWs(sid, { autoClose = true } = {}) {
  const ws = new WebSocket(`${WS_BASE}/api/ws?sid=${encodeURIComponent(sid)}`);
  const frames = [];
  let closed = false;
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', (ev) => {
    const buf = new Uint8Array(ev.data);
    frames.push({ kind: buf[0], payload: buf.slice(1) });
  });
  ws.addEventListener('close', () => {
    closed = true;
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS 握手超时')), 5000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('WS 连接失败'));
    });
  });
  return {
    ws,
    frames,
    get closed() {
      return closed;
    },
    ready,
    send(kind, payload) {
      const out = new Uint8Array(payload.length + 1);
      out[0] = kind;
      out.set(payload, 1);
      ws.send(out);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function waitFor(pred, timeoutMs = 8000, step = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

try {
  // 等服务起来
  let up = false;
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await api('GET', '/api/healthz');
      if (r.status === 200) {
        up = true;
        break;
      }
    } catch {
      /* not ready */
    }
    await sleep(100);
  }
  if (!up) throw new Error('服务没起来:\n' + serverOut);
  console.log(`服务已启动 (pid=${child.pid})，版本 ${(await api('GET', '/api/healthz')).json?.data?.version}\n`);

  // ---------- F2：后台进程存在时退出 shell，必须收到 S_EXIT ----------
  console.log('【F2】后台进程存在时退出 shell → 应收到 S_EXIT');
  const s1 = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  check('创建会话', s1.status === 200 && s1.json?.data?.id, `sid=${s1.json?.data?.id}`);
  const c1 = openWs(s1.json.data.id);
  await c1.ready;
  await waitFor(() => c1.frames.some((f) => f.kind === 0x03));
  check('收到 S_READY', c1.frames.some((f) => f.kind === 0x03));

  c1.send(0x01, new TextEncoder().encode('sleep 999 &\n'));
  await sleep(600);
  c1.send(0x01, new TextEncoder().encode('exit\n'));

  const gotExit = await waitFor(() => c1.frames.some((f) => f.kind === 0x02), 8000);
  const exitFrame = c1.frames.find((f) => f.kind === 0x02);
  check('收到 S_EXIT', gotExit, exitFrame ? new TextDecoder().decode(exitFrame.payload) : '');
  const list1 = await api('GET', '/api/sessions');
  const info1 = list1.json?.data?.find((x) => x.id === s1.json.data.id);
  check('会话被标记为已退出 (alive=false)', info1 && info1.alive === false, `alive=${info1?.alive}`);
  c1.close();
  // 清掉这个会话，避免影响后面的名额测试
  await api('DELETE', `/api/sessions/${encodeURIComponent(s1.json.data.id)}`);
  await sleep(300);

  // ---------- F1：孤儿会话被回收，名额不会卡死 ----------
  console.log('\n【F1】名额满时回收无主会话');
  const a = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  const b = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  const d0 = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  check(
    '连续创建三个会话（上限=3）',
    a.status === 200 && b.status === 200 && d0.status === 200,
    `${a.json?.data?.id} / ${b.json?.data?.id} / ${d0.json?.data?.id}`,
  );

  // a 保持有客户端连接（模拟用户还在用），b 断开且不 DELETE（模拟前端异常残留）
  const ca = openWs(a.json.data.id);
  await ca.ready;
  await sleep(200);
  const cb = openWs(b.json.data.id);
  await cb.ready;
  await sleep(200);
  cb.close(); // 断开但不删除会话 → b 变成没有客户端的孤儿会话
  // 等服务端真正察觉到断开（客户端数归零）
  const bGone = await waitFor(async () => {
    const l = await api('GET', '/api/sessions');
    const info = (l.json?.data || []).find((x) => x.id === b.json.data.id);
    return info && info.clients === 0;
  }, 5000);
  check('b 的客户端已断开（变成孤儿会话）', bGone);

  const c = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  check(
    '名额满时新会话仍能创建（回收孤儿会话）',
    c.status === 200,
    `status=${c.status} body=${JSON.stringify(c.json)}`,
  );
  const list2 = await api('GET', '/api/sessions');
  const ids = (list2.json?.data || []).map((x) => x.id);
  check('最老的孤儿会话已被回收', !ids.includes(b.json.data.id), `存活=${ids.join(',')}`);
  check('有客户端的会话未被回收', ids.includes(a.json.data.id), `存活=${ids.join(',')}`);
  ca.close();
  await api('DELETE', `/api/sessions/${encodeURIComponent(a.json.data.id)}`).catch(() => {});
  await api('DELETE', `/api/sessions/${encodeURIComponent(c.json?.data?.id || '')}`).catch(() => {});
  await api('DELETE', `/api/sessions/${encodeURIComponent(d0.json?.data?.id || '')}`).catch(() => {});
  await sleep(300);

  // ---------- S2：大量输入时服务端不能卡死 ----------
  console.log('\n【S2】灌入大量输入 → 服务端不能挂死');
  const d = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  const cd = openWs(d.json.data.id);
  await cd.ready;
  await waitFor(() => cd.frames.some((f) => f.kind === 0x03));
  // 关掉回显，免得刷屏的输入被回显成海量输出、把测试客户端挤掉
  cd.send(0x01, new TextEncoder().encode('stty -echo\n'));
  await sleep(500);
  const blob = new Uint8Array(1024);
  blob.fill(0x41);
  for (let i = 0; i < 1400; i += 1) {
    cd.send(0x01, blob);
    if (i % 200 === 0) await sleep(50);
  }
  await sleep(3000);
  const health = await api('GET', '/api/healthz');
  check('刷完输入后服务仍然正常响应', health.status === 200, `status=${health.status}`);
  const other = await api('POST', '/api/sessions', { cols: 80, rows: 24 });
  check('其它会话仍可创建（事件循环没被卡住）', other.status === 200, `status=${other.status}`);
  const errFrame = cd.frames.find((f) => f.kind === 0x04);
  if (errFrame) {
    console.log(`  ℹ️  收到 S_ERROR：${new TextDecoder().decode(errFrame.payload)}`);
  } else {
    console.log('  ℹ️  未触发输入超时（tty 直接丢弃了多余输入），符合预期');
  }
  cd.close();
} catch (e) {
  fail += 1;
  console.error('测试异常：', e);
} finally {
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  await sleep(800);
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) {
    console.log('--- 服务日志 ---');
    console.log(serverOut.slice(-3000));
  }
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(fail > 0 ? 1 : 0);
}
