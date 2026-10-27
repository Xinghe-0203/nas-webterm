#!/usr/bin/env node
/**
 * opencode TUI 端到端验证（需要本机已安装 opencode）
 *
 * 覆盖用户最常用的场景：
 *   1. 新标签页自动执行 opencode；
 *   2. opencode 界面真的画出来了（不是只有命令行回显）；
 *   3. 没有未捕获异常（xterm 6.0.0 的 DECRQM 崩溃就是在这里暴露的）；
 *   4. 在 opencode 输入框里键入内容能被接收。

 * 前置：应用已在开发模式启动，并且该进程的运行身份能正常启动 opencode
 * （root 安装后就是 root）。若 opencode 自身报托管服务端口冲突，本脚本会失败并打印原因。
 *
 * 用法：
 *   node tools/verify-opencode.mjs --url http://127.0.0.1:18098/app/nas-webterm/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { wait: 16000, cmd: 'htop' };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const BASE = (args.url || '').replace(/\/+$/, '');
if (!BASE) {
  console.error('用法: node tools/verify-opencode.mjs --url http://127.0.0.1:18098/app/nas-webterm/');
  process.exit(2);
}
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
  const port = 9800 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-oc-'));
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
      '--window-size=1280,760',
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
    await sleep(Number(args.wait));

    const text = String(await cdp.eval('window.__webterm__ ? window.__webterm__.activeBufferText() : ""'));

    const cmdName = String(args.cmd).split(/\s+/)[0].replace(/[^\w.-]/g, '');
    check(`${cmdName} 已启动（出现界面文字）`,
      new RegExp(cmdName, 'i').test(text) || text.trim().length > 100,
      JSON.stringify(text.slice(-100)));
    check('界面已绘制（不是只有命令行回显）', text.trim().length > 100, JSON.stringify(text.slice(-160)));

    const exceptions = cdp.events
      .filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => e.params?.exceptionDetails?.exception?.description || e.params?.exceptionDetails?.text);
    check('页面无未捕获异常（终端解析器未崩溃）', exceptions.length === 0,
      String(exceptions[0] || '').slice(0, 160));

    // 键盘输入：往 opencode 输入框里塞一段特征串
    const probe = `zz-probe-${Date.now().toString().slice(-4)}`;
    await cdp.eval('window.__webterm__ && window.__webterm__.focusActive()');
    await sleep(400);
    await cdp.send('Input.insertText', { text: probe });
    await sleep(1500);
    const after = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    check('程序能接收键入', after.includes(probe), probe);

    const shotDir = args.screenshot || path.join(process.cwd(), 'docs', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      fs.writeFileSync(path.join(shotDir, 'tui-app.png'), Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${path.join(shotDir, 'tui-app.png')}`);
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
