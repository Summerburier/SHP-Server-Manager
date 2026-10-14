import { defineConfig, loadEnv } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = `http://127.0.0.1:${process.env.PORT || env.PORT || 7999}`;
  return {
  plugins: [vue()],
  publicDir: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target, changeOrigin: false }, '/healthz': { target, changeOrigin: false } }
  },
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 }
  };
});
