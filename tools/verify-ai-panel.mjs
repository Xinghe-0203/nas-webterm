#!/usr/bin/env node
/**
 * AI 聊天框端到端验证（headless Chromium + CDP）。
 *
 * 覆盖：
 *   1. 终端输入不再触发 AI（中文也原样进 shell）；AI 只能从面板输入框发起；
 *   2. 命令卡片折叠 / 展开，卡片里能看到命令与本次输出；
 *   3. Markdown 表格渲染成 HTML，协议标签（<execute_command>）一个都不露面；
 *   4. 框里的输入框可以直接发消息（回车发送）；
 *   5. 「新对话」清空消息。
 *
 * 前置：应用以开发模式启动（tools/dev.sh），AI 配置指向 tools/mock-ai.mjs
 * （或 tools/mock-ai-leak.mjs，用来复核单行标签不漏）。
 *
 * 用法：node tools/verify-ai-panel.mjs --url http://127.0.0.1:18120/app/nas-webterm/
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

const BASE = (args.url || 'http://127.0.0.1:18120/app/nas-webterm/').replace(/\/+$/, '');
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
    await sleep(10);
  }
}

async function press(cdp, key, code = 'Enter', keyCode = 13) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
  });
}


/** 在面板输入框里输入并发送（用页面内 KeyboardEvent，避开 headless 下 CDP 回车丢失） */
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

async function waitFor(cdp, expr, timeout = 8000, step = 120) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = await cdp.eval(expr);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

