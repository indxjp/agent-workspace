import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionBodySchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
} from '@indx-workspace/contracts/agent-versions';

import type { AgentRecord } from '../agents/contract';
import type { ApiResult } from '../agents/handlers';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
} from '../engines/registry';
import {
  dryRunOf,
  FIXTURE_PERMISSIONS,
  FIXTURE_POLICY,
  fromVersionRequest,
  versionRequest,
} from './fixtures';
import { createInMemoryAgentVersionStoreProvider, type SeededReferences } from './memory-store';
import {
  parseVersionRequest,
  validateAgentVersion,
  type AgentVersionContext,
  type AgentVersionSubject,
} from './pipeline';
import type { WorkspaceAgentVersionStore } from './store';
import { recordingCeilingFor } from '../policy-ceiling/fixtures';
import type { ToolBundleLookup } from '../tool-bundles/handlers';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';

type Dependencies = Pick<
  AgentVersionContext,
  'store' | 'registered' | 'ceiling' | 'toolBundles' | 'toolHost' | 'toolDomainsRefusal'
>;

/** Step 1 and the pipeline over a create-version request, as `handlers.ts` runs them. */
async function validateVersionRequest(
  raw: unknown,
  subject: AgentVersionSubject,
  dependencies: Dependencies,
) {
  const parsed = parseVersionRequest(
    CreateAgentVersionRequestSchema,
    raw,
    'body',
    dependencies.registered,
  );
  if (!parsed.ok) return parsed;
  const { request } = parsed;
  const validated = await validateAgentVersion(request.body, {
    ...dependencies,
    subject,
    bodyPath: 'body',
    dryRun: request.dryRun === true,
  });
  return validated.ok ? { ...validated, request } : validated;
}

/** The same over `POST /api/agents {version}`, as `create-from-version.ts` runs them. */
async function validateAgentFromVersion(raw: unknown, dependencies: Dependencies) {
  const parsed = parseVersionRequest(
    CreateAgentFromVersionRequestSchema,
    raw,
    'version.body',
    dependencies.registered,
  );
  if (!parsed.ok) return parsed;
  const { request } = parsed;
  const validated = await validateAgentVersion(request.version.body, {
    ...dependencies,
    subject: { kind: 'new' },
    bodyPath: 'version.body',
    dryRun: request.dryRun === true,
  });
  return validated.ok ? { ...validated, request } : validated;
}

/** A stored body re-checked against the agent as it is now, as `pointers.ts` runs it. */
function validateStoredVersion(body: unknown, current: AgentRecord, dependencies: Dependencies) {
  return validateAgentVersion(AgentVersionBodySchema.parse(body), {
    ...dependencies,
    subject: { kind: 'existing', agent: current },
    bodyPath: 'body',
    dryRun: false,
  });
}

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: WORKSPACE,
    name: 'Support triage',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: FIXTURE_PERMISSIONS,
    policy: null,
    createdBy: null,
    ownerPrincipalId: '33333333-3333-4333-8333-333333333333',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function storeWith(
  references: SeededReferences = {},
  defaultRuntimeProfileId: string | null = null,
): Promise<WorkspaceAgentVersionStore> {
  const provider = createInMemoryAgentVersionStoreProvider({
    agents: createInMemoryAgentStoreProvider(),
    references: { [WORKSPACE]: references },
    ...(defaultRuntimeProfileId === null
      ? {}
      : { defaultRuntimeProfiles: { [WORKSPACE]: defaultRuntimeProfileId } }),
  });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return store;
}

const OWNER = '36377a6a-7a0b-4610-8efc-d31547dcc38a';

/**
 * A store whose workspace holds these agents. Each is first materialised plain, then, for one that
 * names `subagents`, from a second version naming them (so a named agent must come out plain).
 */
async function storeWithAgents(
  held: readonly {
    readonly name: string;
    readonly subagents?: readonly string[];
    readonly described?: boolean;
  }[],
): Promise<WorkspaceAgentVersionStore> {
  const agents = createInMemoryAgentStoreProvider();
  const provider = createInMemoryAgentVersionStoreProvider({ agents });
  const store = await provider.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const materialise = async (
    agentId: string,
    name: string,
    subagents: readonly string[] | undefined,
    described: boolean,
  ): Promise<void> => {
    const body = {
      ...versionRequest({ name }).body,
      ...(described ? { description: `${name} does one job.` } : {}),
      ...(subagents === undefined ? {} : { subagents: subagents.map((n) => ({ name: n })) }),
    };
    const version = await store.create(agentId, {
      summary: 'seed',
      via: 'api',
      body,
      createdByPrincipalId: OWNER,
    });
    if (version.kind !== 'created') throw new Error('the memory store creates the version');
    const applied = await store.applyAndPoint(agentId, {
      environment: 'local',
      number: version.version.number,
      reason: 'set',
      audit: {
        subjectLabel: name,
        actorPrincipalId: OWNER,
        actorUserId: null,
        actorLabel: 'Owner',
      },
      agent: {
        name,
        instructions: '',
        model: null,
        permissions: FIXTURE_PERMISSIONS,
        policy: null,
        references: {
          modelConnectionId: null,
          runtimeProfileId: null,
          skillIds: [],
          connectorIds: [],
          files: [],
        },
      },
    });
    if (applied.kind !== 'applied') throw new Error(`the seed was not applied: ${applied.kind}`);
  };
  const ids = new Map<string, string>();
  for (const { name, described = true } of held) {
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name,
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: FIXTURE_PERMISSIONS,
      },
      { principalId: OWNER, userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    ids.set(name, created.agent.id);
    await materialise(created.agent.id, name, undefined, described);
  }
  for (const { name, subagents, described = true } of held) {
    const id = ids.get(name);
    if (subagents !== undefined && id !== undefined) {
      await materialise(id, name, subagents, described);
    }
  }
  return store;
}

