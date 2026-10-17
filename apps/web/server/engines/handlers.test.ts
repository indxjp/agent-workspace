import { afterEach, describe, expect, it } from 'vitest';

import {
  EngineListResponseSchema,
  type EngineCapabilities,
} from '@indx-workspace/contracts/engines';

import { listEngines } from './handlers';
import {
  CLAUDE_AGENT_SDK_VERSION,
  MASTRA_CORE_VERSION,
  OPENAI_AGENTS_SDK_VERSION,
  PI_CODING_AGENT_VERSION,
  clearEnginesRegisteredForTests,
  registerEngineForTests,
} from './registry';

afterEach(clearEnginesRegisteredForTests);

const CLAUDE_CAPABILITIES = {
  mcp: true,
  skills: true,
  subagents: true,
  resume: true,
  fork: false,
  interrupt: true,
  streamingText: false,
  reasoning: true,
  maxTurns: 'native',
  maxBudget: 'native',
  wireProtocols: ['anthropic-messages'],
} as const satisfies EngineCapabilities;

describe('listEngines', () => {
  it('answers the catalogue this deployment registers, enveloped', () => {
    const result = listEngines();

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      engines: [
        {
          id: 'claude-agent-sdk',
          displayName: 'Claude Agent SDK',
          version: CLAUDE_AGENT_SDK_VERSION,
          capabilities: { ...CLAUDE_CAPABILITIES },
          installed: true,
        },
        {
          id: 'openai-agents',
          displayName: 'OpenAI Agents SDK',
          version: OPENAI_AGENTS_SDK_VERSION,
          capabilities: {
            mcp: true,
            skills: false,
            subagents: true,
            resume: true,
            fork: false,
            interrupt: true,
            streamingText: true,
            reasoning: true,
            maxTurns: 'native',
            maxBudget: 'adapter',
            wireProtocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
          },
          // The development default map offers only the Claude image (ADR-0073 D7).
          installed: false,
        },
        {
          id: 'pi',
          displayName: 'pi coding agent',
          version: PI_CODING_AGENT_VERSION,
          capabilities: {
            mcp: false,
            skills: true,
            subagents: false,
            resume: true,
            fork: true,
            interrupt: true,
            streamingText: true,
            reasoning: true,
            maxTurns: 'adapter',
            maxBudget: 'adapter',
            wireProtocols: ['anthropic-messages'],
          },
          installed: false,
        },
        {
          id: 'mastra',
          displayName: 'Mastra',
          version: MASTRA_CORE_VERSION,
          capabilities: {
            mcp: true,
            skills: true,
            subagents: true,
            resume: true,
            fork: false,
            interrupt: true,
            streamingText: true,
            reasoning: true,
            maxTurns: 'native',
            maxBudget: 'adapter',
            wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
          },
          installed: false,
        },
      ],
    });
  });

  it('answers a body the published contract validates, which is what the SDK decodes', () => {
    const parsed = EngineListResponseSchema.safeParse(listEngines().body);

    expect(parsed.success).toBe(true);
  });

  it('refuses to publish a catalogue the contract cannot express, rather than filtering it', () => {
    // A descriptor whose id `ENGINE_IDS` does not list — the registry admits one so a refusal can
    // be proved at all (see `registry.ts`), and here it is the deployment that is misconfigured.
    registerEngineForTests({
      id: 'acp',
      displayName: 'ACP agent',
      version: '0.0.1',
      capabilities: { ...CLAUDE_CAPABILITIES, mcp: false },
    });

    const result = listEngines();

    expect(result.status).toBe(500);
    expect(result.body).toEqual({
      error: { code: 'engine_catalogue_invalid', message: expect.any(String) as unknown },
    });
    // The point of the refusal: the caller is not handed a shorter list it would read as complete.
    expect(JSON.stringify(result.body)).not.toContain('claude-agent-sdk');
  });
});
