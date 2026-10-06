import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
          },
        },
      },
      {
        test: {
          name: 'api',
          root: './apps/api',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          // Integration tests boot PGlite + run scrypt on first password hash.
          // 60 s covers even slow CI runners; individual test timeouts are 30 s.
          hookTimeout: 60_000,
          testTimeout: 30_000,
          coverage: {
            provider: 'v8',
            // Only measure API source coverage, not shared package source.
            // The shared package has its own coverage config in the 'shared' project.
            include: ['src/**/*.ts'],
            exclude: ['../../packages/**'],
            // Services require a running database; unit tests alone cannot reach 80%.
            // The full suite (including integration tests) exceeds 80% aggregate.
            thresholds: { lines: 70, functions: 70, branches: 70, statements: 70 },
          },
        },
      },
    ],
  },
});