async function validate(
  raw: unknown,
  options: {
    readonly store?: WorkspaceAgentVersionStore;
    readonly references?: SeededReferences;
    readonly defaultRuntimeProfileId?: string;
    readonly subject?: AgentRecord;
    readonly registered?: readonly string[];
  } = {},
) {
  return validateVersionRequest(
    raw,
    { kind: 'existing', agent: options.subject ?? agent() },
    {
      store:
        options.store ??
        (await storeWith(options.references, options.defaultRuntimeProfileId ?? null)),
      ...(options.registered === undefined ? {} : { registered: options.registered }),
    },
  );
}

function refusalOf(
  result: { readonly ok: true } | { readonly ok: false; readonly result: ApiResult },
): { status: number; body: unknown } {
  if (result.ok) throw new Error('expected a refusal');
  return result.result;
}

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentVersion', () => {
  it('stores a rule written against an MCP connector name by the connector id (ADR-0113 SD13, #1109)', async () => {
    const finder = '00000000-0000-4000-8000-0000000000a1';
    const result = await validate(
      versionRequest({
        policy: {
          ...FIXTURE_POLICY,
          tools: {
            ...FIXTURE_POLICY.tools,
            autoApprove: ['mcp__file-finder__search', 'mcp__pets-tool__list'],
            deny: ['mcp__file-finder__delete', 'mcp__unknown__delete', 'Bash'],
          },
        },
      }),
      {
        references: {
          connector: [
            { id: finder, name: 'file-finder' },
            { id: '00000000-0000-4000-8000-0000000000a2', name: 'pets-tool', tool: true },
          ],
        },
      },
    );
    expect(result.ok && result.policyToStore).toMatchObject({
      tools: {
        // A tool connector keeps its name, and a name no connector has is left as written.
        autoApprove: [`mcp__connector-${finder}__search`, 'mcp__pets-tool__list'],
        deny: [`mcp__connector-${finder}__delete`, 'mcp__unknown__delete', 'Bash'],
      },
    });
  });

  it('accepts a valid body and hands back the normalised request and the stored policy', async () => {
    const result = await validate(versionRequest());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.body.definition.agent.name).toBe('Support triage');
    expect(result.policyToStore).toEqual(FIXTURE_POLICY);
    expect(result.references).toEqual({
      modelConnectionId: null,
      runtimeProfileId: null,
      skillIds: [],
      connectorIds: [],
      files: [],
    });
  });

  describe('1. parse', () => {
    it('answers 400 invalid_agent_version with one dotted path per issue', async () => {
      const refusal = refusalOf(await validate({ ...versionRequest(), summary: '' }));
      expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.invalid_agent_version);
      expect(refusal.body).toMatchObject({
        error: { code: 'invalid_agent_version', details: [expect.stringMatching(/^summary: /u)] },
      });
    });

    it('names the body itself (root) when it is not an object', async () => {
      const refusal = refusalOf(await validate('not a body'));
      expect(refusal.body).toMatchObject({
        error: { code: 'invalid_agent_version', details: [expect.stringMatching(/^\(root\): /u)] },
      });
    });

    it('refuses dryRun: false rather than reading it as a save', async () => {
      const refusal = refusalOf(await validate({ ...versionRequest(), dryRun: false }));
      expect(refusal.body).toMatchObject({ error: { code: 'invalid_agent_version' } });
    });

    it('refuses an agent name that is blank once trimmed (agents_name_not_blank), tabs included', async () => {
      for (const name of [' ', '   ', '\t', ' \u00a0 ']) {
        const refusal = refusalOf(await validate(versionRequest({ name })));
        expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.invalid_agent_version);
        expect(refusal.body).toMatchObject({
          error: {
            code: 'invalid_agent_version',
            details: ['body.definition.agent.name: must not be blank'],
          },
        });
      }
    });

    it('answers unsupported_engine for an unparseable body naming an unregistered engine', async () => {
      const body = versionRequest();
      const raw = {
        ...body,
        body: { ...body.body, definition: { ...body.body.definition, policy: { engine: 'acp' } } },
      };
      const refusal = refusalOf(await validate(raw));
      expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.unsupported_engine);
      expect(refusal.body).toMatchObject({
        error: { code: 'unsupported_engine', details: ['acp'] },
      });
    });
  });

  describe('2. engine', () => {
    it('answers 400 unsupported_engine for a published engine this deployment does not register', async () => {
      const refusal = refusalOf(
        await validate(versionRequest(), { registered: ['openai-agents', 'pi', 'mastra'] }),
      );
      expect(refusal.status).toBe(400);
      expect(refusal.body).toMatchObject({
        error: { code: 'unsupported_engine', details: ['claude-agent-sdk'] },
      });
    });
  });

  describe('3. permission mode', () => {
    it('answers 400 dangerous_permission_mode_refused for bypassPermissions', async () => {
      const refusal = refusalOf(
        await validate(
          versionRequest({
            policy: {
              ...FIXTURE_POLICY,
              tools: {
                ...FIXTURE_POLICY.tools,
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
              },
            },
          }),
        ),
      );
      expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.dangerous_permission_mode_refused);
      expect(refusal.body).toMatchObject({ error: { code: 'dangerous_permission_mode_refused' } });
    });
  });

  describe('4. resolution', () => {
    it('answers 422 agent_definition_references_missing naming each kind:name', async () => {
      const refusal = refusalOf(
        await validate(
          versionRequest({
            resources: { skills: ['triage'], files: [{ path: 'docs/a.md', access: 'read' }] },
            runtimeProfileName: 'gpu',
          }),
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        error: {
          code: 'agent_definition_references_missing',
          details: ['skill:triage', 'file:docs/a.md', 'runtime-profile:gpu'],
        },
      });
    });

    it('reports missing before ambiguous', async () => {
      const refusal = refusalOf(
        await validate(versionRequest({ resources: { skills: ['triage'], connectors: ['crm'] } }), {
          references: {
            connector: [
              { id: 'c1', name: 'crm' },
              { id: 'c2', name: 'crm' },
            ],
          },
        }),
      );
      expect(refusal.body).toMatchObject({
        error: { code: 'agent_definition_references_missing', details: ['skill:triage'] },
      });
    });

    it('answers 409 agent_definition_reference_ambiguous when nothing is missing', async () => {
      const refusal = refusalOf(
        await validate(versionRequest({ resources: { connectors: ['crm'] } }), {
          references: {
            connector: [
              { id: 'c1', name: 'crm' },
              { id: 'c2', name: 'crm' },
            ],
          },
        }),
      );
      expect(refusal.status).toBe(409);
      expect(refusal.body).toMatchObject({
        error: { code: 'agent_definition_reference_ambiguous', details: ['connector:crm'] },
      });
    });

    it("never reports a null or 'default' model connection missing (C7)", async () => {
      expect((await validate(versionRequest({ modelConnectionName: 'default' }))).ok).toBe(true);
      expect((await validate(versionRequest({ modelConnectionName: null }))).ok).toBe(true);
      const named = refusalOf(await validate(versionRequest({ modelConnectionName: 'prod' })));
      expect(named.body).toMatchObject({ error: { details: ['model-connection:prod'] } });
    });
    describe("the workspace's default runtime profile (S1-22, #504)", () => {
      const PROFILES: SeededReferences = {
        'runtime-profile': [
          { id: 'rp-local', name: 'local' },
          { id: 'rp-gpu', name: 'gpu' },
        ],
      };

      it('resolves a null runtimeProfileName to the default profile id', async () => {
        const result = await validate(versionRequest({ runtimeProfileName: null }), {
          references: PROFILES,
          defaultRuntimeProfileId: 'rp-local',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.references.runtimeProfileId).toBe('rp-local');
      });

      it('resolves a null runtimeProfileName to null, never missing, when there is no default', async () => {
        const result = await validate(versionRequest({ runtimeProfileName: null }), {
          references: PROFILES,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.references.runtimeProfileId).toBeNull();
      });

      it('lets a named profile win over the default', async () => {
        const result = await validate(versionRequest({ runtimeProfileName: 'gpu' }), {
          references: PROFILES,
          defaultRuntimeProfileId: 'rp-local',
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.references.runtimeProfileId).toBe('rp-gpu');
      });

      it('still refuses a named profile that does not exist, even with a default', async () => {
        const refusal = refusalOf(
          await validate(versionRequest({ runtimeProfileName: 'tpu' }), {
            references: PROFILES,
            defaultRuntimeProfileId: 'rp-local',
          }),
        );
        expect(refusal.body).toMatchObject({
          error: {
            code: 'agent_definition_references_missing',
            details: ['runtime-profile:tpu'],
          },
        });
      });
    });
  });

  describe('4c. subagents', () => {
    const naming = (...names: string[]) => {
      const base = versionRequest();
      return { ...base, body: { ...base.body, subagents: names.map((name) => ({ name })) } };
    };
    const unusable = (details: string[]) => ({
      error: { code: 'agent_subagent_unusable', details },
    });

    it('refuses a subagent no agent of the workspace carries', async () => {
      const store = await storeWithAgents([{ name: 'Researcher' }]);
      const refusal = refusalOf(await validate(naming('ghost'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['subagent:ghost']));
    });

    it('refuses a subagent that declares subagents itself (nesting)', async () => {
      const store = await storeWithAgents([{ name: 'b', subagents: ['c'] }, { name: 'c' }]);
      const refusal = refusalOf(await validate(naming('b'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['subagent:b']));
    });

    it('refuses a back-reference: the subagent already names the agent being saved', async () => {
      const store = await storeWithAgents([
        { name: 'Support triage' },
        { name: 'b', subagents: ['Support triage'] },
      ]);
      const refusal = refusalOf(await validate(naming('b'), { store }));
      expect(refusal.body).toMatchObject(unusable(['subagent:b', 'parent:b']));
    });

    it("refuses an agent that is already someone's subagent gaining subagents", async () => {
      const store = await storeWithAgents([
        { name: 'ok' },
        { name: 'Support triage' },
        { name: 'parent-z', subagents: ['Support triage'] },
        { name: 'parent-a', subagents: ['Support triage'] },
      ]);
      const refusal = refusalOf(await validate(naming('ok'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['parent:parent-a', 'parent:parent-z']));
    });

    it('lists the unusable subagents first and then the parents', async () => {
      const store = await storeWithAgents([
        { name: 'Support triage' },
        { name: 'parent', subagents: ['Support triage'] },
      ]);
      const refusal = refusalOf(await validate(naming('ghost'), { store }));
      expect(refusal.body).toMatchObject(unusable(['subagent:ghost', 'parent:parent']));
    });

    it('does not count the agent being saved as its own parent', async () => {
      const store = await storeWithAgents([{ name: 'ok' }]);
      const subject = agent();
      const parents = vi.spyOn(store, 'subagentParents');
      await validate(naming('ok'), { store, subject });
      expect(parents).toHaveBeenCalledWith('Support triage', subject.id);
    });

    it('lists every unusable name in body order and skips the usable ones', async () => {
      const store = await storeWithAgents([{ name: 'ok' }, { name: 'nested', subagents: ['ok'] }]);
      const refusal = refusalOf(await validate(naming('nested', 'ok', 'ghost'), { store }));
      expect(refusal.body).toMatchObject(unusable(['subagent:nested', 'subagent:ghost']));
    });

    it('answers a dry run exactly as a save', async () => {
      const store = await storeWithAgents([{ name: 'b', subagents: ['c'] }, { name: 'c' }]);
      const saved = refusalOf(await validate(naming('b', 'ghost'), { store }));
      const base = naming('b', 'ghost');
      const dry = refusalOf(await validate({ ...base, dryRun: true }, { store }));
      expect(dry).toEqual(saved);
    });

    it('refuses a subagent whose version has no description', async () => {
      const store = await storeWithAgents([{ name: 'mute', described: false }, { name: 'ok' }]);
      const refusal = refusalOf(await validate(naming('mute', 'ok'), { store }));
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject(unusable(['subagent:mute']));
    });

    it('saves a usable subagent on an engine that delegates', async () => {
      const store = await storeWithAgents([{ name: 'ok' }]);
      expect((await validate(naming('ok'), { store })).ok).toBe(true);
    });

    it('lets a usable subagent through to the capability check', async () => {
      const store = await storeWithAgents([{ name: 'ok' }]);
      const base = naming('ok');
      const pi = { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits } as const;
      const onPi = versionRequest({ policy: pi });
      const refusal = refusalOf(
        await validate(
          { ...base, body: { ...onPi.body, subagents: base.body.subagents } },
          { store },
        ),
      );
      expect(refusal.body).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['subagents'] },
      });
    });

    it('never asks for agents when the body names no subagent', async () => {
      const store = await storeWith();
      const agentsByName = vi.fn<WorkspaceAgentVersionStore['agentsByName']>();
      const subagentParents = vi.fn<WorkspaceAgentVersionStore['subagentParents']>();
      expect(
        (await validate(versionRequest(), { store: { ...store, agentsByName, subagentParents } }))
          .ok,
      ).toBe(true);
      expect(agentsByName).not.toHaveBeenCalled();
      expect(subagentParents).not.toHaveBeenCalled();
    });
  });

  describe('5. engine capability', () => {
    it('answers 422 engine_capability_unsupported ["mcp"] for a connector on pi', async () => {
      expect(registeredEngine('pi')?.capabilities.mcp).toBe(false);
      const refusal = refusalOf(
        await validate(
          versionRequest({
            policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
            resources: { connectors: ['crm'] },
          }),
          { references: { connector: [{ id: 'c1', name: 'crm' }] } },
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['mcp'] },
      });
    });

    // S2-02f (#531): a tool connector reaches the engine as a gateway MCP server, so it demands
    // `mcp` like any connector; the demand never depends on the connector's kind.
    it('answers 422 engine_capability_unsupported ["mcp"] at dry run for a tool connector on pi', async () => {
      const refusal = refusalOf(
        await validate(
          {
            ...versionRequest({
              policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
              resources: { connectors: ['orders'] },
            }),
            dryRun: true,
          },
          { references: { connector: [{ id: 'openapi-orders', name: 'orders' }] } },
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['mcp'] },
      });
    });

    // ADR-0133 D14: pi does not delegate, so a body naming a subagent is refused on save and on dry
    // run alike, and a body without one is unchanged.
    it.each([false, true])(
      'answers 422 engine_capability_unsupported ["subagents"] for a subagent on pi (dryRun %s)',
      async (dryRun) => {
        const pi = {
          engine: 'pi',
          skills: { mode: 'all' },
          limits: FIXTURE_POLICY.limits,
        } as const;
        const base = dryRun
          ? dryRunOf(versionRequest({ policy: pi }))
          : versionRequest({ policy: pi });
        const refusal = refusalOf(
          await validate(
            { ...base, body: { ...base.body, subagents: [{ name: 'Researcher' }] } },
            { store: await storeWithAgents([{ name: 'Researcher' }]) },
          ),
        );
        expect(refusal.status).toBe(422);
        expect(refusal.body).toMatchObject({
          error: { code: 'engine_capability_unsupported', details: ['subagents'] },
        });
      },
    );

    it('saves a body with no subagents without asking for agents', async () => {
      const base = versionRequest();
      const store = await storeWith();
      const agentsByName = vi.fn<WorkspaceAgentVersionStore['agentsByName']>();
      expect(
        (
          await validate(
            { ...base, body: { ...base.body, subagents: [] } },
            { store: { ...store, agentsByName } },
          )
        ).ok,
      ).toBe(true);
      expect(agentsByName).not.toHaveBeenCalled();
    });

    it('treats a compiled policy as demanding every assigned skill', async () => {
      registerEngineForTests({
        id: 'claude-agent-sdk',
        displayName: 'Claude Agent SDK (test: no skills)',
        version: 'test',
        capabilities: {
          mcp: true,
          skills: false,
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
      });
      const references: SeededReferences = { skill: [{ id: 's1', name: 'triage' }] };
      const allowlistNone = versionRequest({
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: [] } },
        resources: { skills: ['triage'] },
      });
      expect((await validate(allowlistNone, { references })).ok).toBe(true);
      const compiled = versionRequest({
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: [] } },
        policySource: 'compiled',
        resources: { skills: ['triage'] },
      });
      expect(refusalOf(await validate(compiled, { references })).body).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['skills'] },
      });
    });
  });

  describe('6. engine switch', () => {
    const storedClaude = agent({
      policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] } },
    });

    it('answers 422 engine_switch_would_widen naming each refused rule', async () => {
      const refusal = refusalOf(
        await validate(
          versionRequest({
            policy: {
              engine: 'openai-agents',
              skills: { mode: 'all' },
              limits: FIXTURE_POLICY.limits,
            },
          }),
          { subject: storedClaude },
        ),
      );
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        error: { code: 'engine_switch_would_widen', details: ['mcp__github__*'] },
      });
    });

    it('labels a refused rule stored by connector id with the connector name, details verbatim (#1121)', async () => {
      const finder = '00000000-0000-4000-8000-0000000000a1';
      const rule = `mcp__connector-${finder}__delete`;
      const refusal = refusalOf(
        await validate(
          versionRequest({
            policy: {
              engine: 'openai-agents',
              skills: { mode: 'all' },
              limits: FIXTURE_POLICY.limits,
            },
          }),
          {
            subject: agent({
              policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: [rule] } },
            }),
            references: { connector: [{ id: finder, name: 'file-finder' }] },
          },
        ),
      );
      expect(refusal.body).toMatchObject({
        error: {
          code: 'engine_switch_would_widen',
          details: [rule],
          message: expect.stringContaining(`${rule} (file-finder).`) as unknown,
        },
      });
    });

    it('carries the stored narrowing into the policy a save stores', async () => {
      const result = await validate(
        versionRequest({
          policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
        }),
        {
          subject: agent({
            policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['Bash'] } },
          }),
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.policyToStore).toMatchObject({
          engine: 'pi',
          withheldPermissions: ['runCommands'],
        });
      }
    });

    it('stores nothing for a compiled policy, and does not refuse its switch', async () => {
      const result = await validate(
        versionRequest({
          policy: {
            engine: 'openai-agents',
            skills: { mode: 'all' },
            limits: FIXTURE_POLICY.limits,
          },
          policySource: 'compiled',
        }),
        { subject: storedClaude },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.policyToStore).toBeNull();
    });

    it('carries nothing for a subject that does not exist yet', async () => {
      const result = await validateVersionRequest(
        versionRequest(),
        { kind: 'new' },
        { store: await storeWith() },
      );
      expect(result.ok && result.policyToStore).toEqual(FIXTURE_POLICY);
    });
  });

  describe('7. the deployment policy ceiling (issue #535)', () => {
    const CONNECTION = 'a1111111-1111-4111-8111-111111111111';
    const ALL_ON = {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    };

    function withAgent(
      request: ReturnType<typeof versionRequest>,
      edits: { readonly permissions?: typeof ALL_ON; readonly model?: string | null },
    ): ReturnType<typeof versionRequest> {
      const { definition } = request.body;
      return {
        ...request,
        body: {
          ...request.body,
          definition: { ...definition, agent: { ...definition.agent, ...edits } },
        },
      };
    }

    async function judge(
      raw: unknown,
      ceiling: ReturnType<typeof recordingCeilingFor>,
      options: { readonly subject?: AgentRecord; readonly references?: SeededReferences } = {},
    ) {
      return validateVersionRequest(
        raw,
        { kind: 'existing', agent: options.subject ?? agent() },
        {
          store: await storeWith(options.references),
          ceiling: ceiling.ceilingFor(new Request('http://localhost/'), WORKSPACE),
        },
      );
    }

    it('runs after the engine switch: a carried withheld runCommands is not refused', async () => {
      const ceiling = recordingCeilingFor({ permissions: { runCommands: false } });
      const switched = withAgent(
        versionRequest({
          policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
        }),
        { permissions: { ...FIXTURE_PERMISSIONS, runCommands: true } },
      );
      const subject = agent({
        policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['Bash'] } },
      });
      expect((await judge(switched, ceiling, { subject })).ok).toBe(true);
      // Without the switch's withholding, the same permission is refused.
      const unswitched = withAgent(versionRequest(), {
        permissions: { ...FIXTURE_PERMISSIONS, runCommands: true },
      });
      expect(refusalOf(await judge(unswitched, ceiling)).body).toMatchObject({
        error: { code: 'policy_cannot_widen', details: ['permissions.runCommands'] },
      });
    });

    it('refuses an explicit model outside policy.models', async () => {
      const ceiling = recordingCeilingFor({ models: ['claude-sonnet-4-5'] });
      const refusal = refusalOf(
        await judge(withAgent(versionRequest(), { model: 'gpt-5.1' }), ceiling),
      );
      expect(refusal.status).toBe(403);
      expect(refusal.body).toMatchObject({
        error: { code: 'policy_cannot_widen', details: ['model:gpt-5.1'] },
      });
    });

    it("judges model: null on the default connection as the provider's deployment default, with no discovery", async () => {
      const ceiling = recordingCeilingFor(
        { models: ['claude-sonnet-4-5'] },
        { defaults: { openai: 'gpt-5.1' }, providers: { [CONNECTION]: 'openai' } },
      );
      const refusal = refusalOf(
        await judge(versionRequest(), ceiling, {
          references: { 'model-connection': [{ id: CONNECTION, name: 'default' }] },
        }),
      );
      expect(refusal.body).toMatchObject({
        error: { code: 'policy_cannot_widen', details: ['model:gpt-5.1'] },
      });
      // The only read is the connection row's provider: no provider or discovery call exists.
      expect(ceiling.lookups).toEqual([`provider:${CONNECTION}`]);
    });

    it('saves a null maxBudgetUsd under a budget ceiling', async () => {
      const ceiling = recordingCeilingFor({ limits: { maxBudgetUsd: 1, maxTurns: 5 } });
      expect((await judge(versionRequest(), ceiling)).ok).toBe(true);
    });

    it('judges a compiled policy on the default engine with no limits', async () => {
      const ceiling = recordingCeilingFor({ engines: ['claude-agent-sdk'] });
      const compiled = versionRequest({
        policy: {
          engine: 'pi',
          skills: { mode: 'all' },
          limits: { maxTurns: 99, maxBudgetUsd: 9 },
        },
        policySource: 'compiled',
      });
      expect((await judge(compiled, ceiling)).ok).toBe(true);
      const stored = versionRequest({
        policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
      });
      expect(refusalOf(await judge(stored, ceiling)).body).toMatchObject({
        error: { details: ['engine:pi'] },
      });
    });

    it('names tool details sorted and once each', async () => {
      const ceiling = recordingCeilingFor({ tools: [] });
      const request = versionRequest({ resources: { connectors: ['zeta', 'alpha'] } });
      const refusal = refusalOf(
        await judge(request, ceiling, {
          references: {
            connector: [
              { id: 'c1', name: 'zeta' },
              { id: 'c2', name: 'alpha' },
            ],
          },
        }),
      );
      expect(refusal.body).toMatchObject({ error: { details: ['tool:alpha', 'tool:zeta'] } });
    });

    it('answers the identical result without a ceiling', async () => {
      const request = withAgent(versionRequest(), { permissions: ALL_ON, model: 'gpt-5.1' });
      const store = await storeWith();
      const subject = { kind: 'existing', agent: agent() } as const;
      const without = await validateVersionRequest(request, subject, { store });
      const withNull = await validateVersionRequest(request, subject, { store, ceiling: null });
      expect(withNull).toEqual(without);
      expect(without.ok).toBe(true);
    });
  });

  describe('8. the #133 write ceiling', () => {
    it('accepts a read-write file grant on an agent whose writeFiles is off', async () => {
      const result = await validate(
        versionRequest({ resources: { files: [{ path: 'docs/a.md', access: 'read-write' }] } }),
        { references: { file: [{ id: 'f1', name: 'docs/a.md' }] } },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.references.files).toEqual([{ fileId: 'f1', access: 'read-write' }]);
      }
    });
  });
});

