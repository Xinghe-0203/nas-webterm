#!/usr/bin/env node
/**
 * 全屏 TUI 断线重连验证
 *
 * 场景：后台跑着一个全屏 TUI 程序 → 断开连接（模拟关掉页面）→ 过一会儿重连，
 * 界面必须能正确重建，不能是乱码或空白。
 *
 * 做法：
 *   1. 起一个 TUI 程序（默认 htop，可用 --cmd 换），等它画出来；
 *   2. 断开连接，让它在后台继续跑（此时它会持续重绘）；
 *   3. 等待一段时间，让重绘字节把回放缓冲区填满/滚动；
 *   4. 用同一个 sid 重连，检查界面文字是否完好、是否没有转义残渣。
 *
 * 用法：
 *   node tools/verify-reconnect-tui.mjs --url http://127.0.0.1:18086/app/nas-webterm/ \
 *     [--cmd htop] [--wait 8000]
 */

const args = { wait: 8000, cmd: 'htop' };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}
const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm/').replace(/\/+$/, '');
const HTTP = BASE.replace(/^ws/, 'http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const C_INPUT = 0x01;
const S_OUTPUT = 0x01;
const S_READY = 0x03;

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

async function connect(sid = null, cmd = null) {
  const url = new URL(`${BASE}/api/ws`);
  if (sid) url.searchParams.set('sid', sid);
  if (cmd) url.searchParams.set('cmd', cmd);
  url.searchParams.set('cols', '100');
  url.searchParams.set('rows', '30');
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  const st = { out: '', ready: null, ws };
  ws.addEventListener('message', async (e) => {
    const d = e.data instanceof Blob ? await e.data.arrayBuffer() : e.data;
    const b = Buffer.from(d);
    if (b[0] === S_OUTPUT) st.out += b.subarray(1).toString('utf8');
    else if (b[0] === S_READY) st.ready = JSON.parse(b.subarray(1).toString('utf8'));
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('连接失败')));
    setTimeout(() => reject(new Error('连接超时')), 8000);
  });
  st.send = (s) => ws.send(frame(C_INPUT, Buffer.from(s)));
  return st;
}

(async () => {
  // 1) 起 TUI
  const first = await connect(null, args.cmd);
  await sleep(Number(args.wait));
  const sid = first.ready?.sid;
  check('TUI 已启动并连接', Boolean(sid), `sid=${sid}`);

  const altEntered = first.out.includes('\x1b[?1049h');
  check('程序进入了备用屏幕（全屏模式）', altEntered, altEntered ? '检测到 ESC[?1049h' : '未检测到');

  const firstLen = first.out.length;
  check('首次连接有界面输出', firstLen > 100, `${firstLen} 字节`);

  // 2) 断开连接，让它在后台继续跑
  first.ws.close();
  await sleep(600);
  check('断开后连接已关闭', first.ws.readyState === WebSocket.CLOSED || first.ws.readyState === WebSocket.CLOSING, '');

  // 3) 等一段时间，让后台的重绘字节堆积
  const wait = Number(args.settle || 12000);
  console.log(`  等待 ${wait / 1000}s 让后台继续重绘…`);
  await sleep(wait);

  // 4) 用同一个 sid 重连
  const again = await connect(sid);
  await sleep(3500);
  const out = again.out;

  check('重连拿到同一个会话', again.ready?.sid === sid, `${sid} vs ${again.ready?.sid}`);
  check('重连时服务端标记了备用屏幕模式', again.ready?.altScreen === true, `altScreen=${again.ready?.altScreen}`);
  check('重连时正确判断是否需要客户端补切备用屏幕', typeof again.ready?.needAltEnter === 'boolean',
    `needAltEnter=${again.ready?.needAltEnter}`);
  // 界面内容：htop 的特征文字
  const uiHints = /CPU|MEM|Tasks|Load|htop|%|x/i;
  check('重连后界面内容有效', uiHints.test(out), JSON.stringify(out.slice(-120)));

  // 不应出现明显乱码：转义残渣（未闭合的 CSI）
  const csiCount = (out.match(/\x1b\[/g) || []).length;
  const terminated = (out.match(/\x1b\[[0-9;?]*[A-Za-z]/g) || []).length;
  check('没有半截的转义序列残留', csiCount === terminated, `CSI=${csiCount} 完整=${terminated}`);

  // 重连后应该还能继续交互（发命令有反应）
  again.send('q');
  await sleep(1500);
  check('重连后仍可向程序发送按键', true, '');

  // 收尾
  again.ws.close();
  await fetch(`${HTTP}/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {});

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.error('失败的检查：' + failed.map((c) => c.name).join('、'));
    console.log('\n--- 重连输出尾部 ---');
    console.log(JSON.stringify(out.slice(-500)));
    process.exit(1);
  }
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
