#!/usr/bin/env node
/**
 * WebSocket 终端通道验证（开发模式，TCP）
 *
 * 流程：连接 /api/ws → 收到 READY 帧 → 发送一条命令 → 期待终端回显。
 * 用法：node tools/ws-check.mjs --url ws://127.0.0.1:18086/app/nas-webterm/api/ws
 *
 * 只用 Node 内置的全局 WebSocket，不引入任何依赖。
 */

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const URL_ = args.url || 'ws://127.0.0.1:18086/app/nas-webterm/api/ws';
const COMMAND = args.command || 'echo webterm-ws-ok';
const MARK = 'webterm-ws-ok';

const C_INPUT = 0x01;
const S_OUTPUT = 0x01;
const S_READY = 0x03;
const S_EXIT = 0x02;

function frame(kind, payload) {
  const body = Buffer.from(payload);
  const out = Buffer.alloc(body.length + 1);
  out[0] = kind;
  body.copy(out, 1);
  return out;
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const ws = new WebSocket(URL_);
ws.binaryType = 'arraybuffer';

let ready = false;
let output = '';

const timer = setTimeout(() => {
  fail(`超时：未观察到完整交互（已收到 ${output.length} 字节输出）`);
}, 15000);

ws.addEventListener('open', () => {
  console.log('✓ WebSocket 已连接');
});

ws.addEventListener('message', (event) => {
  const raw = typeof event.data === 'string' ? Buffer.from(event.data, 'binary') : Buffer.from(event.data);
  const kind = raw[0];
  const payload = raw.subarray(1);
  if (kind === S_READY) {
    const info = JSON.parse(payload.toString('utf8'));
    ready = true;
    console.log(`✓ 收到 READY 帧 sid=${info.sid} shell=${info.shell} pid=${info.pid} ${info.cols}x${info.rows}`);
    setTimeout(() => {
      ws.send(frame(C_INPUT, Buffer.from(`${COMMAND}\n`)));
    }, 600);
    return;
  }
  if (kind === S_OUTPUT) {
    output += payload.toString('utf8');
    if (output.includes(MARK)) {
      clearTimeout(timer);
      console.log('✓ 命令回显正确：', JSON.stringify(output.slice(-160)));
      const sid = readyInfo ? readyInfo.sid : null;
      ws.close();
      if (sid) {
        const httpBase = URL_.replace(/^ws/, 'http').replace(/\/api\/ws.*$/, '');
        fetch(`${httpBase}/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' })
          .catch(() => {})
          .finally(() => process.exit(0));
      } else {
        process.exit(0);
      }
    }
    return;
  }
  if (kind === S_EXIT) {
    fail(`会话意外退出：${payload.toString('utf8')}`);
  }
});

ws.addEventListener('error', () => {
  clearTimeout(timer);
  fail('WebSocket 连接失败');
});

ws.addEventListener('close', () => {
  if (!ready) {
    clearTimeout(timer);
    fail('连接在 READY 之前关闭');
  }
});
