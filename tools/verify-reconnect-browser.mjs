#!/usr/bin/env node
/**
 * 浏览器级「关掉页面、过一会儿再打开」验证
 *
 * 完整复现用户场景：
 *   1. 打开页面，标签页里跑一个全屏 TUI 程序；
 *   2. 直接关掉整个页面（会话在服务端继续跑）；
 *   3. 等一段时间（让后台重绘字节堆积）；
 *   4. 重新打开页面 —— 标签页应自动恢复并接回原会话，TUI 界面要正确重建。
 *
 * 用法：
 *   node tools/verify-reconnect-browser.mjs --url http://127.0.0.1:18086/app/nas-webterm/ \
 *     --cmd "opencode" [--settle 12000]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { settle: 12000, cmd: 'opencode' };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}
const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm/').replace(/\/+$/, '');
const HTTP = BASE.replace(/^ws/, 'http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function newPage(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' });
  if (!res.ok) throw new Error('无法创建页面');
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, ws, id: target.id };
}

(async () => {
  const port = 9700 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rc-'));
  const chrome = spawn(
    process.env.CHROME_BIN || 'chromium',
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1280,800',
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
      } catch { /* 等待 */ }
      if (!ready) await sleep(150);
    }
    if (!ready) throw new Error('Chromium 未就绪');

    // ---- 第一次打开：跑起 TUI ----
    const p1 = await newPage(port);
    await sleep(5000);
    const sid = await p1.cdp.eval("window.__webterm__ ? window.__webterm__.activeSid : ''");
    check('首个标签页已建立会话', Boolean(sid), `sid=${sid}`);

    await p1.cdp.eval('window.__webterm__.focusActive()');
    await sleep(300);
    await p1.cdp.send('Input.insertText', { text: args.cmd });
    await sleep(200);
    await p1.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await p1.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(14000);

    const before = String(await p1.cdp.eval('window.__webterm__.activeBufferText()'));
    check('TUI 界面已绘制', before.length > 200, `${before.length} 字符`);
    // 备用屏幕由服务端判定（客户端拿不到原始字节流）
    const srv = await (await fetch(`${HTTP}/api/sessions`)).json();
    const s0 = (srv.data || []).find((s) => s.id === sid);
    check('服务端判定会话处于备用屏幕', Boolean(s0 && s0.alt_screen), `altScreen=${s0?.alt_screen}`);

    // ---- 关掉整个页面 ----
    await fetch(`http://127.0.0.1:${port}/json/close/${p1.id}`);
    p1.ws.close();
    await sleep(1500);
    const sessions = await (await fetch(`${HTTP}/api/sessions`)).json();
    check('页面关掉后服务端会话仍在', (sessions.data || []).some((s) => s.id === sid),
      `现有 ${(sessions.data || []).length} 个会话`);

    // ---- 等一段时间，让后台继续重绘 ----
    console.log(`  等待 ${Number(args.settle) / 1000}s 让后台继续重绘…`);
    await sleep(Number(args.settle));

    // ---- 重新打开页面 ----
    const p2 = await newPage(port);
    await sleep(9000);
    const after = String(await p2.cdp.eval('window.__webterm__ ? window.__webterm__.activeBufferText() : ""'));
    const sid2 = await p2.cdp.eval("window.__webterm__ ? window.__webterm__.activeSid : ''");

    check('重新打开后接回原会话', sid2 === sid, `${sid} vs ${sid2}`);
    check('重新打开后界面内容有效', after.length > 200, `${after.length} 字符`);
    check('重新打开后能识别出 TUI 界面', /opencode|build|agents|commands|%|CPU|MEM/i.test(after),
      JSON.stringify(after.slice(-100)));

    const csi = (after.match(/\x1b\[/g) || []).length;
    const done = (after.match(/\x1b\[[0-9;?]*[A-Za-z]/g) || []).length;
    check('没有半截转义序列（画面未被污染）', csi === done, `CSI=${csi} 完整=${done}`);

    const exceptions = p2.cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params?.exceptionDetails?.exception?.description);
    check('重新打开后无 JS 异常', exceptions.length === 0, String(exceptions[0] || '').slice(0, 120));

    const shot = await p2.cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      const dir = path.join(process.cwd(), 'docs', 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'reconnect-tui.png'), Buffer.from(shot.result.data, 'base64'));
      console.log('  截图：docs/screenshots/reconnect-tui.png');
    }

    p2.ws.close();
    await fetch(`${HTTP}/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {});
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
