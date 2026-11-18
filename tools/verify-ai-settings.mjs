#!/usr/bin/env node
/**
 * AI 设置保存端到端验证
 *
 * 背景：重构 AI 面板时把设置窗的字段 id 写错了（读 `ai-cfg-url`，
 * 而 HTML 里是 `ai-cfg-base`），导致接口地址传成空串、服务端整包拒绝，
 * 表现就是「模型保存不了」。
 *
 * 本测试确认：
 *   1. 打开设置窗时，表单被**完整回填**（接口地址、模型、Key 状态、各开关）
 *   2. 改模型名 + 改接口地址后点保存 → 接口返回 ok，模型确实存下来了
 *   3. 保存后重新打开设置窗，回填的是新值（不是旧值）
 *   4. 保存的内容确实落到服务端磁盘上
 *   5. 表单里每个字段 id 都能在 HTML 里找到（防止再次写错 id）
 *
 * 用法：node tools/verify-ai-settings.mjs --url http://127.0.0.1:18098/app/nas-webterm-ai/
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
const BASE = (args.url || 'http://127.0.0.1:18098/app/nas-webterm-ai/').replace(/\/+$/, '');
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

/** 代码里读取的字段 id → HTML 里必须存在 */
const FIELD_IDS = [
  'ai-cfg-enabled',
  'ai-cfg-base',
  'ai-cfg-key',
  'ai-cfg-model',
  'ai-cfg-temp',
  'ai-cfg-effort',
  'ai-cfg-tokens',
  'ai-cfg-window',
  'ai-cfg-derived',
  'ai-cfg-context',
  'ai-cfg-stream',
  'ai-cfg-memory',
  'ai-cfg-memory-text',
  'ai-cfg-key-hint',
  'ai-cfg-status',
  'ai-cfg-save',
];

