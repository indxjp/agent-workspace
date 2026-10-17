import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@agent-workspace/gateway/providers/registry',
        replacement: fileURLToPath(
          new URL('./packages/gateway/src/providers/registry.ts', import.meta.url),
        ),
      },
      {
        find: '@agent-workspace/gateway',
        replacement: fileURLToPath(new URL('./packages/gateway/src/index.ts', import.meta.url)),
      },
      {
        find: '@agent-workspace/core',
        replacement: fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
      },
      // The two SDK packages resolve subpaths to their sources: `@indx-workspace/contracts/runs`
      // becomes `packages/contracts/src/runs.ts`, and the bare name becomes `src/index.ts`.
      {
        find: /^@indx-workspace\/contracts\/(.+)$/,
        replacement: fileURLToPath(new URL('./packages/contracts/src/$1.ts', import.meta.url)),
      },
      {
        find: '@indx-workspace/contracts',
        replacement: fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
      },
      // The SDK's subpaths come before the bare `@indx-workspace/sdk`, which is a prefix match:
      // after it, `@indx-workspace/sdk/define` would resolve to `src/index.ts/define`.
      {
        find: '@indx-workspace/sdk/define',
        replacement: fileURLToPath(new URL('./packages/sdk/src/define/index.ts', import.meta.url)),
      },
      {
        find: '@indx-workspace/sdk/events',
        replacement: fileURLToPath(new URL('./packages/sdk/src/events/index.ts', import.meta.url)),
      },
      {
        find: '@indx-workspace/sdk/portable',
        replacement: fileURLToPath(
          new URL('./packages/sdk/src/portable/index.ts', import.meta.url),
        ),
      },
      {
        find: '@indx-workspace/sdk/project',
        replacement: fileURLToPath(new URL('./packages/sdk/src/project/index.ts', import.meta.url)),
      },
      {
        find: '@indx-workspace/sdk/testing',
        replacement: fileURLToPath(new URL('./packages/sdk/src/testing.ts', import.meta.url)),
      },
      {
        find: '@indx-workspace/sdk',
        replacement: fileURLToPath(new URL('./packages/sdk/src/index.ts', import.meta.url)),
      },
      // `@indx-workspace/cli/create` before the bare name, which is a prefix of it.
      {
        find: '@indx-workspace/cli/create',
        replacement: fileURLToPath(new URL('./packages/cli/src/create.ts', import.meta.url)),
      },
      {
        find: '@indx-workspace/cli',
        replacement: fileURLToPath(new URL('./packages/cli/src/index.ts', import.meta.url)),
      },
      // `@indx-workspace/platforms/<subpath>` before the bare name, which is a prefix of them.
      {
        find: '@indx-workspace/platforms/aws-agentcore',
        replacement: fileURLToPath(
          new URL('./packages/platforms/src/targets/aws-agentcore/index.ts', import.meta.url),
        ),
      },
      {
        find: '@indx-workspace/platforms/testing',
        replacement: fileURLToPath(
          new URL('./packages/platforms/src/testing/index.ts', import.meta.url),
        ),
      },
      {
        find: '@indx-workspace/platforms',
        replacement: fileURLToPath(new URL('./packages/platforms/src/index.ts', import.meta.url)),
      },
      {
        find: '@agent-workspace/runtime',
        replacement: fileURLToPath(new URL('./packages/runtime/src/index.ts', import.meta.url)),
      },
      // ENG-04: the engine port and its adapters. `engine/testing` and the `engine-<id>` adapters
      // are listed before the bare `@agent-workspace/engine`, because these are prefix matches
      // and `@agent-workspace/engine` is a prefix of both.
      {
        find: '@agent-workspace/engine/testing',
        replacement: fileURLToPath(
          new URL('./packages/engine/src/testing/index.ts', import.meta.url),
        ),
      },
      {
        find: '@agent-workspace/engine-claude-agent-sdk',
        replacement: fileURLToPath(
          new URL('./packages/engine-claude-agent-sdk/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@agent-workspace/engine-mastra',
        replacement: fileURLToPath(
          new URL('./packages/engine-mastra/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@agent-workspace/engine-openai-agents',
        replacement: fileURLToPath(
          new URL('./packages/engine-openai-agents/src/index.ts', import.meta.url),
        ),
      },
      {
        find: '@agent-workspace/engine-pi',
        replacement: fileURLToPath(new URL('./packages/engine-pi/src/index.ts', import.meta.url)),
      },
      {
        find: '@agent-workspace/engine',
        replacement: fileURLToPath(new URL('./packages/engine/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    // Mirrors the `packages:` globs in pnpm-workspace.yaml (apps/*, packages/*)
    // so a workspace member added later is tested by default instead of being
    // silently skipped, which is what a hardcoded list caused.
    //
    // `tests` is listed explicitly because it is not a workspace member and never will be: it
    // holds the cross-cutting gates plan §9.1 names — `tests/sdk-surface.test.ts` asserts the
    // pinned SDK's option surface against docs/research/R-01-options.json, which belongs to no
    // single package. Without this entry those files are collected by nothing and `pnpm test`
    // reports a green run over a gate it never loaded, which is the same bug as a gate that
    // passes because it could not run. Added by W1-CORE-01; see
    // docs/adr/W1-CORE-01-surface-test-reads-the-dts.md.
    projects: ['apps/*', 'packages/*', 'tests'],
    // Playwright specs use a different runner and must never be imported as Vitest suites.
    exclude: [...configDefaults.exclude, 'tests/browser/**'],
  },
});
