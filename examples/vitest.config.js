import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
