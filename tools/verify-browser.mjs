#!/usr/bin/env node
/**
 * 浏览器真实渲染验证模板（headless Chromium + CDP，无需安装 .fpk）
 * =============================================================================
 * 反代类 / micro_app 应用上线前，用真实浏览器跑一遍，比 curl 可靠得多：
 *   1. 页面真正渲染（title 非空，可选断言标题子串）；
 *   2. 无资源加载失败（4xx/5xx、被网关拦截），无未捕获脚本异常；
 *   3. 页面内相对 API 可用（可配置多个路径）；
 *   4. WebSocket 可通过网关升级（可配置多个路径，如 socket.io）；
 *   5. 注入脚本生效：同源请求带上了自定义头（如 X-Proxy-Origin）；
 *   6. 截图留档，便于人工复核。
 *
 * 前置：本机有 chromium（或设置 CHROME_BIN），应用已在开发模式启动（tools/dev.sh）。
 *
 * 用法：
 *   node tools/verify-browser.mjs --url http://127.0.0.1:18086/app/demo-reverse-proxy/
 *   node tools/verify-browser.mjs --url ... --title "MCSManager" \
 *     --api ./api/auth/status --api ./api/overview \
 *     --ws /app/demo-reverse-proxy/daemon/socket.io/?EIO=4\&transport=websocket \
 *     --origin-header x-proxy-origin --screenshot docs/screenshots/verify.png
 *
 * 参数（也可用同名大写环境变量）：
 *   --url <url>              必填（或 VERIFY_URL）
 *   --title <substr>         期望 title 包含的字符串
 *   --api <path>             页面内 fetch 的相对/绝对路径，可重复
 *   --ws <path>              页面内 WebSocket 路径，可重复
 *   --origin-header <name>   检查同源请求是否带该头（默认不检查）
 *   --expect <selector>      期望页面存在该 CSS 选择器
 *   --wait <ms>              首屏等待时间，默认 6000
 *   --screenshot <file>     截图输出路径，默认 docs/screenshots/verify.png
 *   --chrome <bin>           Chromium 可执行文件，默认 chromium
 * =============================================================================
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const out = { api: [], ws: [], originHeader: '', expect: '', wait: 6000, type: '' };
  const takes = new Set(['url', 'title', 'api', 'ws', 'origin-header', 'expect', 'wait', 'screenshot', 'chrome', 'type']);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2);
    if (!takes.has(name)) continue;
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${key} 缺少参数值`);
    i += 1;
    if (name === 'api') out.api.push(value);
    else if (name === 'ws') out.ws.push(value);
    else if (name === 'origin-header') out.originHeader = value;
    else out[name] = value;
  }
  out.url = out.url || process.env.VERIFY_URL || '';
  out.title = out.title || process.env.EXPECT_TITLE || '';
  out.chrome = out.chrome || process.env.CHROME_BIN || 'chromium';
  out.wait = Number(out.wait || 6000);
  out.screenshot = out.screenshot || path.join(ROOT, 'docs', 'screenshots', 'verify.png');
  return out;
}

async function waitFor(probe, tries, intervalMs) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      /* 继续重试 */
    }
    await sleep(intervalMs);
  }
  return null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        this.events.push(msg);
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
    const message = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const payload = message.result || {};
    if (payload.exceptionDetails) {
      throw new Error(`页面内执行失败: ${JSON.stringify(payload.exceptionDetails)}`);
    }
    return payload.result ? payload.result.value : undefined;
  }
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}