describe('pinned tool bundles (issue #790)', () => {
  const STORED = 'a'.repeat(64);
  const UNKNOWN = 'b'.repeat(64);

  function pinning(...digests: string[]) {
    const request = versionRequest();
    return {
      ...request,
      body: {
        ...request.body,
        toolBundles: digests.map((digest, index) => ({ tool: `tool_${String(index)}`, digest })),
      },
    };
  }

  const lookup = (digests: readonly string[]): Promise<readonly string[]> =>
    Promise.resolve(digests.filter((digest) => digest !== STORED));

  async function validatePinning(raw: unknown, toolBundles: ToolBundleLookup | null) {
    return validateVersionRequest(
      raw,
      { kind: 'existing', agent: agent() },
      { store: await storeWith(), toolBundles },
    );
  }

  it('accepts a body whose every digest is stored', async () => {
    expect((await validatePinning(pinning(STORED), lookup)).ok).toBe(true);
  });

  it('refuses an unknown digest with 422 tool_bundle_unknown naming it', async () => {
    const refusal = refusalOf(await validatePinning(pinning(STORED, UNKNOWN), lookup));
    expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.tool_bundle_unknown);
    expect(refusal.body).toMatchObject({
      error: { code: 'tool_bundle_unknown', details: [`tool_bundle:${UNKNOWN}`] },
    });
  });

  it('refuses the same way for a dry run', async () => {
    const dryRun = { ...pinning(UNKNOWN), dryRun: true };
    const refusal = refusalOf(await validatePinning(dryRun, lookup));
    expect(refusal.body).toMatchObject({ error: { code: 'tool_bundle_unknown' } });
  });

  it('answers 503 when the body pins bundles and the deployment keeps none', async () => {
    const refusal = refusalOf(await validatePinning(pinning(STORED), null));
    expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.tool_bundles_not_configured);
    expect(refusal.body).toMatchObject({ error: { code: 'tool_bundles_not_configured' } });
  });

  it('refuses a pinned body by name on a deployment without a tool sandbox, before resolution', async () => {
    for (const dryRun of [{ dryRun: true }, {}]) {
      const result = await validateVersionRequest(
        { ...pinning(STORED), ...dryRun },
        { kind: 'existing', agent: agent() },
        { store: await storeWith(), toolBundles: lookup, toolHost: false },
      );
      const refusal = refusalOf(result);
      expect(refusal.status).toBe(422);
      expect(refusal.body).toMatchObject({
        error: {
          code: 'code_tool_needs_host',
          details: ['connector:aw-dev-tools', 'tool:tool_0'],
        },
      });
    }
    const unpinned = await validateVersionRequest(
      versionRequest(),
      { kind: 'existing', agent: agent() },
      { store: await storeWith(), toolHost: false },
    );
    expect(unpinned.ok).toBe(true);
  });

  it('accepts the same pinned body once the deployment has a tool host (E2B, #827), dry run or not', async () => {
    for (const dryRun of [{ dryRun: true }, {}]) {
      const result = await validateVersionRequest(
        { ...pinning(STORED), ...dryRun },
        { kind: 'existing', agent: agent() },
        { store: await storeWith(), toolBundles: lookup, toolHost: true },
      );
      expect(result.ok).toBe(true);
    }
  });

  describe('a tool sandbox that cannot enforce allowedDomains (#1018)', () => {
    const REASON = 'cannot enforce restricted yet';

    function withTools(tools: readonly { tool: string; allowedDomains?: string[] }[]) {
      const request = versionRequest();
      return {
        ...request,
        body: {
          ...request.body,
          toolBundles: tools.map((entry) => ({ ...entry, digest: STORED })),
        },
      };
    }

    async function validateWith(
      raw: unknown,
      context: { toolHost?: boolean; toolDomainsRefusal?: string | null },
    ) {
      const store = await storeWith();
      return validateVersionRequest(
        raw,
        { kind: 'existing', agent: agent() },
        { store, toolBundles: lookup, ...context },
      );
    }

    it('refuses a domain-declaring tool by name with 422 network_policy_unsupported, before resolution', async () => {
      const store = await storeWith();
      const resolveDefinition = vi.spyOn(store, 'resolveDefinition');
      const result = await validateVersionRequest(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { kind: 'existing', agent: agent() },
        { store, toolBundles: lookup, toolHost: true, toolDomainsRefusal: REASON },
      );
      const refusal = refusalOf(result);
      expect(refusal.status).toBe(AGENT_VERSION_PROBLEM_CODES.network_policy_unsupported);
      expect(refusal.body).toMatchObject({
        error: { code: 'network_policy_unsupported', details: ['tool:fetch_order'] },
      });
      expect(JSON.stringify(refusal.body)).toContain(REASON);
      expect(resolveDefinition).not.toHaveBeenCalled();
    });

    it('names only the tools that declare domains', async () => {
      const result = await validateWith(
        withTools([
          { tool: 'offline' },
          { tool: 'fetch_order', allowedDomains: ['api.example.com'] },
          { tool: 'empty', allowedDomains: [] },
          { tool: 'fetch_user', allowedDomains: ['*.example.com'] },
        ]),
        { toolHost: true, toolDomainsRefusal: REASON },
      );
      expect(refusalOf(result).body).toMatchObject({
        error: { details: ['tool:fetch_order', 'tool:fetch_user'] },
      });
    });

    it('accepts tools that declare no network, so they still push and run on E2B', async () => {
      const result = await validateWith(
        withTools([{ tool: 'offline' }, { tool: 'empty', allowedDomains: [] }]),
        {
          toolHost: true,
          toolDomainsRefusal: REASON,
        },
      );
      expect(result.ok).toBe(true);
    });

    it('accepts a domain-declaring tool where the sandbox enforces them (docker with the proxy)', async () => {
      const result = await validateWith(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { toolHost: true, toolDomainsRefusal: null },
      );
      expect(result.ok).toBe(true);
    });

    it('does not check when no capability is given (a caller that does not thread it)', async () => {
      const result = await validateWith(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { toolHost: true },
      );
      expect(result.ok).toBe(true);
    });

    it('still answers code_tool_needs_host first on a deployment without a tool sandbox', async () => {
      const result = await validateWith(
        withTools([{ tool: 'fetch_order', allowedDomains: ['api.example.com'] }]),
        { toolHost: false, toolDomainsRefusal: REASON },
      );
      expect(refusalOf(result).body).toMatchObject({ error: { code: 'code_tool_needs_host' } });
    });
  });

  it('never asks the store when the body pins nothing', async () => {
    const asked: string[] = [];
    const result = await validatePinning(versionRequest(), (digests) => {
      asked.push(...digests);
      return Promise.resolve([]);
    });
    expect(result.ok).toBe(true);
    expect(asked).toEqual([]);
  });

  it('checks a stored body at a pointer move too', async () => {
    const body = AgentVersionBodySchema.parse(pinning(UNKNOWN).body);
    const result = await validateAgentVersion(body, {
      store: await storeWith(),
      subject: { kind: 'existing', agent: agent() },
      bodyPath: 'body',
      dryRun: false,
      toolBundles: lookup,
    });
    expect(refusalOf(result).body).toMatchObject({ error: { code: 'tool_bundle_unknown' } });
  });
});

