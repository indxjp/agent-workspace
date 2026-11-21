import { configDefaults, defineConfig } from 'vitest/config';

// The `use-cases` project: every `use-cases/**/*.test.ts`. The root vitest.config.ts lists it
// beside the workspace packages, as pnpm-workspace.yaml does. The coverage rule's fixtures run only
// in the child run of `kit/coverage.test.ts`, under their own config.
export default defineConfig({
  test: {
    name: 'use-cases',
    root: import.meta.dirname,
    // kit/templates.test.ts runs its probes in a child run with USE_CASES_PROBES=1; in any other run
    // a probe folder is one a killed run left behind, and not a test of this run.
    exclude: [
      ...configDefaults.exclude,
      'kit/fixtures/coverage-rule/**',
      ...(process.env['USE_CASES_PROBES'] === '1' ? [] : ['.template-probes-*/**']),
    ],
  },
});
