/**
 * SDK conformance, agents: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PLATFORM_TARGETS } from '@indx-workspace/platforms';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import {
  AgentGrantsSchema,
  AgentPolicySchema,
  AgentResourceSchema,
} from '@indx-workspace/contracts/agents';
import { ProjectResourceSchema } from '@indx-workspace/contracts/projects';
import {
  ENGINE_IDS,
  ENGINE_PROBLEM_CODES,
  EngineCapabilitiesSchema,
  EngineListResponseSchema,
} from '@indx-workspace/contracts/engines';
import { PlatformListResponseSchema } from '@indx-workspace/contracts/platforms';
import { toAgentResource } from './agents/contract';
import { compiledPolicyFor, policyFor } from './agents/policy';
import { listEngines } from './engines/handlers';
import { listPlatforms } from './platforms/catalogue';
import { clearEnginesRegisteredForTests, registerEngineForTests } from './engines/registry';
import { toProjectResource } from './projects/resource';
import { WORKSPACE, AGENT } from './sdk-conformance.test-support';

describe('agents and projects', () => {
  it('renders the grants route body as the strict principal-id contract', () => {
    const body = { principalIds: ['77777777-7777-4777-8777-777777777777'] };
    expect(AgentGrantsSchema.parse(body)).toEqual(body);
  });

  it('serialises an agent record into the published shape', () => {
    const resource = toAgentResource({
      id: AGENT,
      workspaceId: WORKSPACE,
      name: 'Support',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      policy: null,
      createdBy: null,
      ownerPrincipalId: 'principal-1',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    });
    expect(AgentResourceSchema.safeParse(resource).success).toBe(true);
  });

  it('serialises the compiled policy (NULL column) into the published AgentPolicy shape (S-13)', () => {
    const compiled = compiledPolicyFor(
      { readFiles: true, writeFiles: false, runCommands: false, unrestrictedNetwork: true },
      ['triage'],
    );
    const parsed = AgentPolicySchema.safeParse(compiled);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });
});

describe('agents and projects', () => {
  it('serialises a stored policy through policyFor into the published AgentPolicy shape (S-13)', () => {
    const stored = {
      engine: 'claude-agent-sdk' as const,
      tools: {
        base: 'claude_code_preset' as const,
        autoApprove: ['mcp__github__*'],
        deny: ['Bash'],
        permissionMode: 'default' as const,
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'all' as const },
      limits: { maxTurns: 25, maxBudgetUsd: 10 },
    };
    const agent = {
      id: AGENT,
      workspaceId: WORKSPACE,
      name: 'Support',
      instructions: '',
      modelConnectionId: null,
      model: null,
      runtimeProfileId: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      policy: stored,
      createdBy: null,
      ownerPrincipalId: 'principal-1',
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    };
    const served = policyFor(agent, []);
    expect(served).toEqual(stored);
    const parsed = AgentPolicySchema.safeParse(served);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
  });
});

describe('agents and projects', () => {
  it('serialises a project record into the published shape', () => {
    const resource = toProjectResource(
      {
        id: '66666666-6666-4666-8666-666666666666',
        workspaceId: WORKSPACE,
        name: 'Ops',
        instructions: null,
        defaultAgentId: AGENT,
        defaultModelConnectionId: null,
        defaultModel: null,
        visibility: 'workspace',
        createdBy: null,
        ownerPrincipalId: 'principal-1',
        archivedAt: new Date('2026-09-21T11:00:00.000Z'),
        createdAt: new Date('2026-09-21T10:00:00.000Z'),
        updatedAt: new Date('2026-09-21T10:00:00.000Z'),
      },
      ['f1'],
      [],
    );
    expect(ProjectResourceSchema.safeParse(resource).success).toBe(true);
  });
});

describe('engines (issue #319, ENG-02c)', () => {
  afterEach(clearEnginesRegisteredForTests);

  it('renders the real registry through listEngines into the published catalogue', () => {
    const result = listEngines();

    expect(result.status).toBe(200);
    const parsed = EngineListResponseSchema.parse(result.body);
    // The acceptance criterion, against the body the route actually produces.
    expect(parsed.engines).toEqual([
      expect.objectContaining({
        id: 'claude-agent-sdk',
        installed: true,
        capabilities: expect.objectContaining({ wireProtocols: ['anthropic-messages'] }) as unknown,
      }),
      // Registered since ENG-09 (#308); not installed under the development image map (ADR-0073).
      expect.objectContaining({
        id: 'openai-agents',
        installed: false,
        capabilities: expect.objectContaining({
          maxBudget: 'adapter',
          wireProtocols: ['openai-responses', 'openai-chat-completions', 'anthropic-messages'],
        }) as unknown,
      }),
      // Registered since ENG-08 (#307); not installed under the development image map either.
      expect.objectContaining({
        id: 'pi',
        installed: false,
        capabilities: expect.objectContaining({
          mcp: false,
          maxTurns: 'adapter',
          wireProtocols: ['anthropic-messages'],
        }) as unknown,
      }),
      // Registered since ENG-10 (#309); not installed under the development image map either.
      expect.objectContaining({
        id: 'mastra',
        installed: false,
        capabilities: expect.objectContaining({
          mcp: true,
          fork: false,
          maxTurns: 'native',
          wireProtocols: ['anthropic-messages', 'openai-responses', 'openai-chat-completions'],
        }) as unknown,
      }),
    ]);
  });

  it('keeps the served catalogue inside the ids the contracts publish', () => {
    for (const engine of EngineListResponseSchema.parse(listEngines().body).engines) {
      expect(ENGINE_IDS as readonly string[]).toContain(engine.id);
    }
  });
});

describe('engines (issue #319, ENG-02c)', () => {
  afterEach(clearEnginesRegisteredForTests);

  it('answers a registry the contract cannot express as a published problem, not a short list', () => {
    registerEngineForTests({
      id: 'not-an-engine-the-contracts-publish',
      displayName: 'Test engine',
      version: '0.0.0',
      capabilities: EngineCapabilitiesSchema.parse({
        mcp: false,
        skills: false,
        subagents: false,
        resume: false,
        fork: false,
        interrupt: false,
        streamingText: false,
        reasoning: false,
        maxTurns: 'adapter',
        maxBudget: 'none',
        wireProtocols: ['anthropic-messages'],
      }),
    });

    const result = listEngines();

    expect(result.status).toBe(ENGINE_PROBLEM_CODES.engine_catalogue_invalid);
    expect(ApiProblemSchema.parse(result.body).error.code).toBe('engine_catalogue_invalid');
  });
});

describe('platforms (issue #968)', () => {
  it('renders every registered target into the published catalogue', () => {
    const parsed = PlatformListResponseSchema.parse(listPlatforms().body);

    expect(parsed.platforms.map((platform) => platform.id)).toStrictEqual(
      PLATFORM_TARGETS.map((target) => target.id),
    );
  });
});
