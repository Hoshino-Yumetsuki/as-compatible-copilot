import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const output = resolve(import.meta.dirname, 'static/assets/configView');

export default defineConfig({
  root: resolve(import.meta.dirname, 'webview'),
  plugins: [vue()],
  base: '',
  publicDir: false,
  build: {
    outDir: output,
    emptyOutDir: true,
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'configView.js',
        chunkFileNames: 'configView.js',
        assetFileNames: 'configView.[ext]'
      }
    }
  }
});
