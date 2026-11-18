#!/usr/bin/env node
/**
 * 内置 Nerd Font 回归验证
 *
 * 背景：终端里跑 oh-my-posh / starship 这类带图标的提示符时，图标用的是
 * Nerd Font 私有区码点（U+E000–U+F8FF）。普通等宽字体没有这些码点，
 * 浏览器会把它们画成彩色方块（tofu），提示符就成一串色块。
 *
 * 本应用内置了一份 Nerd Font 子集来避免这个问题。本测试确认：
 *   1. 字体文件确实被前端引用并能加载
 *   2. 私有区码点确实由内置字体渲染（不是回退到普通字体）
 *   3. 提示符里的 powerline 图标能正常画出来
 *
 * 用法：node tools/verify-nerd-font.mjs --url http://127.0.0.1:18098/app/nas-webterm/
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
  async eval(expression) {
    const msg = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const p = msg.result || {};
    if (p.exceptionDetails) throw new Error(`页面内执行失败: ${p.exceptionDetails.text}`);
    return p.result ? p.result.value : undefined;
  }
}

(async () => {
  const port = 9700 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-nerd-'));
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
      '--window-size=1200,400',
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

    // 1) 字体已注册并加载
    const fontState = JSON.parse(
      await cdp.eval(
        `JSON.stringify({
          list: [...document.fonts].map(f => ({ family: f.family, status: f.status })),
          loaded: [...document.fonts].some(f => f.family.includes('Nerd') && f.status === 'loaded'),
        })`,
      ),
    );
    check(
      '内置 Nerd Font 已注册并加载',
      fontState.loaded,
      fontState.list.map((f) => `${f.family}:${f.status}`).join(', ') || '（没有任何 @font-face）',
    );

    // 2) 私有区码点确实由 Nerd Font 渲染（宽度 ≠ notdef 宽度）
    const glyphs = JSON.parse(
      await cdp.eval(`(() => {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = '16px "NasWebTermNerd"';
        const notdef = ctx.measureText('\\uFFFF').width;
        const probes = [0xE0B6, 0xE0B0, 0xE0B2, 0xE0B1, 0xE0A0, 0xF07C];
        const out = probes.map((cp) => {
          const ch = String.fromCodePoint(cp);
          const w = ctx.measureText(ch).width;
          return { cp: 'U+' + cp.toString(16).toUpperCase(), w, tofu: w === notdef };
        });
        return JSON.stringify({ notdef, out });
      })()`),
    );
    const tofu = glyphs.out.filter((g) => g.tofu);
    check(
      'Nerd Font 私有区码点不是 tofu（不会显示成方块）',
      tofu.length === 0,
      tofu.length ? `仍是方块：${tofu.map((t) => t.cp).join(', ')}` : `已检查 ${glyphs.out.length} 个码点`,
    );

    // 3) 提示符里的图标确实画出来了（终端能显示私有区字符且宽度正常）
    await cdp.eval('window.__webterm__ && window.__webterm__.focusActive()');
    await sleep(300);
    await cdp.send('Input.insertText', { text: '\uE0B6\uE0B0\uE0B2 \uE0B1' });
    await sleep(1200);
    const term = String(await cdp.eval('window.__webterm__.activeBufferText()'));
    check(
      '私有区字符原样进入终端',
      /[\uE000-\uF8FF]/.test(term),
      JSON.stringify(term.slice(0, 60)),
    );

    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('页面无未捕获异常', exceptions.length === 0, String(exceptions[0]?.params?.exceptionDetails?.text || ''));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      const dir = path.join(process.cwd(), 'docs', 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'nerd-font.png'), Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${path.join(dir, 'nerd-font.png')}`);
    }
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
