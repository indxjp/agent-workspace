import { afterEach, describe, expect, it } from 'vitest';

import { claudeBaseToolPolicyFor } from '../../contracts/agents';
import type { AgentPermissions, AgentPolicy } from '../../contracts/agents';
import {
  assignedEnabledSkillNames,
  assignedSkillNames,
  carryEngineSwitch,
  compiledPolicyFor,
  connectorNamesOf,
  dangerousPermissionModeRefusal,
  demandsConnectors,
  demandsSkills,
  engineCapabilityRefusal,
  firstUnassignedSkillName,
  mcpRuleServerNames,
  parsePolicyBody,
  policyFor,
  storedConnectorServers,
  unsupportedEngineRefusal,
  withStoredConnectorIds,
} from './policy';
import type { AgentRecord } from './contract';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  type RegisteredEngine,
} from '../engines/registry';
import type { AgentResourceStoreProvider } from './resource-store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';

const PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: true,
};

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: '22222222-2222-4222-8222-222222222222',
    name: 'Support',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: PERMISSIONS,
    policy: null,
    createdBy: null,
    ownerPrincipalId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('compiledPolicyFor', () => {
  it('carries exactly the tools claudeBaseToolPolicyFor derives from the permissions', () => {
    // The *same function* the engine's adapter compiles from (ENG-04b, #325), not a re-derivation:
    // a policy this route serves that disagreed with the floor a run compiles would be a lie about
    // what the agent may do.
    const compiled = compiledPolicyFor(PERMISSIONS, []);
    expect(compiled.tools).toEqual(claudeBaseToolPolicyFor(PERMISSIONS));
  });

  it('allowlists exactly the given skill names, and never widens to mode: all', () => {
    const compiled = compiledPolicyFor(PERMISSIONS, ['triage', 'refunds']);
    expect(compiled.skills).toEqual({ mode: 'allowlist', names: ['triage', 'refunds'] });
  });

  it('never sets a limit — null means the SDK default, not a widened cap', () => {
    expect(compiledPolicyFor(PERMISSIONS, []).limits).toEqual({
      maxTurns: null,
      maxBudgetUsd: null,
    });
  });
});

describe('policyFor', () => {
  it('answers the compiled policy for a NULL column', () => {
    const record = agent({ policy: null });
    expect(policyFor(record, ['triage'])).toEqual(compiledPolicyFor(PERMISSIONS, ['triage']));
  });

  it('answers the stored policy verbatim when the column is set, ignoring the skill list', () => {
    const stored: AgentPolicy = {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: ['Bash'],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'all' },
      limits: { maxTurns: 10, maxBudgetUsd: 3 },
    };
    expect(policyFor(agent({ policy: stored }), ['unrelated'])).toEqual(stored);
  });
});

function fakeAssignments(
  byWorkspaceAgent: Record<string, readonly string[]>,
): AgentResourceStoreProvider {
  return {
    forWorkspace: (workspaceId) => ({
      get: (agentId) =>
        Promise.resolve({
          files: [],
          skillIds: [...(byWorkspaceAgent[`${workspaceId}:${agentId}`] ?? [])],
          connectorIds: [],
        }),
      replace: () => Promise.reject(new Error('unused')),
    }),
  };
}

function fakeCatalog(
  skills: readonly { id: string; name: string; enabled: boolean }[],
): ResourceCatalogStoreProvider {
  return {
    forWorkspace: () =>
      Promise.resolve({
        listSkills: () =>
          Promise.resolve(
            skills.map((skill) => ({
              ...skill,
              skillMd: '# Skill',
              createdBy: null,
              ownerPrincipalId: 'owner',
            })),
          ),
      } as unknown as Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>>),
  };
}

describe('assignedSkillNames / assignedEnabledSkillNames', () => {
  const workspaceId = 'w';
  const agentId = 'a';

  it('resolves ids to names through the catalog', async () => {
    const assignments = fakeAssignments({ 'w:a': ['s1', 's2'] });
    const catalog = fakeCatalog([
      { id: 's1', name: 'triage', enabled: true },
      { id: 's2', name: 'refunds', enabled: false },
    ]);
    const row = await assignments.forWorkspace(workspaceId).get(agentId);
    expect([...(await assignedSkillNames(workspaceId, row, catalog))].sort()).toEqual([
      'refunds',
      'triage',
    ]);
  });

  it('assignedEnabledSkillNames excludes a disabled skill, unlike assignedSkillNames', async () => {
    const assignments = fakeAssignments({ 'w:a': ['s1', 's2'] });
    const catalog = fakeCatalog([
      { id: 's1', name: 'triage', enabled: true },
      { id: 's2', name: 'refunds', enabled: false },
    ]);
    expect(await assignedEnabledSkillNames(workspaceId, agentId, assignments, catalog)).toEqual([
      'triage',
    ]);
  });

  it('answers empty for an agent with no assignments', async () => {
    const assignments = fakeAssignments({});
    const catalog = fakeCatalog([]);
    const row = await assignments.forWorkspace(workspaceId).get(agentId);
    expect((await assignedSkillNames(workspaceId, row, catalog)).size).toBe(0);
    expect((await assignedSkillNames(workspaceId, null, catalog)).size).toBe(0);
    expect(await assignedEnabledSkillNames(workspaceId, agentId, assignments, catalog)).toEqual([]);
  });
});

