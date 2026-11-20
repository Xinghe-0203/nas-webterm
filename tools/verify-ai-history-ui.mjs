#!/usr/bin/env node
/**
 * AI 聊天记录（UI）端到端验证（headless Chromium + CDP）。
 *
 * 覆盖：
 *   1. 面板顶部有「聊天记录」按钮，点开能看到会话列表；
 *   2. 列表显示标题 / 时间 / 轮数 / 摘要；
 *   3. 点一条会话 → 回显到面板（用户气泡 + 助手文字 + 命令卡片），并关闭弹窗；
 *   4. **刷新页面后，上一次的对话自动恢复**（这是以前完全丢历史的地方）；
 *   5. 删除会话后列表变空、面板清空；
 *   6. 「清空全部记录」需要二次确认，避免误点。
 *
 * 前置：应用以开发模式启动，AI 配置指向 tools/mock-ai.mjs。
 *
 * 用法：node tools/verify-ai-history-ui.mjs --url http://127.0.0.1:18120/app/nas-webterm-ai/
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

const BASE = (args.url || 'http://127.0.0.1:18120/app/nas-webterm-ai/').replace(/\/+$/, '');
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

/** 在面板输入框里输入并发送。 */
async function sendFromPanel(cdp, text) {
  await cdp.eval("document.querySelector('.ai-input').focus()");
  await sleep(200);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  for (let i = 0; i < 3; i += 1) {
    await cdp.eval(`(() => {
      const input = document.querySelector('.ai-input');
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(400);
    const cleared = (await cdp.eval("document.querySelector('.ai-input')?.value")) === '';
    if (cleared) return true;
  }
  return false;
}

/** 打开一个 CDP 目标并返回连接。 */
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
  const port = 9600 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hist-'));
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

    // 先清空服务端历史，保证断言从干净状态开始
    await fetch(`${BASE}/api/ai/history`, { method: 'DELETE' });

    conn = await connectTarget(port, `${BASE}/`);
    let cdp = conn.cdp;

    // 清掉浏览器里记住的会话 id：否则页面加载时会自动把上一次的
    // 会话恢复出来，列表里就多了一条，断言「只有 1 条」会失败。
    await cdp.eval("try { localStorage.removeItem('nas-webterm.aiConversation'); } catch (e) {}");
    await cdp.eval('location.reload()');
    await sleep(1500);

    const sid = await waitFor(cdp, 'window.__webterm__ && window.__webterm__.activeSid', 10000);
    check('终端会话已建立', Boolean(sid), `sid=${String(sid).slice(0, 12)}`);

    // 打开面板并等配置就绪
    await cdp.eval('if (!window.__webterm__.aiVisible) window.__webterm__.toggleDock()');
    await waitFor(
      cdp,
      "document.querySelector('.ai-input')?.placeholder?.includes('或直接')",
      6000,
    );

    // 面板顶部有「聊天记录」按钮
    const hasBtn = await cdp.eval("Boolean(document.getElementById('ai-panel-history'))");
    check('面板顶部有「聊天记录」按钮', hasBtn === true);

    // ---- 跑一轮对话 ----
    check('面板输入框能发送消息', (await sendFromPanel(cdp, '帮我看看磁盘')) === true);
    await waitFor(cdp, "document.querySelector('.ai-send')?.hidden === false", 20000);
    await sleep(400);

    const bubbleCount = await cdp.eval(
      "document.querySelectorAll('.ai-msg-user').length",
    );
    check('面板里有用户消息', Number(bubbleCount) >= 1, `count=${bubbleCount}`);

    // ---- 打开聊天记录 ----
    await cdp.eval("document.getElementById('ai-panel-history').click()");
    const listOpen = await waitFor(
      cdp,
      "document.getElementById('ai-history-dialog')?.open === true",
      5000,
    );
    check('点「聊天记录」能打开弹窗', listOpen === true);

    const itemCount = await waitFor(
      cdp,
      "document.querySelectorAll('#ai-history-list .ai-history-item').length",
      8000,
    );
    check('列表里出现刚聊过的会话', Number(itemCount) >= 1, `count=${itemCount}`);

    const title = String(
      await cdp.eval(
        "document.querySelector('#ai-history-list .ai-history-title')?.textContent || ''",
      ),
    );
    check('列表标题是用户第一句话', title === '帮我看看磁盘', title);

    const meta = String(
      await cdp.eval(
        "document.querySelector('#ai-history-list .ai-history-meta')?.textContent || ''",
      ),
    );
    check('列表显示时间和轮数', meta.includes('轮'), meta);

    const preview = String(
      await cdp.eval(
        "document.querySelector('#ai-history-list .ai-history-preview')?.textContent || ''",
      ),
    );
    check('列表显示摘要', preview.length > 0, preview.slice(0, 40));

    // ---- 点开会话 ----
    await cdp.eval("document.querySelector('#ai-history-list .ai-history-open').click()");
    const closed = await waitFor(
      cdp,
      "document.getElementById('ai-history-dialog')?.open === false",
      5000,
    );
    check('点会话后弹窗关闭', closed === true);

    const restoredUser = await waitFor(
      cdp,
      "Array.from(document.querySelectorAll('.ai-msg-user')).some((el) => el.textContent.includes('帮我看看磁盘'))",
      5000,
    );
    check('会话回显到面板：用户消息', Boolean(restoredUser));

    const restoredCard = await waitFor(cdp, "document.querySelector('.ai-step')", 5000);
    check('会话回显到面板：命令卡片', Boolean(restoredCard));

    const cardLabel = String(
      await cdp.eval("document.querySelector('.ai-step-label')?.textContent || ''"),
    );
    check('历史卡片是只读的「已执行」', cardLabel.includes('已执行'), cardLabel);

    const historyActions = await cdp.eval(
      "document.querySelectorAll('.ai-step-actions').length",
    );
    check('历史卡片没有审批按钮', Number(historyActions) === 0, `count=${historyActions}`);

    // ---- 刷新页面：历史自动恢复 ----
    await cdp.eval('location.reload()');
    await sleep(1200);
    // 重连后 CDP target 不变，但页面上下文已换
    const restoredAfterReload = await waitFor(
      cdp,
      "Array.from(document.querySelectorAll('.ai-msg-user')).some((el) => el.textContent.includes('帮我看看磁盘'))",
      15000,
    );
    check('刷新页面后对话自动恢复', Boolean(restoredAfterReload));

    const restoredCardAfterReload = await waitFor(cdp, "document.querySelector('.ai-step')", 8000);
    check('刷新后命令卡片也恢复', Boolean(restoredCardAfterReload));

    // 续聊：发一条新消息，应该追加到同一条记录里（轮数变 2）
    await cdp.eval('if (!window.__webterm__.aiVisible) window.__webterm__.toggleDock()');
    await waitFor(
      cdp,
      "document.querySelector('.ai-input')?.placeholder?.includes('或直接')",
      6000,
    );
    await sendFromPanel(cdp, '那内存呢');
    await waitFor(cdp, "document.querySelector('.ai-send')?.hidden === false", 20000);
    await sleep(400);

    const list = await (await fetch(`${BASE}/api/ai/history`)).json();
    const items = list?.data?.items ?? [];
    check('续聊后仍是一条会话', items.length === 1, `count=${items.length}`);
    check('续聊后轮数变成 2', items[0]?.turns === 2, String(items[0]?.turns));

    // ---- 删除记录 ----
    await cdp.eval("document.getElementById('ai-panel-history').click()");
    await waitFor(cdp, "document.getElementById('ai-history-dialog')?.open === true", 5000);
    await waitFor(
      cdp,
      "document.querySelector('#ai-history-list .ai-history-delete')",
      6000,
    );
    await cdp.eval("document.querySelector('#ai-history-list .ai-history-delete').click()");
    await waitFor(
      cdp,
      "document.querySelectorAll('#ai-history-list .ai-history-item').length === 0",
      6000,
    );
    const emptyText = String(
      await cdp.eval("document.getElementById('ai-history-status')?.textContent || ''"),
    );
    check('删除后列表为空并提示', emptyText.includes('还没有'), emptyText);

    const clearedPanel = await cdp.eval(
      "document.querySelectorAll('.ai-msg-user').length === 0",
    );
    check('删除当前会话后面板清空', clearedPanel === true);

    // ---- 清空按钮的二次确认 ----
    await cdp.eval("document.getElementById('ai-history-clear').click()");
    await sleep(150);
    const armedText = String(
      await cdp.eval("document.getElementById('ai-history-clear')?.textContent || ''"),
    );
    check('清空按钮第一次点击只提示确认', armedText.includes('再点一次'), armedText);
    await cdp.eval("document.getElementById('ai-history-clear').click()");
    await sleep(300);
    const resetText = String(
      await cdp.eval("document.getElementById('ai-history-clear')?.textContent || ''"),
    );
    check('第二次点击执行清空并恢复按钮文字', resetText.includes('清空全部记录'), resetText);

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
