import { defineConfig } from 'vite';

// public/data -> ../data/web (symlink) holds the common-schema exports
export default defineConfig({
  base: './',
  // inotify misses edits on Lustre (LUMI scratch), so poll for changes
  server: { host: '127.0.0.1', port: 5173, watch: { usePolling: true, interval: 1000 } },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { main: 'index.html', surface: 'surface.html', compare: 'compare.html' } },
  },
});
