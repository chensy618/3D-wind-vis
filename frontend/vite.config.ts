import { defineConfig } from 'vite';

// public/data -> ../data/web (symlink) holds the common-schema exports
export default defineConfig({
  base: './',
  server: { host: '127.0.0.1', port: 5173 },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { main: 'index.html', surface: 'surface.html' } },
  },
});
