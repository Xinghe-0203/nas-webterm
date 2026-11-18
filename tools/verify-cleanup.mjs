#!/usr/bin/env node
/**
 * 会话回收回归：关闭标签页（DELETE 会话）后，PTY 里的进程必须全部结束。
 *
 * 背景（1.2.2 修复的问题）：
 *   交互式 shell 开了作业控制，每条命令 / 后台作业都在自己的进程组里，
 *   旧的 `killpg(shell_pid)` 只打在 shell 自己那一组上，于是
 *   `sleep 999 &`、`nohup xxx &`、`setsid xxx &` 都会在标签页关掉后继续跑。
 *   服务端现在按「会话 id + environ 标记」扫 /proc 清整棵进程树。
 *
 * 断言：
 *   1. 后台作业（`sleep ... &`）在 DELETE 之后消失
 *   2. setsid 出去的守护进程（脱离会话）也会被清掉
 *   3. 前台作业消失
 *   4. /api/sessions 里不再有该会话
 *
 * 用法：
 *   node tools/verify-cleanup.mjs --url http://127.0.0.1:18086/app/nas-webterm/
 */

import { execFileSync } from 'node:child_process';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  if (!process.argv[i].startsWith('--')) continue;
  const key = process.argv[i].slice(2);
  args[key] = process.argv[i + 1];
  i += 1;
}
const BASE = (args.url || 'http://127.0.0.1:18086/app/nas-webterm/').replace(/\/+$/, '');
const HTTP = BASE.replace(/^ws/, 'http');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找出命令行里包含 marker 的进程（排除本脚本自己）。 */
function findProcs(marker) {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((line) => line.includes(marker) && !line.includes('verify-cleanup'))
      .map((line) => line.trim());
  } catch {
    return [];
  }
}

async function openSession() {
  const url = new URL(`${BASE}/api/ws`);
  url.searchParams.set('cols', '100');
  url.searchParams.set('rows', '30');
  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';
  let sid = null;
  ws.addEventListener('message', async (e) => {
    const d = e.data instanceof Blob ? await e.data.arrayBuffer() : e.data;
    const b = Buffer.from(d);
    if (b[0] === 0x03) sid = JSON.parse(b.subarray(1).toString('utf8')).sid;
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('连接失败')));
    setTimeout(() => reject(new Error('连接超时')), 8000);
  });
  await sleep(400);
  if (!sid) throw new Error('没有收到 READY 帧（拿不到会话 id）');
  return { ws, sid };
}

function send(ws, text) {
  ws.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(text)]));
}

async function api(path, init) {
  const res = await fetch(`${HTTP}${path}`, init);
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, json };
}

(async () => {
  // 唯一标记：避免和机器上其它 sleep 混淆
  const TAG = `7311${String(process.pid).slice(-3)}`;
  const bg = `sleep ${TAG}1`;
  const escaped = `sleep ${TAG}2`;
  const fg = `sleep ${TAG}3`;

  const { ws, sid } = await openSession();
  console.log(`会话 ${sid}`);

  send(ws, `${bg} &\n`);
  send(ws, `setsid ${escaped} >/dev/null 2>&1 &\n`);
  send(ws, `${fg}\n`);
  await sleep(1200);

  check('后台作业已启动', findProcs(bg).length > 0, findProcs(bg)[0] ?? '');
  check('setsid 守护进程已启动', findProcs(escaped).length > 0, findProcs(escaped)[0] ?? '');
  check('前台作业已启动', findProcs(fg).length > 0, findProcs(fg)[0] ?? '');

  // 关闭标签页：前端就是发这一条 DELETE
  ws.close();
  await sleep(150);
  const del = await api(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
  check('DELETE 会话成功', del.status === 200 || del.status === 404, `status=${del.status}`);

  await sleep(1500);

  check('后台作业已结束', findProcs(bg).length === 0, findProcs(bg).join(' | '));
  check('setsid 守护进程已结束', findProcs(escaped).length === 0, findProcs(escaped).join(' | '));
  check('前台作业已结束', findProcs(fg).length === 0, findProcs(fg).join(' | '));

  const list = await api('/api/sessions');
  const sessions = Array.isArray(list.json?.data) ? list.json.data : [];
  check('会话表里已没有它', !sessions.some((s) => s.id === sid), `剩余 ${sessions.length} 个会话`);

  const failed = checks.filter((x) => !x.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.error(`失败的检查：${failed.map((x) => x.name).join('、')}`);
    // 兜底清理，避免测试失败时把进程留在机器上
    for (const marker of [bg, escaped, fg]) {
      for (const line of findProcs(marker)) {
        const pid = Number(line.split(/\s+/)[0]);
        if (pid > 1) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* ignore */
          }
        }
      }
    }
    process.exit(1);
  }
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
