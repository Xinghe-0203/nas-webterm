#!/usr/bin/env node
/**
 * 泄漏压力测试：反复建/销会话，观察服务端进程的内存、文件描述符、线程、僵尸进程。
 *
 * 关注点（每个会话都会占用：1 个 PTY master fd + 1 个读 fd + 1 个写 fd + 2 个线程）：
 *   1. RSS 不随会话数线性增长（回落到基线附近）
 *   2. fd 数不随会话数线性增长
 *   3. 线程数不随会话数线性增长
 *   4. 没有僵尸进程
 *   5. 会话全部回收后，服务端会话表为空
 *
 * 用法：
 *   node tools/verify-leaks.mjs --url http://127.0.0.1:18086/app/nas-webterm/ \
 *     --pid 12345 --rounds 40
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
const PID = Number(args.pid || 0);
const ROUNDS = Number(args.rounds || 40);

const C_INPUT = 0x01;
const S_OUTPUT = 0x01;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? `  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取进程指标 */
function metrics() {
  const status = execFileSync('cat', [`/proc/${PID}/status`], { encoding: 'utf8' });
  const rssKb = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0);
  const threads = Number(/Threads:\s+(\d+)/.exec(status)?.[1] || 0);
  let fds = 0;
  try {
    fds = execFileSync('bash', ['-c', `ls /proc/${PID}/fd | wc -l`], { encoding: 'utf8' }).trim();
    fds = Number(fds);
  } catch { /* ignore */ }
  let zombies = 0;
  try {
    zombies = Number(
      execFileSync('bash', ['-c', `ps -o stat= --ppid ${PID} 2>/dev/null | grep -c Z || true`], { encoding: 'utf8' }).trim(),
    );
  } catch { /* ignore */ }
  return { rssKb, threads, fds, zombies };
}

async function api(path, init) {
  const res = await fetch(`${HTTP}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: null, text };
  }
}

async function oneRound(index) {
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
  await sleep(150);
  // 写一点数据，产生输出与回放缓冲
  ws.send(Buffer.concat([Buffer.from([C_INPUT]), Buffer.from(`echo "leak-probe-${index}"\n`)]));
  await sleep(250);
  ws.close();
  if (sid) {
    await api(`/api/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' }).catch(() => {});
  }
  await sleep(60);
}

(async () => {
  if (!PID) {
    console.error('用法: node tools/verify-leaks.mjs --url ... --pid <服务进程 pid> [--rounds N]');
    process.exit(2);
  }
  console.log(`服务端 pid=${PID}，轮次=${ROUNDS}`);

  // 清场
  for (const old of (await api('/api/sessions')).json?.data ?? []) {
    await api(`/api/sessions/${encodeURIComponent(old.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  await sleep(1500);

  const base = metrics();
  console.log(`基线：RSS=${(base.rssKb / 1024).toFixed(1)}MB fd=${base.fds} threads=${base.threads}`);

  // 预热：让分配器进入稳态
  for (let i = 0; i < 5; i += 1) await oneRound(i);
  await sleep(1500);
  const warm = metrics();
  console.log(`预热后：RSS=${(warm.rssKb / 1024).toFixed(1)}MB fd=${warm.fds} threads=${warm.threads}`);

  const samples = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    await oneRound(i);
    if (i % 10 === 9) {
      const m = metrics();
      samples.push(m);
      console.log(`  第 ${i + 1} 轮：RSS=${(m.rssKb / 1024).toFixed(1)}MB fd=${m.fds} threads=${m.threads} zombies=${m.zombies}`);
    }
  }

  // 全部回收后静置，等线程与 fd 归还
  await sleep(3000);
  for (const old of (await api('/api/sessions')).json?.data ?? []) {
    await api(`/api/sessions/${encodeURIComponent(old.id)}`, { method: 'DELETE' }).catch(() => {});
  }
  await sleep(3000);
  const after = metrics();
  const sessions = (await api('/api/sessions')).json?.data ?? [];
  console.log(`结束后：RSS=${(after.rssKb / 1024).toFixed(1)}MB fd=${after.fds} threads=${after.threads} 会话=${sessions.length}`);

  // 判定：RSS / fd / 线程都允许小幅增长（分配器缓存），但不能线性增长
  const rssGrowthMb = (after.rssKb - warm.rssKb) / 1024;
  const fdGrowth = after.fds - warm.fds;
  const threadGrowth = after.threads - warm.threads;

  check('无僵尸进程', after.zombies === 0, `zombies=${after.zombies}`);
  check('会话表已清空', sessions.length === 0, `剩余 ${sessions.length} 个`);
  check('RSS 未随轮次线性增长', rssGrowthMb < 8, `相对预热基线增长 ${rssGrowthMb.toFixed(2)}MB（${ROUNDS} 轮）`);
  check('fd 未随轮次线性增长', fdGrowth <= 4, `相对预热基线增长 ${fdGrowth} 个`);
  check('线程数未随轮次线性增长', threadGrowth <= 4, `相对预热基线增长 ${threadGrowth} 个`);

  // 单独确认：fd 增量应与「同时存活会话数」相关，而不是与总轮次相关
  const mid = samples.length ? samples[samples.length - 1] : warm;
  check('中途中 fd 保持在合理范围', mid.fds - warm.fds <= 4, `峰值 fd=${mid.fds}（基线 ${warm.fds}）`);

  const failed = checks.filter((x) => !x.ok);
  console.log(`\n结果：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length > 0) {
    console.error('失败的检查：' + failed.map((x) => x.name).join('、'));
    process.exit(1);
  }
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
