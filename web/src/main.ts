import './style.css';
import { App } from './app';

interface FnConfig {
  base?: string;
  baseRaw?: string;
  version?: string;
  appName?: string;
  displayName?: string;
}

const fn = (window as unknown as { __FN__?: FnConfig }).__FN__ ?? {};

/** 网关前缀由服务端注入；本地开发时退回相对路径。 */
function resolveBase(): string {
  const raw = fn.baseRaw || fn.base || '';
  if (!raw || raw.includes('__FN_')) return './';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

async function boot(): Promise<void> {
  const base = resolveBase();
  let startupCommand = '';
  try {
    const res = await fetch(`${base}api/config`, { credentials: 'same-origin' });
    const json = await res.json();
    if (json?.ok) startupCommand = String(json.data?.startupCommand ?? '');
  } catch {
    /* 配置拉取失败不阻塞终端 */
  }
  const app = new App({ base, fontSize: 14, startupCommand });
  app.start();
}

void boot();
