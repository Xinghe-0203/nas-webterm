#!/usr/bin/env node
/**
 * 界面截图（headless Chromium + CDP），用于 README / 文档留档。
 *
 * 用法：
 *   node tools/screenshot-ui.mjs --url http://127.0.0.1:18120/app/nas-webterm/ \
 *     --out docs/screenshots
 *
 * 会依次拍：深色、浅色、帮助弹窗、AI 设置窗、新建菜单。
 * 需要应用已启动（tools/dev.sh）；AI 相关截图请配合 tools/mock-ai.mjs。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}

const BASE = (args.url || 'http://127.0.0.1:18120/app/nas-webterm/').replace(/\/+$/, '');
const OUT = args.out || path.resolve('docs', 'screenshots');
const CHROME = args.chrome || process.env.CHROME_BIN || 'chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const port = 9900 + Math.floor(Math.random() * 80);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-shot-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const kill = () => {
    try {
      chrome.kill('SIGKILL');
    } catch {
      /* noop */
    }
  };

  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        /* 等待 */
      }
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
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // 等终端就绪并跑一条彩色命令，让画面有内容
    for (let i = 0; i < 60; i += 1) {
      if (await cdp.eval('Boolean(window.__webterm__ && window.__webterm__.activeSid)')) break;
      await sleep(300);
    }
    await sleep(1200);
    await cdp.eval('window.__webterm__.focusActive()');
    await cdp.send('Input.insertText', { text: 'ls --color=always /usr/bin | head -12' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(1800);

    const shot = async (name) => {
      const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const data = png.result?.data;
      if (!data) throw new Error('截图失败');
      const file = path.join(OUT, name);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  已保存 ${file}`);
    };

    // 深色
    if (await cdp.eval("document.documentElement.dataset.theme !== 'dark'")) {
      await cdp.eval("document.getElementById('theme-toggle').click()");
    }
    await sleep(600);
    await shot('ui-dark.png');

    // 浅色（走按钮，这样 xterm 的配色也会跟着切）
    await cdp.eval("document.getElementById('theme-toggle').click()");
    await sleep(800);
    await shot('ui-light.png');
    await cdp.eval("document.getElementById('theme-toggle').click()");
    await sleep(600);

    // 帮助弹窗
    await cdp.eval("document.getElementById('help').click()");
    await sleep(400);
    await shot('ui-help.png');
    await cdp.eval("document.getElementById('help-dialog').close()");
    await sleep(300);

    // 新建菜单
    await cdp.eval("document.getElementById('newtab-menu').click()");
    await sleep(400);
    await shot('ui-menu.png');
    await cdp.eval('document.getElementById("menu").hidden = true');
    await sleep(300);

    // AI 设置窗（用 Ctrl+Alt+A，与真实用户路径一致）
    await cdp.eval(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, altKey: true, bubbles: true }))",
    );
    await sleep(700);
    await shot('ai-settings.png');

    console.log('完成');
  } catch (e) {
    console.error(String(e).slice(0, 400));
    process.exitCode = 1;
  } finally {
    kill();
    await sleep(300);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  }
})();
