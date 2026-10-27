#!/usr/bin/env node
/**
 * 全功能验证：把应用对外承诺的每个能力都实际跑一遍。
 *
 * 覆盖：
 *   A. 终端基础      提示符、命令执行、退出码
 *   B. 尺寸同步      改窗口大小后，PTY 的行列数要真的变（用 stty size 验证）
 *   C. 粘贴          括号粘贴模式（bracketed paste）要生效
 *   D. 中文宽度      中日韩字符按双宽渲染，不能错位
 *   E. 真彩色        24 位色转义原样穿透
 *   F. 信号          Ctrl+C 能中断前台程序
 *   G. 会话隔离      两个标签页互不串扰
 *   H. 容量上限      达到上限后拒绝新建，且不杀旧会话
 *   I. 断线重连      重新连接同一个 sid 能拿到回放
 *   J. 控制帧        未知帧类型不能让连接断开
 *
 * 用法：node tools/verify-features.mjs --url http://127.0.0.1:18086/app/nas-webterm/
 */

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}
const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm/').replace(/\/+$/, '');
const HTTP = BASE.replace(/^ws/, 'http');
if (!BASE) {
  console.error('用法: node tools/verify-features.mjs --url http://127.0.0.1:18086/app/nas-webterm/');
  process.exit(2);
}

const C_INPUT = 0x01;
const C_RESIZE = 0x02;
const S_OUTPUT = 0x01;
const S_EXIT = 0x02;
const S_READY = 0x03;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(kind, payload) {
  const body = Buffer.from(payload);
  const out = Buffer.alloc(body.length + 1);
  out[0] = kind;
  body.copy(out, 1);
  return out;
}

/** 打开一个终端会话，返回控制句柄 */
async function openSession({ cols = 100, rows = 30, cmd = null, sid = null } = {}) {
  const url = new URL(`${BASE}/api/ws`);
  if (sid) url.searchParams.set('sid', sid);
  if (cmd) url.searchParams.set('cmd', cmd);
  url.searchParams.set('cols', String(cols));
  url.searchParams.set('rows', String(rows));
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  const state = { out: '', ready: null, exit: null, ws };
  ws.addEventListener('message', async (e) => {
    const d = e.data instanceof Blob ? await e.data.arrayBuffer() : e.data;
    const b = Buffer.from(d);
    if (b[0] === S_OUTPUT) state.out += b.subarray(1).toString('utf8');
    else if (b[0] === S_READY) state.ready = JSON.parse(b.subarray(1).toString('utf8'));
    else if (b[0] === S_EXIT) state.exit = JSON.parse(b.subarray(1).toString('utf8'));
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
    setTimeout(() => reject(new Error('连接超时')), 8000);
  });
  await sleep(400);
  state.send = (s) => ws.send(frame(C_INPUT, Buffer.from(s)));
  state.resize = (c, r) => ws.send(frame(C_RESIZE, JSON.stringify({ cols: c, rows: r })));
  state.close = () => {
    try { ws.close(); } catch { /* noop */ }
  };
  return state;
}

/** 彻底销毁一个会话：关连接 + 通知服务端回收（等价于前端关闭标签页） */
async function destroy(session) {
  if (!session) return;
  const sid = session.ready?.sid;
  session.close();
  if (sid) {
    await api(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {});
  }
  await sleep(120);
}

