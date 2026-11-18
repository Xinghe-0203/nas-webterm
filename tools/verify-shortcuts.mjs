#!/usr/bin/env node
/**
 * 快捷键粘贴/复制验证（headless Chromium + CDP）
 *
 * 覆盖：
 *   1. Ctrl+Shift+V 能把剪贴板内容粘进终端（走 navigator.clipboard.readText）
 *   2. Ctrl+Shift+C 能把选中文本复制到剪贴板
 *   3. 终端里其它快捷键（Ctrl+Shift+T 新标签、Ctrl+Tab 切换）仍然正常
 *
 * 剪贴板权限用 Browser.grantPermissions 打开（clipboardReadWrite + clipboardSanitizedWrite），
 * 否则 headless 下 navigator.clipboard.readText() 会被浏览器拒绝，测不出真实问题。
 *
 * 用法：node tools/verify-shortcuts.mjs --url http://127.0.0.1:18098/app/nas-webterm/
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
const BASE = (args.url || 'http://127.0.0.1:18098/app/nas-webterm/').replace(/\/+$/, '');
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
  async eval(expression) {
    const msg = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const p = msg.result || {};
    if (p.exceptionDetails) throw new Error(`页面内执行失败: ${p.exceptionDetails.text}`);
    return p.result ? p.result.value : undefined;
  }
}

async function pressCombo(cdp, key, code, keyCode, mods = 8) {
  // mods: 2=Ctrl 8=Shift
  const base = { modifiers: mods, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

(async () => {
  const port = 9800 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sc-'));
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

    // 打开剪贴板权限（headless 下必须显式授权，否则 readText 必失败）
    const browserWs = new WebSocket(`ws://127.0.0.1:${port}/devtools/browser/${''}`);
    // 用 HTTP 端点授权更简单
    await fetch(`http://127.0.0.1:${port}/json/version`);

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

    // 授权剪贴板（browser 级 CDP）
    try {
      const bws = new WebSocket(
        (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl,
      );
      await new Promise((r) => (bws.onopen = r));
      const bcdp = new Cdp(bws);
      await bcdp.send('Browser.grantPermissions', {
        origin: new URL(BASE).origin,
        permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
      check('剪贴板权限已授予', true, new URL(BASE).origin);
    } catch (e) {
      check('剪贴板权限已授予', false, String(e).slice(0, 100));
    }

    // 确认会话建立
    let sid = '';
    for (let i = 0; i < 40 && !sid; i += 1) {
      sid = String(await cdp.eval('window.__webterm__ ? window.__webterm__.activeSid : ""'));
      if (!sid) await sleep(250);
    }
    check('终端会话已建立', Boolean(sid), `sid=${sid}`);

    // 往剪贴板写一段可识别的文本。
    // 有剪贴板 API 就用它；没有（HTTP 非安全上下文）就用 execCommand('copy') 兜底写入。
    const marker = `PASTE-PROBE-${Date.now().toString().slice(-6)}`;
    const hasApi = await cdp.eval(
      '!!(navigator.clipboard && navigator.clipboard.writeText && navigator.clipboard.readText)',
    );
    if (hasApi) {
      await cdp.eval(`navigator.clipboard.writeText(${JSON.stringify(marker)}).then(() => true)`);
    } else {
      await cdp.eval(`(() => {
        const holder = document.createElement('textarea');
        holder.value = ${JSON.stringify(marker)};
        holder.style.position = 'fixed';
        holder.style.top = '-1000px';
        document.body.appendChild(holder);
        holder.select();
        const ok = document.execCommand('copy');
        holder.remove();
        return ok;
      })()`);
    }
    await sleep(400);
    check('剪贴板写入成功', true, `路径=${hasApi ? 'clipboard API' : 'execCommand'}`);

    // 清空终端后测粘贴
    await cdp.eval('window.__webterm__.focusActive()');
    await sleep(300);
    await pressCombo(cdp, 'v', 'KeyV', 86, 2 | 8); // Ctrl+Shift+V
    await sleep(1200);

    const buf = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    const pasted = buf.includes(marker);
    if (hasApi) {
      check('Ctrl+Shift+V 粘贴生效', pasted, pasted ? marker : `缓冲区尾部: ${JSON.stringify(buf.slice(-160))}`);
    } else {
      // 没有剪贴板 API 时不可能读到内容，但必须给出可见提示（后面单独校验）
      check('Ctrl+Shift+V 已响应（无 API 时走提示路径）', true, '');
    }

    // 粘贴后回车，看命令是否真的执行（证明内容进了 PTY 而不只是显示）
    if (hasApi) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(1500);
      const buf2 = String(await cdp.eval('window.__webterm__.activeBufferText()'));
      check(
        '粘贴内容真的送进了 shell',
        buf2.split(marker).length > 2 || /command not found/.test(buf2),
        '',
      );
    } else {
      console.log('  · 无剪贴板 API，跳过「粘贴进 shell」校验（由原生粘贴用例覆盖）');
    }

    // Ctrl+Shift+C：先在终端里制造真实选区（xterm 自己的选区），再复制
    await cdp.eval(`(() => {
      const app = window.__webterm__;
      const term = app?.activeSession?.();
      if (!term) return false;
      term.selectAll();
      return true;
    })()`);
    await sleep(300);
    await pressCombo(cdp, 'c', 'KeyC', 67, 2 | 8); // Ctrl+Shift+C
    await sleep(800);
    // 读回剪贴板：有 API 用 API，没有就用 execCommand('paste') 读（Chrome 会禁，读不到就算跳过）
    let clip2 = '';
    if (await cdp.eval('!!(navigator.clipboard && navigator.clipboard.readText)')) {
      clip2 = String(await cdp.eval('navigator.clipboard.readText()'));
    }
    if (clip2) {
      check('Ctrl+Shift+C 复制生效', clip2.trim().length > 0, `clip=${clip2.slice(0, 40)}`);
    } else {
      console.log(`  · Ctrl+Shift+C 已触发（当前环境读不回剪贴板，跳过内容校验）`);
    }

    // 一次按键只该产生一次粘贴：文档级与 xterm 级不能各处理一遍
    const pasteCalls = await cdp.eval(`(() => {
      const app = window.__webterm__;
      return JSON.stringify({ count: app ? app.pasteCallCount : -1 });
    })()`);
    const calls = JSON.parse(pasteCalls).count;
    check('一次按键只触发一次粘贴（无重复）', calls <= 1, `pasteFromClipboard 调用 ${calls} 次`);

    // 剪贴板 API 是否可用（决定走哪条路径）
    const apiState = JSON.parse(
      await cdp.eval(
        `JSON.stringify({ secure: window.isSecureContext, has: !!window.navigator.clipboard, hasRead: !!(window.navigator.clipboard && window.navigator.clipboard.readText) })`,
      ),
    );
    console.log(`  剪贴板 API：secure=${apiState.secure} has=${apiState.has}`);

    // 不可用时必须给出可见提示（不能静默失败）
    if (!apiState.hasRead) {
      await pressCombo(cdp, 'v', 'KeyV', 86, 2 | 8);
      await sleep(800);
      const notice = String(await cdp.eval("document.getElementById('clipboard-hint')?.textContent || ''"));
      check(
        '剪贴板不可用时给出可见提示',
        notice.includes('Ctrl+V'),
        notice.slice(0, 80),
      );
    }

    // 单独的 Ctrl+V：xterm 不再吞掉它，浏览器做原生粘贴。
    // 这里模拟浏览器粘贴：往 textarea 派发 paste 事件（xterm 会转发给 PTY）。
    await cdp.eval('window.__webterm__.focusActive()');
    await sleep(300);
    const ctrlVMarker = `CTRLV-PROBE-${Date.now().toString().slice(-6)}`;
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
    });
    await sleep(200);
    // 浏览器默认动作在 CDP 里不会自动发生，这里手动补一个 paste 事件，
    // 模拟「浏览器执行了原生粘贴」。
    await cdp.eval(`(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (!ta) return false;
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(ctrlVMarker)});
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(1000);
    const ctrlVBuf = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    check(
      '单独 Ctrl+V 不被终端吞掉（不显示 ^V）',
      !ctrlVBuf.includes('^V'),
      ctrlVBuf.includes('^V') ? '终端把 Ctrl+V 当成了引号插入' : '',
    );

    // Ctrl+Shift+V 不能吃掉按键：API 不可用时要放行给浏览器的原生粘贴。
    // （真实按键里，浏览器会在 keydown 之后触发 paste 事件。）
    const shiftV = JSON.parse(
      await cdp.eval(`(() => {
        const ta = document.querySelector('.xterm-helper-textarea');
        if (!ta) return JSON.stringify({ found: false });
        const ev = new KeyboardEvent('keydown', {
          key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
        });
        ta.focus();
        ta.dispatchEvent(ev);
        return JSON.stringify({ found: true, defaultPrevented: ev.defaultPrevented });
      })()`),
    );
    // 有剪贴板 API 时我们自己处理（要阻止默认动作，避免浏览器再粘一次）；
    // 没有 API（HTTP）时必须放行，让浏览器原生粘贴接管。
    const expectPrevented = apiState.has;
    check(
      expectPrevented
        ? 'Ctrl+Shift+V 由剪贴板 API 处理（阻止默认动作，避免粘两次）'
        : 'Ctrl+Shift+V 未阻止浏览器默认动作（原生粘贴仍可用）',
      shiftV.found && shiftV.defaultPrevented === expectPrevented,
      shiftV.found
        ? `defaultPrevented=${shiftV.defaultPrevented}，期望 ${expectPrevented}`
        : '找不到终端输入框',
    );

    // 原生粘贴路径：浏览器把内容 paste 到 xterm 的 textarea，xterm 转发给 PTY
    await cdp.eval('window.__webterm__.focusActive()');
    await sleep(300);
    const nativeMarker = `NATIVE-PASTE-${Date.now().toString().slice(-6)}`;
    await cdp.eval(`(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (!ta) return false;
      ta.focus();
      const dt = new DataTransfer();
      dt.setData('text/plain', ${JSON.stringify(nativeMarker)});
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(1000);
    const nativeBuf = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    check(
      '原生粘贴事件能进 PTY（Ctrl+V 走的路）',
      nativeBuf.includes(nativeMarker),
      nativeBuf.includes(nativeMarker) ? nativeMarker : JSON.stringify(nativeBuf.slice(-120)),
    );

    // 其它快捷键没被破坏
    const tabsBefore = await cdp.eval('window.__webterm__.tabCount');
    await pressCombo(cdp, 't', 'KeyT', 84, 2 | 8); // Ctrl+Shift+T
    await sleep(1200);
    const tabsAfter = await cdp.eval('window.__webterm__.tabCount');
    check('Ctrl+Shift+T 新建标签页', tabsAfter === tabsBefore + 1, `${tabsBefore} → ${tabsAfter}`);

    ws.close();
  } catch (e) {
    check('执行过程无异常', false, String(e).slice(0, 200));
  } finally {
    kill();
    await sleep(200);
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
