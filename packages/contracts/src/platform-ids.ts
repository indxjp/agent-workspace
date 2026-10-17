import { z } from 'zod';

/**
 * ADR-0133 D1: the external hosts an agent is exported or published to, in wire order. This leaf
 * module holds only the ids so `portable-agent.ts` can name them without importing `platforms.ts`,
 * which in turn imports the portable path schema; `platforms.ts` re-exports everything here.
 *
 * `aws-agentcore` here names the managed AWS agent host an agent is published to. It is not the
 * runtime driver `aws-agentcore` (`RUNTIME_DRIVERS` in `./runtimes.ts`), which names where a run's
 * sandbox executes; the two share a word and nothing else.
 */
export const PLATFORM_IDS = [
  'claude-managed-agents',
  'copilot-studio',
  'm365-declarative-agent',
  'microsoft-foundry',
  'gemini-enterprise',
  'aws-agentcore',
  'eject-claude-agent-sdk',
  'eject-mastra',
  'eject-openai-agents',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];
export const PlatformIdSchema = z.enum(PLATFORM_IDS);

/** The platforms that host and run the agent (publish targets); the eject-* ids only export code. */
export const HOSTED_PLATFORM_IDS = [
  'claude-managed-agents',
  'copilot-studio',
  'm365-declarative-agent',
  'microsoft-foundry',
  'gemini-enterprise',
  'aws-agentcore',
] as const satisfies readonly PlatformId[];
export type HostedPlatformId = (typeof HOSTED_PLATFORM_IDS)[number];