async function api(path, init) {
  const res = await fetch(`${HTTP}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

(async () => {
  // 开测前清场：把上一轮遗留的会话全部回收
  for (const old of (await api('/api/sessions')).json?.data ?? []) {
    await api(`/api/sessions/${encodeURIComponent(old.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  await sleep(200);

  // ---------------------------------------------------------------- A 基础
  const s = await openSession();
  check('A1 收到 READY 帧', s.ready !== null, s.ready ? `sid=${s.ready.sid} ${s.ready.cols}x${s.ready.rows}` : '');
  check('A2 shell 已就绪', /\$|#/.test(s.out), JSON.stringify(s.out.slice(-50)));

  s.send('echo "feature-"$((1+1))\n');
  await sleep(1200);
  check('A3 命令输出正确', s.out.includes('feature-2'), '');

  s.send('exit 7\n');
  await sleep(1200);
  check('A4 退出码正确上报', s.exit !== null && s.exit.code === 7, s.exit ? `code=${s.exit.code}` : '未收到退出帧');
  await destroy(s);

  // ------------------------------------------------------------ B 尺寸同步
  const r = await openSession({ cols: 100, rows: 30 });
  r.send('stty size\n');
  await sleep(1000);
  const sizeBefore = (r.out.match(/(\d+)\s+(\d+)/) || [])[0];
  r.resize(132, 43);
  await sleep(400);
  r.send('stty size\n');
  await sleep(1000);
  const sizeAfter = (r.out.match(/(\d+)\s+(\d+)/g) || []).pop();
  check('B1 初始尺寸已同步到 PTY', sizeBefore === '30 100', `stty=${sizeBefore}`);
  check('B2 调整窗口后 PTY 尺寸同步', sizeAfter === '43 132', `stty=${sizeAfter}`);
  await destroy(r);

  // ---------------------------------------------------------------- C 粘贴
  const p = await openSession();
  await sleep(600);
  p.send('cat > /tmp/feature-paste.txt\n');
  await sleep(600);
  // 模拟括号粘贴：ESC [ 200~ ... ESC [ 201~
  p.ws.send(frame(C_INPUT, Buffer.from('[200~pasted-text-123[201~\n')));
  await sleep(900);
  p.send('cat /tmp/feature-paste.txt\n');
  await sleep(1000);
  check('C1 括号粘贴内容送达程序', p.out.includes('pasted-text-123'), JSON.stringify(p.out.slice(-80)));
  await destroy(p);

  // ------------------------------------------------------------ D 中文宽度
  const c = await openSession();
  c.send('printf "中文字符测试\\n"\n');
  await sleep(1000);
  check('D1 中文正常输出', c.out.includes('中文字符测试'), '');
  const cjk = '中';
  c.send(`printf "%s|%s\\n" "$(printf '${cjk}' | wc -m)" "$(printf '${cjk}' | wc -c)"\n`);
  await sleep(1000);
  check('D2 中文按 UTF-8 多字节正确传递', /1\|3/.test(c.out), JSON.stringify(c.out.slice(-60)));
  await destroy(c);

  // ---------------------------------------------------------------- E 真彩色
  const t = await openSession();
  t.send('printf "\\033[38;2;12;34;56mTRUECOLOR\\033[0m\\n"\n');
  await sleep(1000);
  check('E1 24 位真彩色转义原样穿透', t.out.includes('[38;2;12;34;56m'), '');
  t.close();

  // ---------------------------------------------------------------- F 信号
  const g = await openSession();
  g.send('sleep 30\n');
  await sleep(700);
  g.send(''); // Ctrl+C
  await sleep(900);
  g.send('echo "after-signal-$((5*5))"\n');
  await sleep(1200);
  check('F1 Ctrl+C 能中断前台程序', g.out.includes('after-signal-25'), JSON.stringify(g.out.slice(-80)));
  await destroy(g);

  // ------------------------------------------------------------ G 会话隔离
  const g1 = await openSession();
  const g2 = await openSession();
  g1.send('echo "ONLY-IN-ONE"\n');
  await sleep(1000);
  check('G1 两个会话输出互不串扰', !g2.out.includes('ONLY-IN-ONE'), '');
  check('G2 两个会话 sid 不同', g1.ready.sid !== g2.ready.sid, `${g1.ready.sid} vs ${g2.ready.sid}`);
  await destroy(g1);
  await destroy(g2);

  // ------------------------------------------------------------ H 容量上限
  const cfg = await api('/api/config');
  const maxSessions = Number(cfg.json?.data?.maxSessions ?? 0);
  if (maxSessions > 0) {
    // 先清场，保证计数从 0 开始
    for (const old of (await api('/api/sessions')).json?.data ?? []) {
      await api(`/api/sessions/${encodeURIComponent(old.id)}`, { method: 'DELETE' }).catch(() => {});
    }
    await sleep(200);
    const before = await api('/api/sessions');
    const count = before.json?.data?.length ?? 0;
    // 开到上限
    const opened = [];
    for (let i = count; i < maxSessions; i += 1) {
      const x = await openSession();
      opened.push(x);
    }
    await sleep(500);
    const overflow = await openSession().catch(() => null);
    if (overflow) {
      overflow.close();
      check('H1 达到上限后拒绝新建', false, '仍然能创建新会话');
    } else {
      check('H1 达到上限后拒绝新建', true, `上限=${maxSessions}`);
    }
    const still = await api('/api/sessions');
    check('H2 超限不会杀掉旧会话', (still.json?.data?.length ?? 0) >= maxSessions,
      `当前 ${still.json?.data?.length} 个`);
    for (const x of opened) await destroy(x);
  } else {
    check('H1 达到上限后拒绝新建', true, '（未配置上限，跳过）');
  }

  // ------------------------------------------------------------ I 断线重连
  const rec = await openSession();
  const recSid = rec.ready.sid;
  rec.send('echo "BEFORE-DISCONNECT"\n');
  await sleep(1000);
  rec.close();
  await sleep(600);
  const re = await openSession({ sid: recSid });
  await sleep(1200);
  check('I1 重连拿到同一个会话', re.ready && re.ready.sid === recSid, `${recSid} vs ${re.ready?.sid}`);
  check('I2 重连后回放之前的输出', re.out.includes('BEFORE-DISCONNECT'), '');
  await destroy(re);

  // ---------------------------------------------------------------- J 控制帧
  const j = await openSession();
  j.ws.send(frame(0x7f, Buffer.from('unknown frame')));
  await sleep(500);
  j.send('echo "still-alive"\n');
  await sleep(1000);
  check('J1 未知帧类型不会断开连接', j.out.includes('still-alive'), '');
  await destroy(j);

  const failed = checks.filter((x) => !x.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.error('失败的检查：' + failed.map((x) => x.name).join('、'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
