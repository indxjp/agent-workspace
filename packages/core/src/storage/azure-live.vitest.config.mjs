/**
 * Credentialed Azure proofs are acceptance suites, not ordinary unit tests. Keeping them outside
 * Vitest's `*.test.ts`/`*.spec.ts` discovery means `pnpm test` cannot report a green skipped proof;
 * this config is the only entry point and missing credentials fail the run instead of skipping it.
 *
 * Run from the repository root after `pnpm build`:
 *
 * ```sh
 * pnpm exec vitest run --config packages/core/src/storage/azure-live.vitest.config.mjs
 * ```
 */
import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../../../', import.meta.url)),
  test: {
    include: [
      'packages/core/src/storage/azure-blob-store.live.acceptance.ts',
      'packages/core/src/secrets/azure-key-vault-master-key-provider.live.acceptance.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
