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
        // First enforced application floor. Raise from measured release-candidate evidence; never
        // drop or remove it to make a release green.
        lines: 20,
        functions: 20,
        statements: 20,
        branches: 15,
      },
    },
  },
});
