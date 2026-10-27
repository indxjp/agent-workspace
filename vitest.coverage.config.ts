import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/core', 'packages/gateway', 'packages/run-protocol', 'packages/runtime'],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**/*.ts',
        'packages/gateway/src/**/*.ts',
        'packages/run-protocol/src/**/*.ts',
        'packages/runtime/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 85,
        functions: 86,
        statements: 82,
        branches: 74,
      },
    },
  },
});
