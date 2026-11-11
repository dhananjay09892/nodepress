import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server hosts the built app at /admin. In development, `vite` serves it on :5173 and
// forwards API calls to a server on :3000 (run `pnpm dev` at the repo root with COOKIE_SECURE=false).
export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/uploads': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', sourcemap: true },
});