describe('parsePolicyBody', () => {
  const valid = {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };

  it('accepts a well-formed policy', () => {
    const result = parsePolicyBody(valid);
    expect(result.ok).toBe(true);
  });

  it('rejects an engine no deployment registers as unsupported_engine, not invalid_policy', () => {
    const result = parsePolicyBody({ ...valid, engine: 'acp' });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.result.body).toMatchObject({ error: { code: 'unsupported_engine' } });
  });

  it('accepts an engine this deployment does register, even one the contracts do not list', () => {
    // The refusal above has to be a statement about the *registry*, not about `ENGINE_IDS`. With
    // `acp` registered, the engine is no longer `unsupported_engine` — it fails the contract's
    // own union instead, which is a different (and correct) complaint.
    const result = parsePolicyBody({ ...valid, engine: 'acp' }, ['claude-agent-sdk', 'acp']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.body).toMatchObject({ error: { code: 'invalid_policy' } });
  });

  it('rejects the pre-ADR-0065 `provider` discriminant as invalid_body', () => {
    const legacy = Object.fromEntries(Object.entries(valid).filter(([key]) => key !== 'engine'));
    const result = parsePolicyBody({ ...legacy, provider: 'claude-agent-sdk' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.body).toMatchObject({ error: { code: 'invalid_body' } });
  });

  it('rejects a body that names both discriminants, rather than preferring one', () => {
    const result = parsePolicyBody({ ...valid, provider: 'claude-agent-sdk' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.body).toMatchObject({ error: { code: 'invalid_policy' } });
  });

  it('rejects a malformed body as invalid_policy', () => {
    const result = parsePolicyBody({ engine: 'claude-agent-sdk' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.result.body).toMatchObject({ error: { code: 'invalid_policy' } });
  });

  it('refuses a parseable bypassPermissions policy with dangerous_permission_mode_refused', () => {
    const result = parsePolicyBody({
      ...valid,
      tools: {
        ...valid.tools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.result.body).toMatchObject({
        error: { code: 'dangerous_permission_mode_refused' },
      });
  });
});

describe('unsupportedEngineRefusal', () => {
  it('is null for a registered engine', () => {
    expect(unsupportedEngineRefusal('claude-agent-sdk', ['claude-agent-sdk'])).toBeNull();
  });

  it('answers 400 unsupported_engine naming the registered engines, with no details by default', () => {
    const refusal = unsupportedEngineRefusal('acp', ['claude-agent-sdk']);
    expect(refusal).toEqual({
      status: 400,
      body: {
        error: {
          code: 'unsupported_engine',
          message: 'This deployment registers the engines \'claude-agent-sdk\'; received "acp".',
        },
      },
    });
  });

  it('carries the details a caller passes, and refuses a value that is not a string', () => {
    expect(unsupportedEngineRefusal('acp', ['claude-agent-sdk'], ['acp'])?.body).toMatchObject({
      error: { code: 'unsupported_engine', details: ['acp'] },
    });
    expect(unsupportedEngineRefusal(7, ['claude-agent-sdk'])?.status).toBe(400);
  });
});

describe('dangerousPermissionModeRefusal', () => {
  const policy: AgentPolicy = {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };

  it('is null for every mode but bypassPermissions', () => {
    expect(dangerousPermissionModeRefusal(policy)).toBeNull();
  });

  it('answers 400 dangerous_permission_mode_refused for bypassPermissions', () => {
    const refusal = dangerousPermissionModeRefusal({
      ...policy,
      tools: {
        ...policy.tools,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    });
    expect(refusal?.status).toBe(400);
    expect(refusal?.body).toMatchObject({
      error: { code: 'dangerous_permission_mode_refused' },
    });
  });
});

describe('firstUnassignedSkillName', () => {
  const base: AgentPolicy = {
    engine: 'claude-agent-sdk',
    tools: {
      base: 'claude_code_preset',
      autoApprove: [],
      deny: [],
      permissionMode: 'default',
      allowDangerouslySkipPermissions: false,
    },
    skills: { mode: 'allowlist', names: ['triage', 'refunds'] },
    limits: { maxTurns: null, maxBudgetUsd: null },
  };

  it('is null when mode is all, regardless of assignments', () => {
    expect(firstUnassignedSkillName({ ...base, skills: { mode: 'all' } }, new Set())).toBeNull();
  });

  it('is null when every allowlisted name is assigned', () => {
    expect(firstUnassignedSkillName(base, new Set(['triage', 'refunds', 'extra']))).toBeNull();
  });

  it('names the first allowlisted skill that is not assigned', () => {
    expect(firstUnassignedSkillName(base, new Set(['triage']))).toBe('refunds');
  });

  describe('demandsSkills', () => {
    it('is true for mode all with at least one assigned skill', () => {
      expect(demandsSkills({ ...base, skills: { mode: 'all' } }, new Set(['triage']))).toBe(true);
    });

    it('is false for mode all with nothing assigned', () => {
      expect(demandsSkills({ ...base, skills: { mode: 'all' } }, new Set())).toBe(false);
    });

    it('is true when the allowlist names an assigned skill', () => {
      expect(demandsSkills(base, new Set(['refunds']))).toBe(true);
    });

    it('is false for an empty allowlist even when the agent has assignments', () => {
      // A saved allowlist naming nothing lets no assigned skill through, whatever is enabled
      // later, so there is no skill for an engine to be unable to honour.
      expect(
        demandsSkills({ ...base, skills: { mode: 'allowlist', names: [] } }, new Set(['triage'])),
      ).toBe(false);
    });

    it('reads a NULL policy as every assigned skill, like mode all', () => {
      // The one-call create leaves the column NULL, and a run compiles it to whichever assigned
      // skills are enabled at that run — so every assigned skill is demanded.
      expect(demandsSkills(null, new Set(['triage']))).toBe(true);
      expect(demandsSkills(null, new Set())).toBe(false);
    });
  });
});

describe('mcpRuleServerNames / withStoredConnectorIds (ADR-0113 SD13, #1109)', () => {
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const policy = (base: 'claude_code_preset' | string[]): AgentPolicy => {
    const compiled = compiledPolicyFor(PERMISSIONS, []);
    return {
      ...compiled,
      tools: {
        ...compiled.tools,
        base,
        autoApprove: ['mcp__finder__search', 'mcp__docs__*'],
        deny: ['mcp__finder__write(/tmp/**)', `mcp__connector-${A}__delete`, 'Bash'],
      },
    };
  };

  it('names each server written by name, once, and never a connector-<id> one', () => {
    expect(mcpRuleServerNames(policy(['Read', 'mcp__finder__search']))).toEqual(['finder', 'docs']);
  });

  it('stores a rule by the id its name has, keeping the tool and the specifier', () => {
    const stored = withStoredConnectorIds(
      policy(['Read', 'mcp__finder__search']),
      new Map([
        ['finder', A],
        ['docs', B],
      ]),
    );
    expect('tools' in stored && stored.tools).toMatchObject({
      base: ['Read', `mcp__connector-${A}__search`],
      autoApprove: [`mcp__connector-${A}__search`, `mcp__connector-${B}__*`],
      deny: [`mcp__connector-${A}__write(/tmp/**)`, `mcp__connector-${A}__delete`, 'Bash'],
    });
  });

  it('leaves a name no MCP connector has, and the preset base, as written', () => {
    const written = policy('claude_code_preset');
    expect(withStoredConnectorIds(written, new Map([['other', A]]))).toEqual(written);
  });
});

describe('connector names of stored rules (ADR-0113 SD13, #1121)', () => {
  const A = '00000000-0000-4000-8000-0000000000a1';
  const B = '00000000-0000-4000-8000-0000000000b2';
  const claude = (tools: {
    base: 'claude_code_preset' | string[];
    autoApprove: string[];
    deny: string[];
  }): AgentPolicy => {
    const compiled = compiledPolicyFor(PERMISSIONS, []);
    return { ...compiled, tools: { ...compiled.tools, ...tools } };
  };
  const stored = claude({
    base: ['Read', `mcp__connector-${A}__search`],
    autoApprove: [`mcp__connector-${A}__*`, 'mcp__finder__search'],
    deny: [`mcp__connector-${B}__delete`, 'Bash'],
  });
  const openai: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  };

  it('lists each connector-<id> server once over the three lists, and no slug-form server', () => {
    expect(storedConnectorServers(stored)).toEqual([`connector-${A}`, `connector-${B}`]);
    expect(storedConnectorServers(openai)).toEqual([]);
    expect(
      storedConnectorServers(
        claude({ base: 'claude_code_preset', autoApprove: [], deny: ['mcp__finder__x'] }),
      ),
    ).toEqual([]);
  });

  it('asks the store for the ids only, and keys the answer by connector-<id>', async () => {
    const asked: (readonly string[])[] = [];
    const names = await connectorNamesOf(
      {
        namesOf: (ids) => {
          asked.push(ids.connector);
          return Promise.resolve({ connector: new Map([[A, 'file-finder']]) });
        },
      },
      stored,
    );

    expect(asked).toEqual([[A, B]]);
    expect(names).toEqual({ [`connector-${A}`]: 'file-finder' });
  });

  it("labels with the connector's key, and drops a name whose key falls back to its id", async () => {
    const names = await connectorNamesOf(
      {
        namesOf: () =>
          Promise.resolve({
            connector: new Map([
              [A, 'file-finder'],
              [B, 'File Finder'],
            ]),
          }),
      },
      stored,
    );

    expect(names).toEqual({ [`connector-${A}`]: 'file-finder' });
  });

  it('does not ask the store when no rule is stored by connector id', async () => {
    const never = { namesOf: () => Promise.reject(new Error('unexpected read')) };
    await expect(connectorNamesOf(never, openai)).resolves.toEqual({});
  });

  it('labels the refused rules in the widen message and keeps details verbatim', () => {
    const rule = `mcp__connector-${B}__delete`;

    const labelled = carryEngineSwitch(stored, openai, { [`connector-${B}`]: 'file-finder' });
    const raw = carryEngineSwitch(stored, openai);

    for (const [carried, text] of [
      [labelled, `${rule} (file-finder)`],
      [raw, `${rule}.`],
    ] as const) {
      if (carried.ok) throw new Error('expected a refusal');
      expect(carried.result.body).toMatchObject({
        error: {
          code: 'engine_switch_would_widen',
          details: expect.arrayContaining([rule]) as unknown,
        },
      });
      expect(JSON.stringify(carried.result.body)).toContain(text);
    }
  });
});

describe('demandsConnectors', () => {
  it('is true for an assignment row with a connector', () => {
    expect(demandsConnectors({ connectorIds: ['c1'] })).toBe(true);
  });

  it('is false for a row with none, and for an agent with no row at all', () => {
    expect(demandsConnectors({ connectorIds: [] })).toBe(false);
    expect(demandsConnectors(null)).toBe(false);
  });
});

describe('engineCapabilityRefusal', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
  });

  const noMcp: RegisteredEngine = {
    id: 'claude-agent-sdk',
    displayName: 'Claude Agent SDK (test: no MCP)',
    version: 'test',
    capabilities: {
      mcp: false,
      skills: true,
      subagents: false,
      resume: true,
      fork: false,
      interrupt: true,
      streamingText: false,
      reasoning: true,
      maxTurns: 'native',
      maxBudget: 'native',
      wireProtocols: ['anthropic-messages'],
    },
  };

  it('never fires for the engine as this deployment really registers it', () => {
    // The acceptance criterion "nothing changes for claude-agent-sdk agents".
    expect(
      engineCapabilityRefusal('claude-agent-sdk', { connectors: true, skills: true }),
    ).toBeNull();
  });

  it('answers 422 engine_capability_unsupported naming the capability in details', () => {
    registerEngineForTests(noMcp);
    const refusal = engineCapabilityRefusal('claude-agent-sdk', {
      connectors: true,
      skills: false,
    });
    expect(refusal?.status).toBe(422);
    expect(refusal?.body).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['mcp'] },
    });
  });

  it('names skills when that is the capability the engine lacks', () => {
    registerEngineForTests({
      ...noMcp,
      capabilities: { ...noMcp.capabilities, mcp: true, skills: false },
    });
    const refusal = engineCapabilityRefusal('claude-agent-sdk', {
      connectors: true,
      skills: true,
    });
    expect(refusal?.body).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['skills'] },
    });
  });

  it('says nothing about an engine this deployment does not register', () => {
    // `unsupported_engine` is `parsePolicyBody`'s refusal and has already named the fix; reporting
    // a missing capability of an engine that is not installed would point at the wrong thing.
    expect(engineCapabilityRefusal('acp', { connectors: true, skills: true })).toBeNull();
  });
});