(async () => {
  const port = 9700 + Math.floor(Math.random() * 90);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ais-'));
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
      '--window-size=1280,900',
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

    // 1) 表单里所有字段 id 都存在
    const missing = JSON.parse(
      await cdp.eval(`JSON.stringify(${JSON.stringify(FIELD_IDS)}.filter((id) => !document.getElementById(id)))`),
    );
    check('设置窗所有字段 id 都能在页面上找到', missing.length === 0, missing.join(', '));

    // 2) 打开设置窗 → 回填
    await cdp.eval('window.__webterm__.openAiSettings && window.__webterm__.openAiSettings()');
    await sleep(2500);
    const filled = JSON.parse(
      await cdp.eval(`(() => {
        const v = (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          return el.type === 'checkbox' ? el.checked : el.value;
        };
        return JSON.stringify({
          base: v('ai-cfg-base'),
          model: v('ai-cfg-model'),
          enabled: v('ai-cfg-enabled'),
          temp: v('ai-cfg-temp'),
          tokens: v('ai-cfg-tokens'),
          window: v('ai-cfg-window'),
          effort: v('ai-cfg-effort'),
          keyHint: (document.getElementById('ai-cfg-key-hint') || {}).textContent || '',
        });
      })()`),
    );
    check('接口地址已回填', typeof filled.base === 'string' && filled.base.length > 0, `base=${filled.base}`);
    check('模型名已回填', typeof filled.model === 'string' && filled.model.length > 0, `model=${filled.model}`);
    check(
      '温度/回复长度/上下文窗口已回填',
      filled.temp !== '' && filled.tokens !== '' && Number(filled.window) > 0,
      JSON.stringify(filled),
    );

    // 3) 改模型名 + 其它字段 → 保存
    const newModel = `probe-model-${Date.now().toString().slice(-6)}`;
    const before = await cdp.eval(`(async () => {
      const r = await fetch('api/ai/config', { credentials: 'same-origin' });
      const j = await r.json();
      return JSON.stringify(j.data || {});
    })()`);
    const beforeObj = JSON.parse(before);

    await cdp.eval(`(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        if (!el) return false;
        if (el.type === 'checkbox') el.checked = v;
        else el.value = v;
        return true;
      };
      set('ai-cfg-model', ${JSON.stringify(newModel)});
      set('ai-cfg-base', ${JSON.stringify(beforeObj.baseUrl || 'https://api.deepseek.com/v1')});
      set('ai-cfg-temp', '0.35');
      set('ai-cfg-tokens', '4096');
      set('ai-cfg-window', '200000');
      set('ai-cfg-effort', 'medium');
      set('ai-cfg-memory-text', '记忆回归测试条目');
      return true;
    })()`);
    await sleep(300);

    await cdp.eval(`(() => {
      const form = document.getElementById('ai-settings-form');
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(3000);

    const status = String(await cdp.eval("(document.getElementById('ai-cfg-status')||{}).textContent||''"));
    check('保存没有报错', !status.includes('不能为空') && !status.includes('必须以') && !status.includes('失败'),
      `status=${JSON.stringify(status)}`);

    // 4) 服务端确实存了新模型
    const after = JSON.parse(
      await cdp.eval(`(async () => {
        const r = await fetch('api/ai/config', { credentials: 'same-origin' });
        const j = await r.json();
        return JSON.stringify(j.data || {});
      })()`),
    );
    check('模型名已保存到服务端', after.model === newModel, `model=${after.model}`);
    check('温度已保存', Math.abs(Number(after.temperature) - 0.35) < 0.01, `temperature=${after.temperature}`);
    check('最大回复长度已保存', Number(after.maxTokens) === 4096, `maxTokens=${after.maxTokens}`);
    check('模型上下文已保存', Number(after.contextWindow) === 200000, `contextWindow=${after.contextWindow}`);
    check(
      '预算按上下文自动推导',
      Number(after.derived?.maxSteps) === 48 && Number(after.derived?.historyTurns) > 4,
      `maxSteps=${after.derived?.maxSteps} historyTurns=${after.derived?.historyTurns} contextChars=${after.derived?.contextChars}`,
    );
    check('思考强度已保存', after.reasoningEffort === 'medium', `reasoningEffort=${after.reasoningEffort}`);

    // 5) 长期记忆已保存
    const mem = JSON.parse(
      await cdp.eval(`(async () => {
        const r = await fetch('api/ai/memory', { credentials: 'same-origin' });
        const j = await r.json();
        return JSON.stringify(j.data || {});
      })()`),
    );
    check('长期记忆已保存', String(mem.text || '').includes('记忆回归测试条目'), `text=${String(mem.text || '').slice(0, 40)}`);

    // 6) 重新打开设置窗 → 回填新值
    await cdp.eval('window.__webterm__.closeAiSettings && window.__webterm__.closeAiSettings()');
    await sleep(500);
    await cdp.eval('window.__webterm__.openAiSettings && window.__webterm__.openAiSettings()');
    await sleep(2500);
    const refilled = JSON.parse(
      await cdp.eval(`(() => {
        const el = document.getElementById('ai-cfg-model');
        return JSON.stringify({ model: el ? el.value : '' });
      })()`),
    );
    check('重新打开设置窗回填的是新值', refilled.model === newModel, `model=${refilled.model}`);

    // 7) 还原，避免污染真实配置
    await cdp.eval(`(async () => {
      const r = await fetch('api/ai/config', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ${JSON.stringify(beforeObj.model || 'deepseek-chat')},
          baseUrl: ${JSON.stringify(beforeObj.baseUrl || 'https://api.deepseek.com/v1')},
          temperature: ${JSON.stringify(beforeObj.temperature ?? 0.2)},
          maxTokens: ${JSON.stringify(beforeObj.maxTokens ?? 2048)},
          contextWindow: ${JSON.stringify(beforeObj.contextWindow ?? 1000000)},
          reasoningEffort: ${JSON.stringify(beforeObj.reasoningEffort ?? '')},
        }),
      });
      return true;
    })()`);
    await sleep(800);

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
