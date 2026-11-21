import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/gateway',
      'packages/run-protocol',
      'packages/runtime',
      'packages/skills-office',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/core/src/**/*.ts',
        'packages/gateway/src/**/*.ts',
        'packages/run-protocol/src/**/*.ts',
        'packages/runtime/src/**/*.ts',
        'packages/skills-office/office-writer/scripts/**/*.mjs',
        'packages/skills-office/office-reader/scripts/lib/**/*.mjs',
      ],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 85,
        functions: 86,
        statements: 82,
        branches: 74,
        // The office-writer skill's scripts run in a run's sandbox on model-written input
        // (ADR-0167): each file is held at 100% (`*.mjs` leaves out the `.d.mts` types). Kept
        // after the four global floors, which scripts/check-coverage-ratchet.mjs reads first.
        'packages/skills-office/office-writer/scripts/**/*.mjs': {
          perFile: true,
          lines: 100,
          functions: 100,
          statements: 100,
          branches: 100,
        },
        // The table reader and command line a use case's skill script imports (ADR-0173), held
        // the same way: every AN entry's calculation runs on them.
        'packages/skills-office/office-reader/scripts/lib/**/*.mjs': {
          perFile: true,
          lines: 100,
          functions: 100,
          statements: 100,
          branches: 100,
        },
      },
    },
  },
});
