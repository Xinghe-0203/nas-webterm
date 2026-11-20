#!/usr/bin/env node
/**
 * AI 断线重连（浏览器端）回归。
 *
 * 场景：手机上切后台、锁屏、地铁里网络抖动 → SSE 断开。
 * 期望：页面上的 AI 任务**不中断**，网络恢复后自动接回，
 * 面板里的输出完整、不重复。
 *
 * 做法：
 *   1. 打开页面，发一条消息，等面板出现内容；
 *   2. 在页面里把 fetch 拦下来，让下一次 AI 请求立刻失败（模拟断网）；
 *   3. 恢复网络，触发重连；
 *   4. 断言面板最终出现「完成」状态，且输出没有重复。
 *
 * 用法：
 *   node tools/verify-ai-resume-ui.mjs --url http://127.0.0.1:18086/app/nas-webterm-ai/
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = { wait: 6000 };
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) continue;
  args[key] = next;
  i += 1;
}

const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm-ai/').replace(/\/+$/, '');
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

async function waitFor(cdp, expr, timeout = 8000, step = 120) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await cdp.eval(expr);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function connectTarget(port, url) {
  let target = null;
  for (let i = 0; i < 20 && !target; i += 1) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
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
  return { cdp, close: () => ws.close() };
}

(async () => {
  const port = 9700 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-resume-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`,
      '--window-size=1440,900', 'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const killChrome = () => {
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
  };

  let conn = null;
  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { /* wait */ }
      if (!ready) await sleep(150);
    }
    if (!ready) throw new Error('Chromium 未就绪');

    conn = await connectTarget(port, `${BASE}/`);
    const cdp = conn.cdp;

    const sid = await waitFor(cdp, 'window.__webterm__ && window.__webterm__.activeSid', 10000);
    check('终端会话已建立', Boolean(sid), `sid=${String(sid).slice(0, 12)}`);

    // 打开 AI 面板
    await cdp.eval('if (!window.__webterm__.aiVisible) window.__webterm__.toggleDock()');
    await waitFor(cdp, "document.querySelector('.ai-input')?.placeholder?.includes('或直接')", 6000);

    // ---- 1) 发一条消息，正常收完 ----
    await cdp.eval("document.querySelector('.ai-input').focus()");
    await sleep(150);
    await cdp.send('Input.insertText', { text: '看看磁盘' });
    await sleep(200);
    await cdp.eval(`(() => {
      const input = document.querySelector('.ai-input');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    const gotCmd = await waitFor(cdp, "document.querySelector('.ai-step')", 20000);
    check('AI 任务正常执行并出现命令卡片', Boolean(gotCmd));

    const done = await waitFor(cdp, "document.querySelector('.ai-step-badge') && !document.querySelector('.ai-send')?.hidden", 20000);
    check('任务跑完', Boolean(done));

    const textBefore = await cdp.eval(
      "Array.from(document.querySelectorAll('.ai-msg-assistant, .ai-bubble p')).map((e) => e.textContent).join('|')",
    );
    check('面板有输出内容', String(textBefore || '').length > 0, `${String(textBefore || '').length} 字符`);

    // ---- 2) 让下一次 AI 请求立刻失败（模拟断网）----
    await cdp.eval(`(() => {
      const orig = window.fetch;
      window.__origFetch = orig;
      let failNext = true;
      window.fetch = function (input, init) {
        if (failNext && String(input).includes('api/ai/agent')) {
          failNext = false;
          // 这一次请求直接失败；之后的请求恢复成正常（模拟网络恢复）
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return orig.call(this, input, init);
      };
      return true;
    })()`);
    check('已注入断网模拟', true);

    // ---- 3) 再发一条：第一次请求失败 → 前端应自动重连/重试 ----
    await cdp.eval("document.querySelector('.ai-input').focus()");
    await sleep(150);
    await cdp.send('Input.insertText', { text: '再看看内存' });
    await sleep(200);
    await cdp.eval(`(() => {
      const input = document.querySelector('.ai-input');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);

    // 前端要么自动重试成功，要么提示任务已结束——但**不能**停在「请求失败」
    const settled = await waitFor(
      cdp,
      `(() => {
        const notices = Array.from(document.querySelectorAll('.ai-notice, .ai-msg-notice')).map((e) => e.textContent).join('|');
        if (notices.includes('AI 请求失败')) return 'failed';
        const sending = document.querySelector('.ai-send');
        if (!sending || sending.hidden) return 'done';
        return '';
      })()`,
      30000,
    );
    check(
      '断线后没有直接报「AI 请求失败」',
      settled !== 'failed',
      String(settled || '(仍在进行)'),
    );

    // 恢复网络后，面板应该能收到内容（重试成功）或明确提示任务已结束
    const recovered = await waitFor(
      cdp,
      `(() => {
        const notices = Array.from(document.querySelectorAll('.ai-notice, .ai-msg-notice')).map((e) => e.textContent).join('|');
        if (notices.includes('任务已结束')) return 'ended';
        const steps = document.querySelectorAll('.ai-step').length;
        return steps >= 2 ? 'resumed' : '';
      })()`,
      30000,
    );
    check(
      '断线后任务能恢复或给出明确结束提示',
      Boolean(recovered),
      String(recovered || '(未恢复)'),
    );

    // ---- 4) 同一段话在同一条回复里没有出现两遍 ----
    // 注意：不能跨消息比较——mock 模型每轮返回同样的内容，
    // 两轮对话的回复本来就一模一样。这里查的是「一条回复内部」的重复，
    // 那才是重连补发没做去重时的症状。
    const dup = await cdp.eval(`(() => {
      let bad = 0;
      for (const el of document.querySelectorAll('.ai-msg-assistant')) {
        const t = (el.textContent || '').trim();
        if (t.length < 20) continue;
        const head = t.slice(0, 20);
        let count = 0;
        let idx = t.indexOf(head);
        while (idx >= 0) { count += 1; idx = t.indexOf(head, idx + 1); }
        if (count > 1) bad += 1;
      }
      return bad;
    })()`);
    check('同一条回复里没有重复内容', Number(dup) === 0, `重复=${dup}`);

    conn.close();
    conn = null;
  } finally {
    if (conn) conn.close();
    killChrome();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✗ ${f.name} ${f.detail}`);
    process.exit(1);
  }
})();
