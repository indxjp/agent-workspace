import type { EngineId } from '@indx-workspace/contracts/engines';

/**
 * The npm packages each engine's adapter loads, at the exact versions the runtime of this release
 * was built and tested with. `@indx-workspace/embedded` declares them as optional peers, so a
 * project installs only the engine it picks: {@link projectDependencies} adds the one set.
 *
 * The local runtime's build (`packages/embedded/src/packaging/main.ts`) derives these sets from the
 * adapters it bundles and fails on any difference, printing the table to paste here.
 */
export const ENGINE_PACKAGES: Readonly<Record<EngineId, Readonly<Record<string, string>>>> = {
  'claude-agent-sdk': {
    '@anthropic-ai/claude-agent-sdk': '0.3.310',
    '@anthropic-ai/sdk': '0.137.0',
  },
  'openai-agents': {
    '@ai-sdk/anthropic': '4.0.85',
    '@openai/agents': '0.21.0',
    '@openai/agents-extensions': '0.21.0',
    ws: '8.22.0',
  },
  pi: {
    '@earendil-works/pi-agent-core': '1.4.0',
    '@earendil-works/pi-ai': '1.4.0',
    '@earendil-works/pi-codemode': '1.4.0',
    '@earendil-works/pi-coding-agent': '1.4.0',
    '@earendil-works/pi-mcp': '1.4.0',
    '@earendil-works/pi-telemetry': '1.4.0',
    '@earendil-works/pi-tui': '1.4.0',
  },
  mastra: {
    '@ai-sdk/anthropic': '4.0.85',
    '@ai-sdk/openai': '4.0.99',
    '@mastra/core': '1.79.0',
    '@mastra/mcp': '2.5.0',
    '@mastra/memory': '1.39.0',
  },
};

/**
 * The `dependencies` of a project `aw dev` runs: `@indx-workspace/aw`, `embedded` and `sdk` at
 * `version`, and the packages of the one engine it uses.
 */
export function projectDependencies(
  version: string,
  engine: EngineId,
): Readonly<Record<string, string>> {
  return {
    '@indx-workspace/aw': version,
    '@indx-workspace/embedded': version,
    '@indx-workspace/sdk': version,
    ...ENGINE_PACKAGES[engine],
  };
}
