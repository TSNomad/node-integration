import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node-integration',
    setupFiles: ['./test/network-guard.ts'],
  },
});
