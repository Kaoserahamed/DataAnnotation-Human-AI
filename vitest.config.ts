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
    ],
  },
});
