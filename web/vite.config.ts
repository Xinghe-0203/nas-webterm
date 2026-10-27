import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 构建前清掉上一轮的哈希产物，避免旧文件堆积进安装包。
 * 不能用 emptyOutDir：app/ui/config 是飞牛桌面入口配置，必须保留。
 */
function cleanOldAssets(uiDir: string): Plugin {
  return {
    name: 'nas-webterm-clean-assets',
    buildStart() {
      const assetsDir = join(uiDir, 'assets');
      if (existsSync(assetsDir)) rmSync(assetsDir, { recursive: true, force: true });
      if (!existsSync(uiDir)) return;
      for (const entry of readdirSync(uiDir)) {
        const p = join(uiDir, entry);
        if (statSync(p).isFile() && /^index-[^/]*\.(js|css)$/.test(entry)) {
          rmSync(p, { force: true });
        }
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [cleanOldAssets(new URL('../app/ui', import.meta.url).pathname)],
  build: {
    outDir: '../app/ui',
    emptyOutDir: false,
    assetsDir: 'assets',
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
