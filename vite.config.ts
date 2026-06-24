import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        popup: resolve(__dirname, 'popup/popup.html'),
        offscreen: resolve(__dirname, 'offscreen/offscreen.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // background.js must be static (no hash) because manifest.json references it
          if (chunkInfo.name === 'background') {
            return 'assets/background.js';
          }
          // Popup and other chunks get hashed (not referenced by manifest)
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // Reserve __dirname for ESM:
  define: {
    __dirname: JSON.stringify(__dirname),
  },
});
