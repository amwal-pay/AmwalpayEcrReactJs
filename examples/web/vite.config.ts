import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run build:web` writes web/dist, which the Node server (examples/server) serves.
// `npm run dev:web` serves the page with hot reload and forwards /api to that server.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The server's CSP has no inline script or style: keep every asset a file.
    assetsInlineLimit: 0,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5080', changeOrigin: false },
    },
  },
});
