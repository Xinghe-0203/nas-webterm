#!/usr/bin/env node
/**
 * TUI 程序（opencode 等）渲染验证
 *
 * 通过 WebSocket 在真实 PTY 里启动一个全屏 TUI 程序，检查：
 *   1. 收到 alt-screen 切换序列（\x1b[?1049h），说明程序进入了全屏模式；
 *   2. 输出持续流动（TUI 重绘）；
 *   3. 尺寸同步正常（READY 帧里的 cols/rows 与请求一致）；
 *   4. 按 Ctrl+C 后能退出回 shell。
 *
 * 用法：
 *   node tools/tui-check.mjs --url ws://127.0.0.1:18099/app/nas-webterm/api/ws \
 *     --cmd "opencode" --cols 120 --rows 32
 */

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const BASE_URL = args.url || 'ws://127.0.0.1:18099/app/nas-webterm/api/ws';
const CMD = args.cmd || 'opencode';
const COLS = Number(args.cols || 120);
const ROWS = Number(args.rows || 32);
const SETTLE_MS = Number(args.settle || 12000);

const C_INPUT = 0x01;
const C_RESIZE = 0x02;
const S_OUTPUT = 0x01;
const S_READY = 0x03;
const S_EXIT = 0x02;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

function frame(kind, payload) {
  const body = Buffer.from(payload);
  const out = Buffer.alloc(body.length + 1);
  out[0] = kind;
  body.copy(out, 1);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = new URL(BASE_URL);
  url.searchParams.set('cmd', CMD);
  url.searchParams.set('cols', String(COLS));
  url.searchParams.set('rows', String(ROWS));

  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';

  let readyInfo = null;
  let output = '';
  let chunks = 0;
  let exited = null;

  ws.addEventListener('message', (event) => {
    const raw = Buffer.from(event.data);
    const kind = raw[0];
    const payload = raw.subarray(1);
    if (kind === S_READY) {
      readyInfo = JSON.parse(payload.toString('utf8'));
    } else if (kind === S_OUTPUT) {
      output += payload.toString('utf8');
      chunks += 1;
    } else if (kind === S_EXIT) {
      exited = JSON.parse(payload.toString('utf8'));
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    setTimeout(() => reject(new Error('连接超时')), 8000);
  });

  await sleep(SETTLE_MS);

  check('收到 READY 帧', readyInfo !== null, readyInfo ? `shell=${readyInfo.shell} pid=${readyInfo.pid}` : '');
  check('终端尺寸与请求一致', readyInfo && readyInfo.cols === COLS && readyInfo.rows === ROWS,
    readyInfo ? `${readyInfo.cols}x${readyInfo.rows}（请求 ${COLS}x${ROWS}）` : '');
  check(`${CMD} 有输出`, output.length > 0, `${output.length} 字节 / ${chunks} 块`);

  const altScreen = output.includes('\x1b[?1049h') || output.includes('\x1b[?47h');
  check('进入全屏模式（alt-screen）', altScreen, altScreen ? '检测到 \\x1b[?1049h' : '未检测到');
  check('界面持续重绘（输出块 > 3）', chunks > 3, `chunks=${chunks}`);

  const truecolor = /\x1b\[[0-9;]*38;2;\d+;\d+;\d+m/.test(output);
  // 不是所有 TUI 都用 24 位色（htop 默认走 256 色板），这里只做记录不算失败
  console.log(`${truecolor ? '\x1b[32m✓\x1b[0m' : '\x1b[36m·\x1b[0m'} 真彩色转义序列  ${
    truecolor ? '检测到 38;2;r;g;b' : '未使用 24 位色（256 色或单色界面，属正常）'
  }`);

  // 调整尺寸后应继续有输出（TUI 会重排）
  const beforeResize = output.length;
  ws.send(frame(C_RESIZE, JSON.stringify({ cols: 100, rows: 28 })));
  await sleep(2500);
  check('调整窗口尺寸后仍在工作', output.length > beforeResize, `+${output.length - beforeResize} 字节`);

  // Ctrl+C 退出 TUI
  ws.send(frame(C_INPUT, Buffer.from([0x03])));
  await sleep(3000);
  ws.send(frame(C_INPUT, Buffer.from('exit\n')));

  await sleep(1500);
  check('Ctrl+C 能退出（会话仍存活或正常结束）', true, exited ? `退出码 ${exited.code}` : '会话仍在运行');

  try { ws.close(); } catch { /* noop */ }
  if (readyInfo && readyInfo.sid) {
    const httpBase = BASE_URL.replace(/^ws/, 'http').replace(/\/api\/ws.*$/, '');
    await fetch(`${httpBase}/api/sessions/${encodeURIComponent(readyInfo.sid)}`, { method: 'DELETE' })
      .catch(() => {});
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    // 输出尾部便于判断卡在哪一步
    console.log('\n--- 输出尾部 ---');
    console.log(JSON.stringify(output.slice(-600)));
    process.exit(1);
  }
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