function normUrl(value) {
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `http://${value}`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const BASE_URL = normUrl(args.url).replace(/\/+$/, '');
  if (!BASE_URL) {
    console.error('用法: node tools/verify-browser.mjs --url http://127.0.0.1:18086/app/<name>/ [--title ...] [--api ./api/...] [--ws /app/<name>/...]');
    process.exit(2);
  }
  console.log(`目标: ${BASE_URL}/`);

  const port = 9500 + Math.floor(Math.random() * 400);
  // HOME 只读（部分 NAS/受限环境）时 Chromium 无法建默认 profile，显式给临时目录
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fn-verify-chrome-'));
  const chrome = spawn(
    args.chrome,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const kill = () => {
    try { chrome.kill('SIGKILL'); } catch { /* noop */ }
  };

  try {
    const ready = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 100, 150);
    if (!ready) throw new Error('Chromium 未就绪（检查是否安装了 chromium / 端口是否被占用）');

    let target = null;
    for (let i = 0; i < 20 && !target; i += 1) {
      const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${BASE_URL}/`)}`, { method: 'PUT' });
      if (res.ok) target = await res.json();
      else await sleep(150);
    }
    if (!target) throw new Error('无法创建 Chromium 页面');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await sleep(args.wait);

    // 1) 页面渲染 + 标题
    const title = await cdp.eval('document.title');
    check('页面已渲染（title 非空）', Boolean(title), `title=${JSON.stringify(title)}`);
    if (args.title) check(`标题包含 ${JSON.stringify(args.title)}`, String(title || '').includes(args.title), '');

    // 2) 可选选择器
    if (args.expect) {
      const found = await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(args.expect)}))`);
      check(`页面存在选择器 ${args.expect}`, found === true, '');
    }

    // 3) 页面内相对 API（相对于当前页面 URL）
    for (const apiPath of args.api) {
      const result = await cdp.eval(`(async () => {
        try {
          const r = await fetch(${JSON.stringify(apiPath)}, { cache: 'no-store' });
          const text = await r.text();
          return JSON.stringify({ ok: r.ok, status: r.status, type: r.headers.get('content-type') || '', head: text.slice(0, 60) });
        } catch (e) { return JSON.stringify({ error: String(e) }); }
      })()`);
      let parsed;
      try { parsed = JSON.parse(result); } catch { parsed = { error: 'bad result' }; }
      check(`页面内 API 可用 ${apiPath}`, parsed.status >= 200 && parsed.status < 400, `${parsed.status || ''} ${parsed.head || parsed.error || ''}`.trim());
    }

    // 4) 页面内 WebSocket
    for (const wsPath of args.ws) {
      const result = await cdp.eval(`(async () => {
        return await new Promise((resolve) => {
          let done = false;
          let socket;
          const finish = (value) => {
            if (done) return;
            done = true;
            try { if (socket) socket.close(); } catch (e) {}
            resolve(JSON.stringify(value));
          };
          try {
            const url = new URL(${JSON.stringify(wsPath)}, location.href);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            socket = new WebSocket(url.toString());
          } catch (e) { finish({ error: String(e) }); return; }
          const timer = setTimeout(() => finish({ error: 'timeout' }), 5000);
          socket.onmessage = (ev) => { clearTimeout(timer); finish({ ok: true, head: String(ev.data).slice(0, 40) }); };
          socket.onopen = () => { /* 等第一条消息判定 */ };
          socket.onerror = () => { clearTimeout(timer); finish({ error: 'websocket error' }); };
        });
      })()`);
      let parsed;
      try { parsed = JSON.parse(result); } catch { parsed = { error: 'bad result' }; }
      check(`WebSocket 可用 ${wsPath}`, parsed.ok === true, String(parsed.head || parsed.error || '').slice(0, 100));
    }

    // 5) 终端渲染与真实键入交互
    const termState = await cdp.eval(`(() => {
      const app = window.__webterm__;
      if (!app) return JSON.stringify({ error: 'no app handle' });
      const screen = document.querySelector('.xterm-screen');
      const rect = screen ? screen.getBoundingClientRect() : { width: 0, height: 0 };
      const canvas = document.querySelector('.xterm canvas');
      return JSON.stringify({
        screenWidth: Math.round(rect.width),
        screenHeight: Math.round(rect.height),
        canvasRows: canvas ? canvas.clientHeight : 0,
        tabs: app.tabCount,
        text: app.activeBufferText().slice(-800),
      });
    })()`);
    let termParsed = {};
    try { termParsed = JSON.parse(termState); } catch { termParsed = { error: 'bad result' }; }
    check('终端画布已渲染（尺寸 > 0）', (termParsed.screenWidth || 0) > 100 && (termParsed.screenHeight || 0) > 100,
      `${termParsed.screenWidth}x${termParsed.screenHeight}`);
    check('标签栏已初始化', (termParsed.tabs || 0) >= 1, `tabs=${termParsed.tabs}`);
    check('终端收到后端输出（缓冲区非空）', String(termParsed.text || '').trim().length > 0,
      JSON.stringify(String(termParsed.text || '').slice(-140)));

    // 真实键入一条命令，验证「输入 → PTY → shell → 输出」整条链路。
    // 期望文本由 shell 计算得出（乘号算式），命令行回显里不会出现完整标记，
    // 避免「只要键入成功就算通过」的假阳性。
    if (args.type) {
      const marker = 'build-check-42';
      const command = `echo "build-check-"$((6*7))`;
      await cdp.eval('window.__webterm__.focusActive()');
      await sleep(300);
      for (const ch of command) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch, key: ch });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
        await sleep(15);
      }
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(2000);
      const after = await cdp.eval(`(() => JSON.stringify({ text: window.__webterm__.activeBufferText().slice(-1000) }))()`);
      let afterParsed = {};
      try { afterParsed = JSON.parse(after); } catch { afterParsed = { text: '' }; }
      const text = String(afterParsed.text || '');
      check(`终端可交互（命令输出 ${marker}）`, text.includes(marker), JSON.stringify(text.slice(-200)));
    }

    // 6) 注入头是否出现在同源请求里
    if (args.originHeader) {
      const allExtra = cdp.events.filter((event) => event.method === 'Network.requestWillBeSentExtraInfo');
      const wanted = args.originHeader.toLowerCase();
      const withHeader = allExtra.some((event) => Object.keys(event.params?.headers || {}).map((k) => k.toLowerCase()).includes(wanted));
      check(`同源请求带上 ${args.originHeader} 头`, withHeader, allExtra.length === 0 ? '（未捕获到请求头事件）' : '');
    }

    // 6) 资源加载失败 / 未捕获异常
    const failed = cdp.events
      .filter((event) => event.method === 'Network.loadingFailed')
      .map((event) => event.params?.errorText)
      .filter(Boolean);
    check('无资源加载失败', failed.length === 0, failed.slice(0, 3).join('; '));

    const exceptions = cdp.events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => event.params?.exceptionDetails?.text)
      .filter(Boolean);
    check('无未捕获脚本异常', exceptions.length === 0, exceptions.slice(0, 3).join('; '));

    // 7) 截图
    fs.mkdirSync(path.dirname(args.screenshot), { recursive: true });
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const height = Math.max(900, Math.ceil(metrics.result.cssContentSize?.height || 900));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 1440, height: Math.min(height, 900), scale: 1 },
    });
    if (shot.result?.data) {
      fs.mkdirSync(path.dirname(args.screenshot), { recursive: true });
      fs.writeFileSync(args.screenshot, Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${path.relative(ROOT, args.screenshot)}`);
    }

    ws.close();
  } finally {
    kill();
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  const failedChecks = checks.filter((item) => !item.ok);
  console.log(`\n结果：${checks.length - failedChecks.length}/${checks.length} 通过`);
  if (failedChecks.length > 0) {
    console.error('失败的检查：' + failedChecks.map((item) => item.name).join('、'));
    process.exit(1);
  }
})().catch((error) => {
  console.error(`✗ ${error.message}`);
  console.error('  请确认应用开发服务已启动（tools/dev.sh）、chromium 可用、URL 正确。');
  process.exit(1);
});
