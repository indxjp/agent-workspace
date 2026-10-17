import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { ENGINE_IDS, EngineDescriptorSchema } from '@indx-workspace/contracts/engines';

import {
  CLAUDE_AGENT_SDK_VERSION,
  MASTRA_CORE_VERSION,
  OPENAI_AGENTS_SDK_VERSION,
  PI_CODING_AGENT_VERSION,
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
  registeredEngineIds,
  registeredEngines,
  type RegisteredEngine,
} from './registry';

/** An engine the contracts do not publish yet: the next unit's, as a test-only descriptor. */
const ACP: RegisteredEngine = {
  id: 'acp',
  displayName: 'ACP agent',
  version: '0.0.1',
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
};

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('registeredEngines', () => {
  it('always registers claude-agent-sdk, installed, over Anthropic Messages', () => {
    const engines = registeredEngines();
    expect(engines).toHaveLength(4);
    const claude = engines[0];
    expect(claude?.id).toBe('claude-agent-sdk');
    expect(claude?.installed).toBe(true);
    expect(claude?.capabilities.wireProtocols).toEqual(['anthropic-messages']);
  });

  it('answers a descriptor that satisfies the published contract', () => {
    for (const engine of registeredEngines()) {
      expect(EngineDescriptorSchema.safeParse(engine).success).toBe(true);
    }
  });

  it('registers exactly the engines the contracts publish, and no more', () => {
    expect(registeredEngineIds()).toEqual([...ENGINE_IDS]);
  });

  it('answers null for an engine this deployment does not register', () => {
    expect(registeredEngine('acp')).toBeNull();
    expect(registeredEngine('claude-agent-sdk')?.displayName).toBe('Claude Agent SDK');
  });

  /**
   * The restatement gate. `apps/web` cannot import the runner's manifest, so the version is a
   * constant; this reads the manifest the platform actually installs and compares. A pinned-version
   * bump that forgets the control plane fails here rather than misreporting to a support engineer.
   */
  it('reports the pinned Claude Agent SDK version the adapter package installs', () => {
    // Resolved from this file, not from the working directory: `pnpm test` and a per-project vitest
    // run start in different places, and a path that only works in one of them is a gate that
    // passes because it could not run.
    const manifestPath = fileURLToPath(
      new URL('../../../../packages/engine-claude-agent-sdk/package.json', import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const pinned =
      manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'] ??
      manifest.devDependencies?.['@anthropic-ai/claude-agent-sdk'];
    expect(pinned).toBe(CLAUDE_AGENT_SDK_VERSION);
  });

  it('registers openai-agents with Responses first and reports the version its adapter pins', () => {
    const openai = registeredEngine('openai-agents');
    expect(openai?.displayName).toBe('OpenAI Agents SDK');
    expect(openai?.capabilities.wireProtocols).toEqual([
      'openai-responses',
      'openai-chat-completions',
      'anthropic-messages',
    ]);
    expect(openai?.capabilities.skills).toBe(false);
    const manifestPath = fileURLToPath(
      new URL('../../../../packages/engine-openai-agents/package.json', import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@openai/agents']).toBe(OPENAI_AGENTS_SDK_VERSION);
  });

  it('registers pi over Anthropic Messages, without MCP, at the version its adapter pins (ENG-08, #307)', () => {
    const pi = registeredEngine('pi');
    expect(pi?.displayName).toBe('pi coding agent');
    expect(pi?.capabilities).toEqual({
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
    });
    const manifestPath = fileURLToPath(
      new URL('../../../../packages/engine-pi/package.json', import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@earendil-works/pi-coding-agent']).toBe(
      PI_CODING_AGENT_VERSION,
    );
  });
});

describe('the Mastra descriptor', () => {
  it('registers Mastra with MCP and skills, no fork, on three protocols, at its pinned version (ENG-10, #309)', () => {
    const mastra = registeredEngine('mastra');
    expect(mastra?.displayName).toBe('Mastra');
    expect(mastra?.capabilities).toEqual({
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
    });
    const manifestPath = fileURLToPath(
      new URL('../../../../packages/engine-mastra/package.json', import.meta.url),
    );
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.['@mastra/core']).toBe(MASTRA_CORE_VERSION);
  });
});

describe('registerEngineForTests', () => {
  it('appends a descriptor whose id the contracts do not list', () => {
    registerEngineForTests(ACP);
    expect(registeredEngineIds()).toEqual([
      'claude-agent-sdk',
      'openai-agents',
      'pi',
      'mastra',
      'acp',
    ]);
    expect(registeredEngine('acp')?.capabilities.mcp).toBe(false);
  });

  it('validates the descriptor on the way in', () => {
    expect(() =>
      registerEngineForTests({
        ...ACP,
        capabilities: { ...ACP.capabilities, wireProtocols: [] },
      }),
    ).toThrow();
    expect(registeredEngineIds()).toEqual([...ENGINE_IDS]);
  });

  it('is undone by clearEnginesRegisteredForTests', () => {
    registerEngineForTests(ACP);
    clearEnginesRegisteredForTests();
    expect(registeredEngineIds()).toEqual([...ENGINE_IDS]);
  });

  // #318: the save-time capability refusal can only be reached through a `claude-agent-sdk`
  // descriptor that lacks a capability, because `AgentPolicy` has no other arm for a body to name.
  it('replaces a descriptor whose id is already registered, in place', () => {
    registerEngineForTests({
      ...ACP,
      id: 'claude-agent-sdk',
      displayName: 'Claude Agent SDK (no MCP)',
    });
    expect(registeredEngineIds()).toEqual([...ENGINE_IDS]);
    expect(registeredEngine('claude-agent-sdk')?.capabilities.mcp).toBe(false);
  });

  it('keeps the catalogue order when it replaces and when it appends', () => {
    registerEngineForTests(ACP);
    registerEngineForTests({
      ...ACP,
      id: 'claude-agent-sdk',
      capabilities: ACP.capabilities,
    });
    // Exactly once each, `claude-agent-sdk` still first: the order is the catalogue's, never the
    // order a test happened to register in (which is what `GET /api/engines` will project).
    expect(registeredEngineIds()).toEqual([
      'claude-agent-sdk',
      'openai-agents',
      'pi',
      'mastra',
      'acp',
    ]);
  });
});
