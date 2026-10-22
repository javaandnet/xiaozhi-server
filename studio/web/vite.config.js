import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import AutoImport from 'unplugin-auto-import/vite';
import Components from 'unplugin-vue-components/vite';
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers';

// Built assets are served by the Node server under /firmware/app/ (and under
// /xiaozhi/firmware/app/ on the cloud namespace), so asset URLs must be
// relative — `base: './'` keeps the same bundle valid behind any prefix.
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    AutoImport({
      resolvers: [ElementPlusResolver()],
      dts: fileURLToPath(new URL('./src/auto-imports.d.ts', import.meta.url)),
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dts: fileURLToPath(new URL('./src/components.d.ts', import.meta.url)),
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: '../public/app',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        login: fileURLToPath(new URL('./login.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/firmware/api': { target: 'http://localhost:8003', changeOrigin: true },
      '/api': { target: 'http://localhost:8003', changeOrigin: true },
      '/health': { target: 'http://localhost:8003', changeOrigin: true },
    },
  },
});
