import { defineConfig, type Plugin } from 'vite';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 清理上一轮的构建产物。
 *
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

export default defineConfig(({ mode }) => {
  // WITH_AI=0 构建普通版：AI 模块不进 bundle，AI 相关 DOM 也不进页面
  const withAi = process.env.WITH_AI !== '0';
  const uiDir = new URL('../app/ui', import.meta.url).pathname;

  return {
    base: './',
    define: {
      // 供前端在编译期判断是不是 AI 版
      __WITH_AI__: JSON.stringify(withAi),
    },
    plugins: [cleanOldAssets(uiDir)],
    build: {
      outDir: '../app/ui',
      emptyOutDir: false,
      assetsDir: 'assets',
      target: 'es2020',
      sourcemap: false,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        // 普通版直接不打包 ai/ 目录下的模块
        ...(withAi
          ? {}
          : {
              external: [/.*\/ai\/.*/],
            }),
      },
    },
    server: {
      port: 5173,
      strictPort: false,
    },
  };
});
