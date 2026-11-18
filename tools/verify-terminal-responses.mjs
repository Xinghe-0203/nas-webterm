#!/usr/bin/env node
/**
 * 终端查询应答路由验证（headless Chromium + CDP）
 *
 * 覆盖验收标准：
 *   1. 程序发送 OSC 10 查询后立即退出 → 终端输入框不能出现 rgb:...；
 *   2. 程序发送 DA 查询后立即退出 → 不能出现 1;2c；
 *   3. 程序发送 OSC/DA 查询并持续读取 → 能收到正确应答；
 *   4. OSC 查询分片写入 → 仍能正确应答。
 *
 * 用法：node tools/verify-terminal-responses.mjs --url http://127.0.0.1:18221/app/nas-webterm/
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

const BASE = (args.url || 'http://127.0.0.1:18221/app/nas-webterm/').replace(/\/+$/, '');
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
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      unmodifiedText: ch,
      key: ch,
    });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(8);
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  });
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

(async () => {
  // 查询测试脚本：先发 OSC 10，发 DA1，再分片发 OSC 11；每步都等应答并打印十六进制。
  const py = `import os,sys,select,termios,tty,time
fd=0
old=termios.tcgetattr(fd)
def rd(t=2.0):
    r,_,_=select.select([fd],[],[],t)
    return os.read(fd,512) if r else b''
try:
    tty.setraw(fd)
    os.write(1,b'\\x1b]10;?\\x07')
    d1=rd()
    os.write(1,b'\\x1b[c')
    d2=rd()
    os.write(1,b'\\x1b]1')
    time.sleep(0.12)
    os.write(1,b'1;?\\x07')
    d3=rd()
    os.write(1,b'\\x1b[?25$p')
    d4=rd()
finally:
    termios.tcsetattr(fd,termios.TCSADRAIN,old)
print('OSC10=' + d1.hex())
print('DA1=' + d2.hex())
print('OSC11_FRAG=' + d3.hex())
print('DECRQM=' + d4.hex())
`;
  fs.writeFileSync('/tmp/term-query-test.py', py, 'utf8');

  const port = 9900 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-termresp-'));
  const chrome = spawn(CHROME, [
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
  ], { stdio: 'ignore' });
  const kill = () => { try { chrome.kill('SIGKILL'); } catch { /* noop */ } };

  try {
    let ready = false;
    for (let i = 0; i < 120 && !ready; i += 1) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok; } catch { /* wait */ }
      if (!ready) await sleep(150);
    }
    if (!ready) throw new Error('Chromium 未就绪');

    const cdp = await openPage(port);
    await sleep(args.wait);

    // 先清屏，避免旧提示符干扰观察
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, 'clear');
    await sleep(600);

    // 1) 查询后立即退出：printf 是外部进程，写完就退出
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, "/usr/bin/printf '\\033]10;?\\007'");
    await sleep(1200);
    const afterOsc = await cdp.eval('window.__webterm__.activeBufferText()');
    check('OSC 10 查询后立即退出：屏幕不出现 rgb: 应答', !afterOsc.includes('rgb:'),
      JSON.stringify(afterOsc.slice(-100)));
    check('OSC 10 查询后立即退出：应答没有作为输入回显', !/10;rgb/i.test(afterOsc), '');

    // 2) DA 查询后立即退出
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, "/usr/bin/printf '\\033[c'");
    await sleep(1200);
    const afterDa = await cdp.eval('window.__webterm__.activeBufferText()');
    check('DA 查询后立即退出：屏幕不出现 1;2c 应答', !afterDa.includes('1;2c'),
      JSON.stringify(afterDa.slice(-100)));

    // 2b) DECRQM 查询后立即退出：CSI ?25$p 的应答 (?25;2$y) 不能回显
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, "/usr/bin/printf '\\033[?25$p'");
    await sleep(1200);
    const afterRqm = await cdp.eval('window.__webterm__.activeBufferText()');
    check('DECRQM 查询后立即退出：屏幕不出现 $y 应答', !afterRqm.includes('$y'),
      JSON.stringify(afterRqm.slice(-100)));

    // 3) 刷新页面：回放里也会重放旧的 OSC 查询，xterm 不能把应答灌进 shell
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(args.wait + 1500);
    const afterReload = await cdp.eval('window.__webterm__.activeBufferText()');
    check('刷新回放旧查询不产生 rgb: 污染', !afterReload.includes('rgb:'),
      JSON.stringify(afterReload.slice(-100)));

    // 4) 正常程序持续读取：应收到 OSC 10 / DA1 / 分片 OSC 11 的应答
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, 'python3 /tmp/term-query-test.py');
    await sleep(5000);
    const afterNormal = await cdp.eval('window.__webterm__.activeBufferText()');
    check('正常程序收到 OSC 10 应答', /OSC10=[0-9a-f]*1b5d31303b7267623a/i.test(afterNormal),
      JSON.stringify(afterNormal.slice(-220)));
    check('正常程序收到 DA1 应答', /DA1=[0-9a-f]*1b5b3f/i.test(afterNormal), '');
    check('分片 OSC 11 查询收到应答', /OSC11_FRAG=[0-9a-f]*1b5d31313b7267623a/i.test(afterNormal), '');
    check('正常程序收到 DECRQM 应答', /DECRQM=[0-9a-f]*1b5b3f32353b/i.test(afterNormal), '');

    // 5) vim 回归：正常启动/退出，不被应答路由卡住
    await cdp.eval('window.__webterm__.focusActive()');
    await typeText(cdp, 'vim -u NONE -c q');
    await sleep(1600);
    const afterVim = await cdp.eval('window.__webterm__.activeBufferText()');
    check('vim 正常启动并退出（回归）', /root@[^\n]*#/.test(afterVim),
      JSON.stringify(afterVim.slice(-100)));

    const shotDir = args.screenshot || path.join(process.cwd(), 'docs', 'screenshots');
    fs.mkdirSync(shotDir, { recursive: true });
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (shot.result?.data) {
      fs.writeFileSync(path.join(shotDir, 'verify-terminal-responses.png'), Buffer.from(shot.result.data, 'base64'));
      console.log(`  截图：${path.join(shotDir, 'verify-terminal-responses.png')}`);
    }
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