(async () => {
  const port = 9700 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ai-'));
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
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
  };

  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { /* wait */ }
      if (!ready) await sleep(150);
    }
    if (!ready) throw new Error('Chromium 未就绪');

    let target = null;
    for (let i = 0; i < 20 && !target; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(BASE + '/')}`, { method: 'PUT' });
      if (res.ok) target = await res.json(); else await sleep(200);
    }
    if (!target) throw new Error('无法创建页面');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const sid = await waitFor(cdp, 'window.__webterm__ && window.__webterm__.activeSid', 10000);
    check('终端会话已建立', Boolean(sid), `sid=${String(sid).slice(0, 12)}`);
    await sleep(800);

    // ---- 1. 顶部不再有 AI 按钮与 logo ----
    const noTopAi = await cdp.eval(
      "!document.getElementById('ai-toggle') && !document.querySelector('.ai-mark') && !document.querySelector('.ai-head-title')",
    );
    check('顶栏与聊天框里都不再有 AI 图标/标题', noTopAi === true);

    // AI 版默认展开面板（终端不再是入口）。先收起，验证终端输入不会把它弹开。
    await cdp.eval('if (window.__webterm__.aiVisible) window.__webterm__.toggleDock()');
    await sleep(400);
    check('面板可以收起', (await cdp.eval('window.__webterm__.aiVisible')) === false);

    // ---- 2. 普通命令不触发 AI ----
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, 'echo plain-cmd-marker');
    await press(cdp);
    const plain = await waitFor(cdp, "window.__webterm__.activeBufferText().includes('plain-cmd-marker')", 6000);
    check('普通命令进入 shell', Boolean(plain));
    check('普通命令不弹聊天框', (await cdp.eval('window.__webterm__.aiVisible')) === false);

    // ---- 3. 终端不再拦截自然语言：中文原样进 shell ----
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, '帮我看看磁盘');
    await press(cdp);
    await sleep(1200);
    const termChinese = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    check('终端里输入中文仍交给 shell（不再弹 AI）', termChinese.includes('帮我看看磁盘'));
    check('终端输入不自动打开聊天框', (await cdp.eval('window.__webterm__.aiVisible')) === false);

    // 打开面板（AI 版唯一入口：面板输入框）
    await cdp.eval('window.__webterm__.toggleDock()');
    await sleep(600);
    const visible = await waitFor(cdp, 'window.__webterm__.aiVisible', 5000);
    check('面板可以手动打开', visible === true);

    // 从面板输入框提交（等就绪提示出现后再输入，避免抢在配置加载前提交）
    await waitFor(
      cdp,
      "document.querySelector('.ai-input')?.placeholder?.includes('或直接')",
      6000,
    );
    const submitted = await sendFromPanel(cdp, '帮我看看磁盘');
    check('面板输入框能发送消息', submitted === true);

    const floating = await cdp.eval(`(() => {
      const el = document.getElementById('ai-dock');
      const r = el.getBoundingClientRect();
      const w = el.parentElement.getBoundingClientRect();
      const pos = getComputedStyle(el).position;
      const backdrop = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter;
      return JSON.stringify({
        pos,
        right: Math.round(w.right - r.right),
        bottom: Math.round(w.bottom - r.bottom),
        w: Math.round(r.width),
        backdrop,
      });
    })()`);
    const geo = JSON.parse(String(floating));
    // 相对「工作区」而不是整个窗口：状态栏占掉底部 26px，是设计而不是偏移
    check(
      '聊天框浮在工作区右下角',
      geo.pos === 'absolute' && geo.right <= 24 && geo.bottom <= 24,
      JSON.stringify(geo),
    );
    check('聊天框是半透明玻璃（有 backdrop-filter）', String(geo.backdrop).includes('blur'), geo.backdrop);

    const md = await waitFor(
      cdp,
      "document.querySelector('.ai-md') && document.querySelector('.ai-md').textContent.includes('先看整体使用率')",
      8000,
    );
    check('AI 说明文字渲染在聊天框里', Boolean(md));

    const termText = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    check('终端里不再出现 AI 文字', !termText.includes('磁盘占用') && !termText.includes('execute_command'));

    // ---- 4. 命令卡片 ----
    const card = await waitFor(cdp, "document.querySelector('.ai-step')", 8000);
    check('生成命令卡片', Boolean(card));
    const label = String(await cdp.eval("document.querySelector('.ai-step-label')?.textContent || ''"));
    check('卡片标题是「AI 正在执行」', label.includes('执行') || label.includes('请求'), `label=${label}`);
    const collapsed = await cdp.eval("document.querySelector('.ai-step-body')?.hidden === true");
    check('命令默认折叠', collapsed === true || collapsed === null);

    // 展开并等输出。headless 下点击可能赶上卡片刚被创建、还在切换状态，
    // 这里点一次、确认展开，没展开就再点，避免测试自身的时序问题。
    let expanded = false;
    for (let attempt = 0; attempt < 4 && !expanded; attempt += 1) {
      const hidden = await cdp.eval("document.querySelector('.ai-step-body')?.hidden");
      if (hidden === true) await cdp.eval("document.querySelector('.ai-step-head').click()");
      await sleep(250);
      expanded = (await cdp.eval("document.querySelector('.ai-step-body')?.hidden === false")) === true;
    }
    const bodyText = String(
      await cdp.eval("(() => { const b = document.querySelector('.ai-step-body'); return b ? b.textContent : ''; })()"),
    );
    check('展开后显示命令', expanded && bodyText.includes('df -h'), bodyText.slice(0, 60));

    const output = await waitFor(
      cdp,
      "(() => { const o = document.querySelector('.ai-step-output'); return o && !o.hidden && o.textContent.length > 0; })()",
      20000,
    );
    if (!output) {
      const diag = await cdp.eval(`JSON.stringify({
        state: document.querySelector('.ai-step')?.dataset.state,
        outputHidden: document.querySelector('.ai-step-output')?.hidden,
        outputLen: document.querySelector('.ai-step-output')?.textContent?.length ?? -1,
        bodyHidden: document.querySelector('.ai-step-body')?.hidden,
      })`);
      check('展开后显示命令输出', false, String(diag));
    } else {
      check('展开后显示命令输出', true);
    }

    // ---- 5. 协议标签一个都不露面 ----
    const panelText = String(await cdp.eval("document.getElementById('ai-dock').innerText"));
    check(
      '界面里没有协议标签',
      !panelText.includes('execute_command') && !panelText.includes('requires_approval'),
    );

    const table = await waitFor(cdp, 'Boolean(document.querySelector(".ai-md .md-table"))', 15000);
    check('Markdown 表格渲染成 HTML', Boolean(table));

    // ---- 5b. 展开的命令卡片不能被后续输出顶出屏幕 ----
    // 这是 1.1.1 报过的问题：卡片展开后模型继续吐长文本，自动贴底滚动把卡片
    // 刷到视口上方，只剩一条标题线。现在展开卡片时不再自动贴底，标题行 sticky。
    const layout = async () =>
      JSON.parse(
        String(
          await cdp.eval(`(() => {
            const card = document.querySelector('.ai-step');
            const head = card?.querySelector('.ai-step-head');
            const body = card?.querySelector('.ai-step-body');
            const thread = document.querySelector('.ai-thread');
            if (!card || !head || !body || !thread) return JSON.stringify({ ok: false });
            const view = thread.getBoundingClientRect();
            const hb = head.getBoundingClientRect();
            return JSON.stringify({
              ok: true,
              expanded: !body.hidden,
              headVisible: hb.top >= view.top - 1 && hb.bottom <= view.bottom + 1,
              headTop: Math.round(hb.top - view.top),
            });
          })()`),
        ),
      );
    const before = await layout();
    check('卡片展开后停在视口内', before.ok && before.headVisible, JSON.stringify(before));

    // 再等这一轮彻底结束（长文本已经吐完）
    const done = await waitFor(cdp, "document.querySelector('.ai-send')?.hidden === false", 20000);
    await sleep(600);
    const after = await layout();
    check(
      '模型继续输出后卡片标题仍在视口内',
      Boolean(done) && after.ok && after.headVisible,
      JSON.stringify(after),
    );

    // ---- 6. 框里的输入框能发消息 ----
    // 先等这一轮彻底结束（状态点回到待命、发送按钮出现），否则会撞上「上一条还在进行」
    const idle = await waitFor(cdp, "document.querySelector('.ai-send')?.hidden === false", 10000);
    check('任务结束后发送按钮恢复', Boolean(idle));
    await cdp.eval("document.querySelector('.ai-input').focus()");
    await sleep(200);
    await cdp.send('Input.insertText', { text: '再看一下进程占用' });
    const typedValue = String(await cdp.eval("document.querySelector('.ai-input')?.value || ''"));
    check('输入框能接收文字', typedValue.includes('进程占用'), JSON.stringify(typedValue));

    // headless Chromium 偶尔会丢掉第一下回车（焦点刚被 JS 抢过来时），
    // 这里重试几次再判定，避免把「测试环境偶发」当成功能缺陷。
    let sent = false;
    for (let attempt = 0; attempt < 4 && !sent; attempt += 1) {
      await cdp.eval("document.querySelector('.ai-input')?.focus()");
      if (attempt === 0) await press(cdp);
      else await cdp.eval(`(() => {
        const i = document.querySelector('.ai-input');
        i?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      })()`);
      sent = Boolean(
        await waitFor(
          cdp,
          "(() => { const u = [...document.querySelectorAll('.ai-user-text')]; return u.length >= 2; })()",
          1500,
          100,
        ),
      );
    }
    if (!sent) {
      const diag = await cdp.eval(`JSON.stringify({
        value: document.querySelector('.ai-input')?.value,
        notices: [...document.querySelectorAll('.ai-notice')].map((n) => n.textContent),
        users: document.querySelectorAll('.ai-user-text').length,
        status: document.querySelector('.ai-state-text')?.textContent,
      })`);
      check('输入框可以直接发消息', false, String(diag));
    } else {
      check('输入框可以直接发消息', true);
    }

    // ---- 7. 新对话 ----
    await cdp.eval("document.querySelector('#ai-panel-new').click()");
    await sleep(400);
    check('新对话清空消息', (await cdp.eval("document.querySelectorAll('.ai-msg').length === 0")) === true);

    // ---- 截图 ----
    if (args.screenshot) {
      await cdp.eval("document.querySelector('.ai-input').focus()");
      await typeText(cdp, '帮我看看磁盘');
      await press(cdp);
      await waitFor(cdp, 'Boolean(document.querySelector(".ai-step-output:not([hidden])"))', 15000);
      await sleep(1500);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const data = shot.result?.data ?? '';
      if (data) {
        fs.writeFileSync(args.screenshot, Buffer.from(data, 'base64'));
        check('截图已保存', true, args.screenshot);
      }
    }
  } catch (e) {
    check('执行过程无异常', false, String(e).slice(0, 200));
  } finally {
    kill();
    await sleep(200);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n结果：${checks.length - failed}/${checks.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
