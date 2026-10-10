import { defineConfig } from 'vite';

const apiPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': `http://localhost:${apiPort}`,
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
