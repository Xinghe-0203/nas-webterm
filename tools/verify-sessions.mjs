#!/usr/bin/env node
/**
 * 全量会话标签页 / 自动同步 / 关闭即回收 端到端验证（headless Chromium + CDP）
 *
 * 覆盖：
 *   1. 打开页面时，服务端已有的每个会话都出现在标签栏（包括不是本窗口创建的）；
 *   2. 页面打开后别的设备新建的会话，会自动出现在标签栏；
 *   3. 关闭标签页会 DELETE 服务端会话（PTY 进程与内存一起回收）；
 *   4. 关闭全部标签页后保持 0 个会话，空白页不偷偷新建 shell；
 *   5. 空白页点「新建会话」能正常创建。
 *
 * 用法：node tools/verify-sessions.mjs --url http://127.0.0.1:18220/app/nas-webterm/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { wait: 4500 };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const BASE = (args.url || 'http://127.0.0.1:18220/app/nas-webterm/').replace(/\/+$/, '');
const API = `${BASE}/api/sessions`;
const CHROME = args.chrome || process.env.CHROME_BIN || 'chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

async function apiSessions() {
  const res = await fetch(API, { cache: 'no-store' });
  const json = await res.json();
  return Array.isArray(json?.data) ? json.data : [];
}

async function createSession() {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cols: 120, rows: 32 }),
  });
  const json = await res.json();
  if (!json?.ok) throw new Error(`创建会话失败: ${JSON.stringify(json)}`);
  return json.data;
}

async function clearSessions() {
  const list = await apiSessions();
  for (const s of list) {
    await fetch(`${API}/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
  }
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

async function openPage(port) {
  let target = null;
  for (let i = 0; i < 30 && !target; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(BASE + '/')}`, {
      method: 'PUT',
    });
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
  return cdp;
}

async function tabCount(cdp) {
  return Number(await cdp.eval('window.__webterm__ ? window.__webterm__.tabCount : -1'));
}

(async () => {
  await clearSessions();
  for (let i = 0; i < 3; i += 1) await createSession();

  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sessions-'));
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

    const cdp = await openPage(port);
    await sleep(args.wait);

    check('已有 3 个服务端会话时，标签栏显示 3 个标签页', (await tabCount(cdp)) === 3,
      `tabs=${await tabCount(cdp)}`);

    const before = await apiSessions();
    const extra = await createSession();
    await sleep(3600);
    const after = await apiSessions();
    check('页面打开后其他设备新建的会话自动出现', (await tabCount(cdp)) === 4,
      `tabs=${await tabCount(cdp)}, api=${after.length}, new=${extra.id.slice(0, 12)}`);
    check('服务端会话数正确（3 + 1）', before.length === 3 && after.length === 4,
      `${before.length} → ${after.length}`);

    // 截图留档（此时 4 个标签页）
    const shotDir = args.screenshot || path.join(process.cwd(), 'docs', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      fs.writeFileSync(path.join(shotDir, 'verify-sessions.png'), Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${path.join(shotDir, 'verify-sessions.png')}`);
    }

    // 关掉第一个标签页 → 服务端应该少一个会话
    await cdp.eval("document.querySelector('.tab .close').click()");
    await sleep(2200);
    const afterClose = await apiSessions();
    check('关闭标签页会结束对应服务端会话', afterClose.length === 3,
      `api=${afterClose.length}`);
    check('关闭后标签页数量同步减少', (await tabCount(cdp)) === 3,
      `tabs=${await tabCount(cdp)}`);

    // 全部关闭 → 0 个标签、0 个服务端会话、显示空白页
    for (let i = 0; i < 6; i += 1) {
      const n = await tabCount(cdp);
      if (n === 0) break;
      await cdp.eval("document.querySelector('.tab .close').click()");
      await sleep(1500);
    }
    const empty = await apiSessions();
    check('全部标签页关闭后服务端 0 个会话', empty.length === 0, `api=${empty.length}`);
    check('全部关闭后标签数变为 0', (await tabCount(cdp)) === 0,
      `tabs=${await tabCount(cdp)}`);
    check('显示“没有打开的会话”空白页',
      await cdp.eval("document.getElementById('empty-state') && !document.getElementById('empty-state').hidden"),
      '');

    // 空白页新建会话
    await cdp.eval("document.getElementById('empty-new').click()");
    await sleep(2600);
    check('空白页新建会话可用', (await tabCount(cdp)) === 1 && (await apiSessions()).length === 1,
      `tabs=${await tabCount(cdp)}, api=${(await apiSessions()).length}`);

    // 清理
    await cdp.eval("document.querySelector('.tab .close').click()");
    await sleep(1800);
    await clearSessions();
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
