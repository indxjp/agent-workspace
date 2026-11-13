/**
 * The exact versions an ejected project pins. Each equals the version of the same name in the
 * engine adapter's manifest, which `tests/platforms/eject-pins.test.ts` enforces. A literal object
 * and not a lookup: `tests/no-sdk-import.test.ts` refuses a call that is handed an SDK package name.
 * `typescript` is the plain registry release of the build the repository installs under an alias.
 */
export const EJECT_PINS = {
  '@anthropic-ai/claude-agent-sdk': '0.3.316',
  '@mastra/core': '1.81.0',
  '@mastra/mcp': '2.7.0',
  '@openai/agents': '0.21.0',
  '@openai/agents-extensions': '0.21.0',
  '@ai-sdk/anthropic': '4.0.94',
  zod: '4.6.7',
  '@types/node': '26.6.6',
  typescript: '6.0.2',
} as const;

/**
 * The module an eject target imports, so a target never spells the name at a call. A subpath is
 * listed where the adapter imports the subpath.
 */
export const EJECT_SDK_PACKAGES = {
  'claude-agent-sdk': '@anthropic-ai/claude-agent-sdk',
  'mastra-agent': '@mastra/core/agent',
  'mastra-workspace': '@mastra/core/workspace',
  'mastra-tools': '@mastra/core/tools',
  'mastra-mcp': '@mastra/mcp',
  'openai-agents': '@openai/agents',
  'openai-agents-ai-sdk': '@openai/agents-extensions/ai-sdk',
  'ai-sdk-anthropic': '@ai-sdk/anthropic',
} as const;
