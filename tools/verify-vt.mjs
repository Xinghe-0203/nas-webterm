#!/usr/bin/env node
/**
 * VT 兼容性回归测试（浏览器内，真终端解析器）
 *
 * 背景：xterm.js 6.0.0 的 DECRQM（CSI ? n $ p）处理引用了未声明变量，
 * 遇到 opencode 这类会查询终端能力的 TUI 时直接抛 ReferenceError，
 * 解析器停止工作、屏幕永久空白。这个测试把当时触发崩溃的序列固化下来，
 * 升级前端终端库时先跑它。
 *
 * 断言：
 *   1. 页面无未捕获异常（崩溃的直接表现）；
 *   2. 发完查询序列后，终端仍能正常显示后续输出（VT-OK）；
 *   3. alt-screen 切换后仍能继续工作。
 *
 * 用法：node tools/verify-vt.mjs --url http://127.0.0.1:18098/app/nas-webterm/
 *      node tools/verify-vt.mjs --url ... --cmd "opencode" --expect "opencode"
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { wait: 5000 };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const BASE = (args.url || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('用法: node tools/verify-vt.mjs --url http://127.0.0.1:18086/app/nas-webterm/');
  process.exit(2);
}
const CHROME = args.chrome || process.env.CHROME_BIN || 'chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * opencode / OpenTUI 启动时会发出的终端能力查询序列。
 * 标记刻意用 printf 拼出来（'VT-%s' OK），这样「命令行回显」里不会出现
 * 完整标记，断言只能由真正的程序输出满足。
 */
const QUERY_SEQ =
  "printf '\\033[?1016$p\\033[?2027$p\\033[?2031$p\\033[?1004$p\\033[?2004$p" +
  "\\033[?2026$p\\033[?u\\033[c\\033[>0q\\033]10;?\\007\\033]11;?\\007'; " +
  "printf 'VT-%s\\n' OK; " +
  "printf '\\033[?1049h\\033[H\\033[2J'; printf 'ALT-SCREEN-PAINTED'; " +
  "printf '\\033[?1049l'; printf 'MAIN-%s\\n' OK";

const CMD = args.cmd || QUERY_SEQ;
const EXPECT = args.expect || (args.cmd ? args.cmd.split(/\s+/)[0] : 'VT-OK');
const EXPECT_ALT = args.cmd ? null : 'MAIN-OK';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      } else if (m.method) this.events.push(m);
    };
  }
  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = (this.seq += 1);
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const msg = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const p = msg.result || {};
    if (p.exceptionDetails) throw new Error(`页面内执行失败: ${p.exceptionDetails.text}`);
    return p.result ? p.result.value : undefined;
  }
}

(async () => {
  const port = 9700 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-vt-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1200,800',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
  };

  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch { /* 等待启动 */ }
      if (!ready) await sleep(150);
    }
    if (!ready) throw new Error('Chromium 未就绪');

    let target = null;
    for (let i = 0; i < 20 && !target; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' });
      if (res.ok) target = await res.json();
      else await sleep(200);
    }
    if (!target) throw new Error('无法创建页面');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await sleep(args.wait);

    await cdp.eval('window.__webterm__ && window.__webterm__.focusActive()');
    await sleep(300);

    // 用 insertText 一次性输入命令（比拼字符更贴近粘贴场景）
    await cdp.send('Input.insertText', { text: CMD });
    await sleep(200);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(args.after || 4000);

    const text = String(await cdp.eval('window.__webterm__ ? window.__webterm__.activeBufferText() : ""'));

    const exceptions = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);
    check('页面无未捕获异常（解析器未崩溃）', exceptions.length === 0,
      exceptions.slice(0, 1).join('').slice(0, 160));

    check(`终端在查询序列后仍能显示输出（${EXPECT}）`, text.includes(EXPECT),
      JSON.stringify(text.slice(-120)));
    if (EXPECT_ALT) {
      check(`alt-screen 往返后仍可继续输出（${EXPECT_ALT}）`, text.includes(EXPECT_ALT), '');
    }

    const shotDir = args.screenshot || path.join(process.cwd(), 'docs', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      const file = path.join(shotDir, args.name ? `${args.name}.png` : 'verify-vt.png');
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${file}`);
    }
    ws.close();
  } finally {
    kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.error('失败的检查：' + failed.map((c) => c.name).join('、'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
