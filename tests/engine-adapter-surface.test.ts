/**
 * Each engine adapter's package root exports one value: its factory (W3-8, F-22).
 *
 * The runner's registry (`apps/runner/src/engines.ts`) calls that factory and nothing else, so a
 * second value export on the root is surface no consumer needs. The adapter's internals stay
 * reachable for this repository's tests through `@agent-workspace/engine-<id>/testing`.
 */
import { describe, expect, it } from 'vitest';

// Literal specifiers. The `tests` project resolves them through `node_modules` to each
// package's built `dist`, not through the root `vitest.config.ts` aliases, so build first.
const ADAPTERS: readonly (readonly [string, () => Promise<object>])[] = [
  ['createClaudeAgentSdkEngine', () => import('@agent-workspace/engine-claude-agent-sdk')],
  ['createMastraEngine', () => import('@agent-workspace/engine-mastra')],
  ['createOpenAiAgentsEngine', () => import('@agent-workspace/engine-openai-agents')],
  ['createPiEngine', () => import('@agent-workspace/engine-pi')],
];

describe('engine adapter package roots', () => {
  it.each(ADAPTERS)('the root exporting %s exports nothing else', async (factory, load) => {
    const module = (await load()) as Record<string, unknown>;
    expect(Object.keys(module)).toEqual([factory]);
    expect(typeof module[factory]).toBe('function');
  });
});
