import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        oxc: { jsx: { runtime: 'automatic' } },
        test: {
          name: 'web-ui',
          root: 'apps/web',
          include: ['components/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'cli',
          root: 'packages/cli',
          include: ['src/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['apps/web/components/**/*.{ts,tsx}', 'packages/cli/src/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage/ui-cli',
      thresholds: {
        // Measured independently from server/package coverage so UI and CLI regressions cannot be
        // diluted by well-covered infrastructure. Ratchet upward with interaction coverage.
        lines: 47,
        functions: 39,
        statements: 46,
        branches: 45,
      },
    },
  },
});
