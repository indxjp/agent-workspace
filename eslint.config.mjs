import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-embedded/**',
      '**/coverage/**',
      '**/next-env.d.ts',
      // Runtime-facing .mjs declarations are checked by tsconfig.root.json. ESLint's
      // project service does not attach .d.mts files to that configured project even
      // when tsc lists them, so linting the declarations themselves cannot run.
      '**/*.d.mts',
      // Static HTML/JS design mockups and specification prose, not workspace source.
      'ui/**',
      'docs/**',
      // Agent working state, not source. A wave runs its parallel tasks in git
      // worktrees under .claude/worktrees/, and each one is a FULL checkout of this
      // repository. `**/node_modules/**` and `**/dist/**` above already exclude the
      // bulky parts, but every worktree's own apps/ and packages/ sources are still
      // matched — and because this config lints type-aware (see below), each copy
      // costs a whole TypeScript program. At the time this entry was added the tree
      // held 54 worktrees and `pnpm lint` died with "Ineffective mark-compacts near
      // heap limit" at --max-old-space-size=8192.
      //
      // It failed only locally: CI checks out a clean tree where this directory does
      // not exist, so every PR was green while the same command on the same commit
      // aborted on the machine running the wave. A gate whose verdict depends on
      // directories only one clone has is not a gate. See ADR-0039.
      '.claude/worktrees/**',
    ],
  },
  js.configs.recommended,
  // Type-aware, not just syntactic. The rules worth the most to an async agent
  // runtime - no-floating-promises, no-misused-promises, await-thenable - cannot
  // fire without a TypeScript program behind them, and retrofitting this after a
  // dozen packages exist is far more expensive than paying for it now.
  // See docs/adr/W0-INF-01-type-aware-linting.md.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Every other linted .ts/.tsx file is inside its package's own
          // tsconfig.json, tests included. Tool configs at the workspace root
          // are checked through tsconfig.root.json.
          allowDefaultProject: [
            'vitest.config.ts',
            'vitest.coverage.config.ts',
            'vitest.apps.coverage.config.ts',
            'vitest.ui-cli.coverage.config.ts',
            'playwright.config.ts',
          ],
          defaultProject: 'tsconfig.root.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/acceptance/**'],
    rules: {
      // Review tripwires set at today's reduced production maximum. Lower this ratchet whenever
      // the current hotspot is simplified; do not raise it for new code.
      complexity: ['error', { max: 33 }],
      'max-depth': ['error', 5],
    },
  },
  {
    // The conformance kit and the tests of packages/platforms are outside its production
    // tsconfig.json (which has no Node types), so they are linted through tsconfig.test.json.
    files: ['packages/platforms/src/testing/**/*.ts', 'packages/platforms/src/**/*.test.ts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './packages/platforms/tsconfig.test.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // ADR-0133 D6: a platform translator is a pure function of its input. `node:*` imports are
    // refused by the `platforms-are-pure` dependency rule; these are the globals that rule cannot
    // see. The conformance kit and the tests are exempt: they read golden files and the environment.
    files: ['packages/platforms/src/**/*.ts'],
    ignores: ['packages/platforms/src/testing/**', '**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['process', 'Date', 'fetch', 'Buffer'].map((name) => ({
          name,
          message: 'A platform translator is pure: no environment, clock or network (ADR-0133 D6).',
        })),
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'A platform translator is pure: no randomness (ADR-0133 D6).',
        },
      ],
    },
  },
  {
    // The two .mjs config files have no TypeScript program. tsc type-checks them
    // through tsconfig.root.json (allowJs + checkJs) instead.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The landing page's one script runs in the browser, not in Node.
    files: ['sites/lp/assets/site.js'],
    languageOptions: {
      sourceType: 'script',
      globals: Object.fromEntries(
        [
          'clearTimeout',
          'document',
          'history',
          'IntersectionObserver',
          'location',
          'navigator',
          'performance',
          'requestAnimationFrame',
          'setTimeout',
          'window',
        ].map((name) => [name, 'readonly']),
      ),
    },
  },
  {
    files: ['scripts/check-workflows.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  prettier,
);
