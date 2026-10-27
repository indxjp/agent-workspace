import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['apps/web', 'apps/runner'],
    coverage: {
      provider: 'v8',
      include: ['apps/web/server/**/*.ts', 'apps/web/app/api/**/*.ts', 'apps/runner/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts', '**/acceptance/**'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage/apps',
      thresholds: {
        // Ratcheted by scripts/check-coverage-ratchet.mjs: within 5 points of measured. Raise it; never
        // drop or remove it.
        lines: 88,
        functions: 90,
        statements: 86,
        branches: 80,
      },
    },
  },
});
