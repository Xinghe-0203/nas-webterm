#!/usr/bin/env node
/**
 * 通过 GitHub Git Data API 发布提交。
 *
 * 为什么不用 git push：这台机器到 github.com 的 443 端口不通（只有 api.github.com 可达），
 * git smart-http 走不通，会报 "Error in the HTTP2 framing layer" / "Empty reply from server"；
 * 存着的 PAT 又没有 admin:public_key 权限，没法用 API 注册 SSH key。
 * 所以只能把 git 对象用 REST API 一层层建出来：blob → tree → commit → ref。
 *
 * 用法：
 *   node tools/push-via-api.mjs [owner/repo] [提交信息文件]
 *
 * 依赖：环境里存在带仓库权限的 token（默认读 .gh-greenwall/git-credentials）。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPO = process.argv[2] || 'Xinghe-0203/nas-webterm';
const MSG_FILE = process.argv[3] || path.join(ROOT, '.git', 'COMMIT_EDITMSG');
const MESSAGE = fs.readFileSync(MSG_FILE, 'utf8');

const CRED_CANDIDATES = [
  process.env.GH_CRED_FILE,
  '/vol2/1000/Code/AgentWorkspace/.gh-greenwall/git-credentials',
  path.join(process.env.HOME || '', '.git-credentials'),
].filter(Boolean);

function readToken() {
  for (const file of CRED_CANDIDATES) {
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8').trim();
    const m = raw.match(/^https:\/\/[^:]*:([^@]*)@github\.com/);
    if (m && m[1]) return m[1];
  }
  throw new Error(
    `找不到 GitHub token。已尝试：${CRED_CANDIDATES.join('、')}。\n` +
      '可用 GH_CRED_FILE 指定凭据文件，或设置同名环境变量。',
  );
}

const token = readToken();
const API = 'https://api.github.com';

async function api(pathname, method, body, tries = 5) {
  let lastErr = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`${API}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'nas-webterm-push',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${text.slice(0, 200)}`);
      return text ? JSON.parse(text) : null;
    } catch (e) {
      lastErr = e;
      // 4xx 是请求本身的问题，重试没有意义
      if (/-> 4\d\d/.test(e.message)) break;
      console.log(`  重试 ${i + 1}/${tries}: ${e.message.slice(0, 80)}`);
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

(async () => {
  const raw = execFileSync('git', ['ls-files', '-s'], { cwd: ROOT, encoding: 'utf8' });
  const entries = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [meta, filePath] = line.split('\t');
      const [mode, , sha] = meta.split(/\s+/);
      return { mode, path: filePath, sha };
    });
  console.log(`仓库 ${REPO}，待提交文件 ${entries.length} 个`);

  const tree = [];
  for (const [i, entry] of entries.entries()) {
    const content = fs.readFileSync(path.join(ROOT, entry.path));
    const blob = await api(`/repos/${REPO}/git/blobs`, 'POST', {
      content: content.toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: blob.sha });
    if ((i + 1) % 25 === 0) console.log(`  blob ${i + 1}/${entries.length}`);
  }

  const created = await api(`/repos/${REPO}/git/trees`, 'POST', { tree });
  console.log(`tree ${created.sha}`);

  const ref = await api(`/repos/${REPO}/git/ref/heads/main`, 'GET');
  const author = { name: 'Xinghe-0203', email: 'zoracn203@gmail.com' };
  const commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
    message: MESSAGE,
    tree: created.sha,
    parents: [ref.object.sha],
    author,
    committer: author,
  });
  await api(`/repos/${REPO}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false });
  console.log(`完成：https://github.com/${REPO}/commit/${commit.sha}`);
})().catch((e) => {
  console.error(`✗ ${e.message}`);
  process.exit(1);
});
