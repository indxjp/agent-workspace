import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/gateway', 'packages/runtime'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**/*.ts',
        'packages/gateway/src/**/*.ts',
        'packages/runtime/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 60,
        functions: 60,
        statements: 60,
        branches: 50,
      },
    },
  },
});
