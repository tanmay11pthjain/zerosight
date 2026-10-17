import { defineConfig } from 'vite';

// In dev, the API runs separately on :8787 (see ../dev.mjs) and is proxied here.
// In production, VITE_API_URL points the static build at the Render service.
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:8787', '/healthz': 'http://localhost:8787' },
  },
  build: { target: 'es2022' },
  test: {
    env: { VITE_API_URL: 'http://127.0.0.1:8799' },
    testTimeout: 30_000,
  },
});
