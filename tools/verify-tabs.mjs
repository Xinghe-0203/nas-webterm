#!/usr/bin/env node
/**
 * 多标签页 / 断线重连 端到端验证（headless Chromium + CDP）
 *
 * 覆盖：
 *   1. 首次打开只有一个标签页，且拿到真实 shell 提示符；
 *   2. 新建标签页 → 标签数增加，各标签页是独立 PTY；
 *   3. 在不同标签页执行不同命令，输出互不串扰；
 *   4. 刷新页面 → 标签页恢复、且历史输出被回放（断线重连）；
 *   5. 关闭标签页 → 标签数减少，服务端会话被回收。
 *
 * 用法：node tools/verify-tabs.mjs --url http://127.0.0.1:18099/app/nas-webterm/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { wait: 6000 };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const BASE = (args.url || 'http://127.0.0.1:18099/app/nas-webterm/').replace(/\/+$/, '');
const CHROME = args.chrome || process.env.CHROME_BIN || 'chromium';
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
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    };
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = (this.seq += 1);
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const msg = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const payload = msg.result || {};
    if (payload.exceptionDetails) {
      throw new Error(`页面内执行失败: ${JSON.stringify(payload.exceptionDetails).slice(0, 300)}`);
    }
    return payload.result ? payload.result.value : undefined;
  }
}

async function typeText(cdp, text) {
  for (const ch of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(12);
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}

async function openPage(port) {
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
  return { cdp, ws, targetId: target.id };
}

(async () => {
  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-tabs-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1280,820',
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
      } catch { /* 还没起来 */ }
      if (!ready) await sleep(150);
    }
    if (!ready) throw new Error('Chromium 未就绪');

    const { cdp } = await openPage(port);
    await sleep(args.wait);

    // 1) 初始状态
    const initial = JSON.parse(
      await cdp.eval(`(() => {
        const app = window.__webterm__;
        return JSON.stringify({ tabs: app ? app.tabCount : -1, text: app ? app.activeBufferText() : '' });
      })()`),
    );
    check('首次打开只有 1 个标签页', initial.tabs === 1, `tabs=${initial.tabs}`);
    check('shell 已就绪（出现提示符）', /\$|#/.test(initial.text), JSON.stringify(initial.text.slice(-60)));

    // 2) 第一个标签页执行命令
    await cdp.eval('window.__webterm__.focusActive()');
    await sleep(200);
    await typeText(cdp, 'echo TAB-ONE');
    await sleep(900);

    // 3) 新建标签页
    await cdp.eval("document.getElementById('newtab').click()");
    await sleep(2500);
    const afterNew = JSON.parse(
      await cdp.eval(`JSON.stringify({ tabs: window.__webterm__.tabCount, text: window.__webterm__.activeBufferText() })`),
    );
    check('新建标签页后变为 2 个', afterNew.tabs === 2, `tabs=${afterNew.tabs}`);
    check('新标签页是独立会话（不含上一个标签的输出）', !afterNew.text.includes('TAB-ONE'),
      JSON.stringify(afterNew.text.slice(-60)));

    await cdp.eval('window.__webterm__.focusActive()');
    await sleep(200);
    await typeText(cdp, 'echo TAB-TWO');
    await sleep(900);
    const tab2 = await cdp.eval('window.__webterm__.activeBufferText()');
    check('第二个标签页可执行命令', tab2.includes('TAB-TWO'), JSON.stringify(tab2.slice(-60)));

    // 4) 切回第一个标签页，确认内容隔离
    await cdp.eval("document.querySelectorAll('.tab')[0].click()");
    await sleep(800);
    const tab1 = await cdp.eval('window.__webterm__.activeBufferText()');
    check('切回第一个标签页仍保留自己的输出', tab1.includes('TAB-ONE'), '');
    check('第一个标签页不含第二个标签页的输出', !tab1.includes('TAB-TWO'), '');

    const sessions = JSON.parse(await cdp.eval(`fetch('${new URL('./api/sessions', BASE + '/')}', { cache: 'no-store' }).then((r) => r.text())`));
    check('服务端存在 2 个 PTY 会话', Array.isArray(sessions.data) && sessions.data.length === 2,
      `sessions=${Array.isArray(sessions.data) ? sessions.data.length : '?'}`);

    // 5) 刷新页面：标签页恢复 + 输出回放
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(args.wait + 2000);
    const restored = JSON.parse(
      await cdp.eval(`(() => {
        const app = window.__webterm__;
        return JSON.stringify({ tabs: app ? app.tabCount : -1, text: app ? app.activeBufferText() : '' });
      })()`),
    );
    check('刷新后标签页数量恢复', restored.tabs === 2, `tabs=${restored.tabs}`);
    check('刷新后历史输出被回放（断线重连）', restored.text.includes('TAB-ONE'),
      JSON.stringify(restored.text.slice(-80)));

    // 6) 关闭一个标签页
    await cdp.eval("document.querySelectorAll('.tab .close')[1].click()");
    await sleep(1500);
    const afterClose = JSON.parse(
      await cdp.eval(`JSON.stringify({ tabs: window.__webterm__.tabCount })`),
    );
    check('关闭标签页后剩 1 个', afterClose.tabs === 1, `tabs=${afterClose.tabs}`);

    const sessions2 = JSON.parse(await cdp.eval(`fetch('${new URL('./api/sessions', BASE + '/')}', { cache: 'no-store' }).then((r) => r.text())`));
    check('关闭后服务端会话被回收', Array.isArray(sessions2.data) && sessions2.data.length === 1,
      `sessions=${Array.isArray(sessions2.data) ? sessions2.data.length : '?'}`);

    // 截图留档
    const shotDir = args.screenshot || path.join(process.cwd(), 'docs', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      fs.writeFileSync(path.join(shotDir, 'verify-tabs.png'), Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${path.join(shotDir, 'verify-tabs.png')}`);
    }
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
})().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