describe('validateAgentFromVersion (S1-06)', () => {
  it('accepts a valid request: nothing to carry for a new agent, the stored policy as authored', async () => {
    const result = await validateAgentFromVersion(fromVersionRequest(), {
      store: await storeWith(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.version.body.definition.agent.name).toBe('Support triage');
    expect(result.policyToStore).toEqual(FIXTURE_POLICY);
  });

  it('keeps the version. prefix on every parse issue', async () => {
    const request = fromVersionRequest();
    const result = await validateAgentFromVersion(
      { ...request, version: { ...request.version, summary: ' padded ' } },
      { store: await storeWith() },
    );
    const refusal = refusalOf(result);
    expect(refusal.status).toBe(400);
    expect(refusal.body).toMatchObject({ error: { code: 'invalid_agent_version' } });
    expect(JSON.stringify(refusal.body)).toContain('version.summary: ');
  });

  it('refuses the legacy keys beside version: the two shapes never overlap', async () => {
    const result = await validateAgentFromVersion(
      { ...fromVersionRequest(), name: 'Support triage' },
      { store: await storeWith() },
    );
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
  });

  it('answers unsupported_engine from the raw envelope when the parse fails on the engine', async () => {
    const request = fromVersionRequest();
    const raw = {
      ...request,
      version: {
        ...request.version,
        body: {
          ...request.version.body,
          definition: { ...request.version.body.definition, policy: { engine: 'acp' } },
        },
      },
    };
    const result = await validateAgentFromVersion(raw, { store: await storeWith() });
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: { error: { code: 'unsupported_engine', details: ['acp'] } },
    });
  });

  it('prefixes an unstorable string with version.', async () => {
    const result = await validateAgentFromVersion(
      fromVersionRequest({ instructions: 'before\u0000after' }),
      { store: await storeWith() },
    );
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'invalid_agent_version',
          details: [
            'version.body.definition.agent.instructions: must not contain U+0000 or an unpaired ' +
              'UTF-16 surrogate, which the version store cannot hold',
          ],
        },
      },
    });
  });

  it('runs steps 2-6: a missing skill is refused as a save would refuse it', async () => {
    const result = await validateAgentFromVersion(
      fromVersionRequest({ resources: { skills: ['triage'] } }),
      { store: await storeWith() },
    );
    expect(refusalOf(result)).toMatchObject({
      status: AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing,
      body: { error: { details: ['skill:triage'] } },
    });
  });
});

