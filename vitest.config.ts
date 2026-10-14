import { defineConfig } from 'vitest/config';

// Vitest loads this file instead of vite.config.ts. Unit tests are pure TS in
// tests/ — the @cloudflare/vite-plugin in the app config provisions a remote
// Workers AI binding and would require CLOUDFLARE_API_TOKEN just to run tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several files start a real Workerd/D1 runtime. Bound local concurrency
    // so fixture RPCs do not compete with one runtime per available CPU.
    maxWorkers: 2,
  },
});
