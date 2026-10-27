#!/usr/bin/env node
/**
 * 前端泄漏验证：反复新建/关闭标签页，观察 JS 堆、DOM 节点数、终端实例数。
 *
 * 关掉标签页后，xterm 实例、ResizeObserver、DOM 容器都应被释放，
 * 不能随着操作次数线性堆积。
 *
 * 用法：node tools/verify-front-leaks.mjs --url http://127.0.0.1:18086/app/nas-webterm/ [--rounds 30]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { rounds: 30, wait: 4000 };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}
const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm/').replace(/\/+$/, '');
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
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
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
  async eval(expr) {
    const msg = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const p = msg.result || {};
    if (p.exceptionDetails) throw new Error(`页面内执行失败: ${p.exceptionDetails.text}`);
    return p.result ? p.result.value : undefined;
  }
}

const PROBE = `(() => {
  const app = window.__webterm__;
  const m = performance.memory || {};
  return JSON.stringify({
    heap: m.usedJSHeapSize || 0,
    heapLimit: m.jsHeapSizeLimit || 0,
    domNodes: document.getElementsByTagName('*').length,
    xtermNodes: document.querySelectorAll('.xterm').length,
    panes: document.querySelectorAll('.pane').length,
    tabs: document.querySelectorAll('.tab').length,
    appTabs: app ? app.tabCount : -1,
  });
})()`;

(async () => {
  const port = 9600 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-fl-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-precise-memory-info',
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

    // 清掉上次会话遗留的标签页，只留一个
    await cdp.eval(`(() => {
      const app = window.__webterm__;
      const extra = app ? app.tabCount - 1 : 0;
      for (let i = 0; i < extra; i += 1) {
        const btn = document.querySelectorAll('.tab .close')[1];
        if (btn) btn.click();
      }
      return true;
    })()`);
    await sleep(1500);

    const before = JSON.parse(await cdp.eval(PROBE));
    console.log(`基线：heap=${(before.heap / 1048576).toFixed(2)}MB dom=${before.domNodes} xterm=${before.xtermNodes} tabs=${before.appTabs}`);

    const rounds = Number(args.rounds);
    for (let i = 0; i < rounds; i += 1) {
      // 新建
      await cdp.eval("document.getElementById('newtab').click()");
      await sleep(700);
      // 关掉刚建的那个（保留第一个）
      await cdp.eval(`(() => {
        const list = document.querySelectorAll('.tab .close');
        if (list.length > 1) list[list.length - 1].click();
        return true;
      })()`);
      await sleep(350);
    }
    // 强制回收一次，确认释放路径可用
    await cdp.eval('if (window.gc) window.gc()');
    await sleep(2500);

    const after = JSON.parse(await cdp.eval(PROBE));
    console.log(`结束：heap=${(after.heap / 1048576).toFixed(2)}MB dom=${after.domNodes} xterm=${after.xtermNodes} tabs=${after.appTabs}`);

    const heapGrowthMb = (after.heap - before.heap) / 1048576;
    check('标签页已归位（只剩 1 个）', after.appTabs === 1, `tabs=${after.appTabs}`);
    check('xterm 实例已释放', after.xtermNodes === before.xtermNodes, `${before.xtermNodes} → ${after.xtermNodes}`);
    check('DOM 节点数未累积', after.domNodes - before.domNodes <= 5, `${before.domNodes} → ${after.domNodes}`);
    check('JS 堆未随操作次数线性增长', heapGrowthMb < 6, `增长 ${heapGrowthMb.toFixed(2)}MB / ${rounds} 轮`);

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
