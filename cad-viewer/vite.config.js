import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works from any folder or sub-path (e.g. GitHub Pages).
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@mlightcad/libredwg-web'] },
});