describe('validateStoredVersion (S1-06)', () => {
  it('re-resolves a stored body to the ids the workspace has today', async () => {
    const stored = versionRequest({ resources: { connectors: ['tickets'] } }).body;
    const result = await validateStoredVersion(stored, agent(), {
      store: await storeWith({ connector: [{ id: 'c-today', name: 'tickets' }] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.connectorIds).toEqual(['c-today']);
  });

  it('refuses a stored body whose reference was deleted since it was saved', async () => {
    const stored = versionRequest({ resources: { connectors: ['tickets'] } }).body;
    const result = await validateStoredVersion(stored, agent(), {
      store: await storeWith(),
    });
    expect(refusalOf(result)).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_definition_references_missing', details: ['connector:tickets'] },
      },
    });
  });

  it("checks the engine switch against the agent's current stored policy", async () => {
    const stored = versionRequest({
      policy: { engine: 'openai-agents', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
    }).body;
    const current = agent({
      policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] } },
    });
    const result = await validateStoredVersion(stored, current, {
      store: await storeWith(),
    });
    expect(refusalOf(result)).toMatchObject({
      status: 422,
      body: { error: { code: 'engine_switch_would_widen' } },
    });
  });

  it('refuses a stored version whose engine this deployment no longer registers', async () => {
    const result = await validateStoredVersion(versionRequest().body, agent(), {
      store: await storeWith(),
      registered: ['pi'],
    });
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: { error: { code: 'unsupported_engine' } },
    });
  });
});
