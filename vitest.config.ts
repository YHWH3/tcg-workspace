import { defineConfig } from 'vitest/config';

// Vitest loads this file instead of vite.config.ts. Unit tests are pure TS in
// tests/ — the @cloudflare/vite-plugin in the app config provisions a remote
// Workers AI binding and would require CLOUDFLARE_API_TOKEN just to run tests.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several files start a real Workerd/D1 runtime. Bound local concurrency
    // so fixture RPCs do not compete. Large integrity fixtures made two
    // simultaneous runtimes intermittently reset their local RPC sockets.
    maxWorkers: 1,
    // Real D1 migration/runtime startup must have a useful bounded timeout;
    // these are correctness tests, while workload latency is recorded separately.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
