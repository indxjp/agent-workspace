/**
 * SDK conformance, agent / versions: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiProblemSchema } from '@indx-workspace/contracts';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import { RunDetailResponseSchema, RunResourceSchema } from '@indx-workspace/contracts/runs';
import {
  AGENT_TEAM_PROBLEM_CODES,
  AgentTeamResourceSchema,
  AgentTeamVersionListResponseSchema,
  AgentTeamVersionSchema,
} from '@indx-workspace/contracts/agent-teams';
import {
  DELETE as removeAgentTeamRoute,
  GET as getAgentTeamRoute,
} from '../app/api/agent-teams/[id]/route';
import {
  GET as listAgentTeamVersionsRoute,
  POST as createAgentTeamVersionRoute,
} from '../app/api/agent-teams/[id]/versions/route';
import {
  GET as listAgentTeamsRoute,
  POST as createAgentTeamRoute,
} from '../app/api/agent-teams/route';
import { createInMemoryAgentTeamsRuntime } from './agent-teams/memory-store';
import { callerHeaders, installRbacHarness } from './rbac/testing';
import { renderRun, renderRunDetail } from './runs/api';
import { InMemoryRunStore } from './runs/memory-store';
import {
  AGENT_VERSION_PROBLEM_CODES,
  AgentVersionCheckResponseSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
} from '@indx-workspace/contracts/agent-versions';
import { toAgentVersionListResponse, toAgentVersionResource } from './agent-versions/contract';
import { FIXTURE_POLICY, versionRequest } from './agent-versions/fixtures';
import { createAgentVersion } from './agent-versions/handlers';
import { createInMemoryAgentStoreProvider } from './agents/memory-store';
import { createInMemoryAgentVersionStoreProvider } from './agent-versions/memory-store';
import { clearApplicationContext } from './application-context';
import { installTestDomains } from './application-context-fixtures';
import { WORKSPACE, AGENT } from './sdk-conformance.test-support';

const record = {
  id: 'version-1',
  workspaceId: WORKSPACE,
  agentId: AGENT,
  number: 1,
  summary: 'First version',
  via: 'aw-push' as const,
  body: versionRequest().body,
  createdByPrincipalId: 'principal-1',
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
};

const TEAM_WORKSPACE = '13131313-1313-4313-8313-131313131313';

const owner = { email: 'owner@example.com' };

const LEAD = {
  agentId: '14141414-1414-4414-8414-141414141401',
  agentVersionId: '14141414-1414-4414-8414-1414141414a1',
};

const MEMBER = {
  agentId: '14141414-1414-4414-8414-141414141402',
  agentVersionId: '14141414-1414-4414-8414-1414141414a2',
};

const names = new Map([
  [LEAD.agentVersionId, { ...LEAD, name: 'lead' }],
  [MEMBER.agentVersionId, { ...MEMBER, name: 'researcher' }],
]);

/** The published client, its every request answered by the real agent-team route modules. */
function client() {
  return createClient({
    baseUrl: 'https://control-plane.test',
    auth: { kind: 'api-key', apiKey: 'ak_live_conformance' },
    fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      for (const [name, value] of Object.entries(callerHeaders(owner))) headers.set(name, value);
      const request = new Request(input, { ...init, headers });
      const { pathname } = new URL(request.url);
      const match = /^\/api\/agent-teams\/([^/]+)(\/versions)?$/u.exec(pathname);
      const context = { params: Promise.resolve({ id: match?.[1] ?? '' }) };
      if (pathname === '/api/agent-teams') {
        return request.method === 'POST'
          ? createAgentTeamRoute(request)
          : listAgentTeamsRoute(request);
      }
      if (match?.[2] !== undefined) {
        return request.method === 'POST'
          ? createAgentTeamVersionRoute(request, context)
          : listAgentTeamVersionsRoute(request, context);
      }
      if (match !== null) {
        return request.method === 'DELETE'
          ? removeAgentTeamRoute(request, context)
          : getAgentTeamRoute(request, context);
      }
      throw new Error(`no agent-team route for ${request.method} ${pathname}`);
    },
  });
}

/**
 * S1-05 (issue #443): the version routes' serialisers render the shapes the contracts publish, and
 * every code the version pipeline can answer is one `AGENT_VERSION_PROBLEM_CODES` names, under the
 * same status — the table an SDK consumer branches on.
 */
describe('agent versions (S1-05, issue #443)', () => {
  it('serialises a version, a listing and a dry run into the published shapes', () => {
    const resource = AgentVersionResourceSchema.safeParse(toAgentVersionResource(record));
    expect(resource.success, JSON.stringify(resource.error)).toBe(true);
    const listing = AgentVersionListResponseSchema.safeParse(
      toAgentVersionListResponse(
        {
          versions: [record],
          pointers: [
            {
              environment: 'local',
              number: 1,
              updatedAt: new Date('2026-10-01T11:00:00.000Z'),
            },
          ],
          materialisedVersionId: record.id,
        },
        [
          {
            environment: 'local',
            number: 1,
            reason: 'set',
            movedByPrincipalId: 'principal-1',
            movedAt: new Date('2026-10-01T11:00:00.000Z'),
          },
        ],
        [{ version: 1, score: 0.9, passed: 9, total: 10 }],
      ),
    );
    expect(listing.success, JSON.stringify(listing.error)).toBe(true);
    expect(listing.data?.materialised).toBe(1);
    expect(listing.data?.moves).toHaveLength(1);
    expect(listing.data?.evaluations).toHaveLength(1);
  });
});

describe('agent versions (S1-05, issue #443)', () => {
  it('answers a dry run with the published check response', async () => {
    const agents = createInMemoryAgentStoreProvider();
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name: 'Support triage',
        instructions: '',
        modelConnectionId: null,
        model: null,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      },
      { principalId: 'principal-1', userId: null },
    );
    if (created.kind !== 'created') throw new Error('the memory store creates the agent');
    const store = await createInMemoryAgentVersionStoreProvider({ agents }).forWorkspace(WORKSPACE);
    if (store === null) throw new Error('the memory store answers every workspace');
    const checked = await createAgentVersion(
      { ...versionRequest(), dryRun: true },
      created.agent,
      'principal-1',
      { store },
    );
    expect(AgentVersionCheckResponseSchema.safeParse(checked.body).success).toBe(true);
  });
});

/** An agent whose policy denies the GitHub MCP tools, the subject of every refused version below. */
function supportTriageAgent() {
  return {
    id: AGENT,
    workspaceId: WORKSPACE,
    name: 'Support triage',
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
    policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] } },
    createdBy: null,
    ownerPrincipalId: 'principal-1',
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    updatedAt: new Date('2026-10-01T10:00:00.000Z'),
  };
}

/** A version store whose references hold two connectors both named `crm`, so the name is ambiguous. */
async function storeWithAmbiguousConnector() {
  const store = await createInMemoryAgentVersionStoreProvider({
    agents: createInMemoryAgentStoreProvider(),
    references: {
      [WORKSPACE]: {
        connector: [
          { id: 'c1', name: 'crm' },
          { id: 'c2', name: 'crm' },
          { id: 'c3', name: 'tickets' },
        ],
      },
    },
  }).forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  return store;
}

/** One request body per pipeline refusal, with the engines registered for it when it needs any. */
function pipelineRefusalBodies(): readonly [unknown, readonly string[] | undefined][] {
  const limits = FIXTURE_POLICY.limits;
  const bypassPolicy: NonNullable<NonNullable<Parameters<typeof versionRequest>[0]>['policy']> = {
    ...FIXTURE_POLICY,
    tools: {
      ...FIXTURE_POLICY.tools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    },
  };
  return [
    [{ summary: '' }, undefined],
    [versionRequest(), ['pi']],
    [versionRequest({ policy: bypassPolicy }), undefined],
    [versionRequest({ resources: { skills: ['triage'] } }), undefined],
    [versionRequest({ resources: { connectors: ['crm'] } }), undefined],
    [
      versionRequest({
        policy: { engine: 'pi', skills: { mode: 'all' }, limits },
        resources: { connectors: ['tickets'] },
      }),
      undefined,
    ],
    [
      versionRequest({ policy: { engine: 'openai-agents', skills: { mode: 'all' }, limits } }),
      undefined,
    ],
  ];
}

describe('agent versions (S1-05, issue #443)', () => {
  it('answers every pipeline refusal with a code and status AGENT_VERSION_PROBLEM_CODES publishes', async () => {
    const agent = supportTriageAgent();
    const store = await storeWithAmbiguousConnector();
    const published: Readonly<Record<string, number>> = AGENT_VERSION_PROBLEM_CODES;
    const seen = new Set<string>();
    for (const [body, registered] of pipelineRefusalBodies()) {
      const result = await createAgentVersion(body, agent, 'principal-1', {
        store,
        ...(registered === undefined ? {} : { registered }),
      });
      if (result.status < 400) throw new Error(`expected a refusal for ${JSON.stringify(body)}`);
      const envelope = ApiProblemSchema.parse(result.body);
      const code = envelope.error.code;
      expect(published[code], code).toBe(result.status);
      seen.add(code);
    }
    expect([...seen].sort()).toEqual([
      'agent_definition_reference_ambiguous',
      'agent_definition_references_missing',
      'dangerous_permission_mode_refused',
      'engine_capability_unsupported',
      'engine_switch_would_widen',
      'invalid_agent_version',
      'unsupported_engine',
    ]);
  });
});

describe('agent teams and run trees (issue #1516, ADR-0104 acceptance)', () => {
  beforeEach(() => {
    installRbacHarness(
      [{ email: owner.email, name: 'Owner', workspaceId: TEAM_WORKSPACE, role: 'owner' }],
      { workspaceId: TEAM_WORKSPACE, newId: () => crypto.randomUUID() },
    );
    installTestDomains({
      agentTeams: createInMemoryAgentTeamsRuntime({
        lookup: (workspaceId, agentId, agentVersionId) => {
          const pinned = names.get(agentVersionId);
          return workspaceId === TEAM_WORKSPACE && pinned?.agentId === agentId ? pinned.name : null;
        },
      }),
    });
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('round-trips every aw.agentTeams method through the real routes in the published shapes', async () => {
    const aw = client();
    const created = await aw.agentTeams.create({
      name: 'Research',
      version: { lead: LEAD, members: [MEMBER] },
    });
    expect(AgentTeamResourceSchema.parse(created)).toEqual(created);
    expect(created.latestVersion?.members).toEqual([{ name: 'researcher', ...MEMBER }]);
    expect(await aw.agentTeams.get(created.id)).toEqual(created);
    expect((await aw.agentTeams.list()).items).toEqual([created]);

    const second = await aw.agentTeams.versions.create(created.id, {
      lead: LEAD,
      members: [{ ...MEMBER, name: 'web' }],
    });
    expect(AgentTeamVersionSchema.parse(second).version).toBe(2);
    const page = await aw.agentTeams.versions.list(created.id, { limit: 1 });
    expect(AgentTeamVersionListResponseSchema.parse(page).items).toEqual([second]);
    expect(page.nextCursor).not.toBeNull();

    await aw.agentTeams.remove(created.id);
    const missing = await aw.agentTeams.get(created.id).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(ApiProblemError);
    expect((missing as ApiProblemError).code).toBe('agent_team_not_found');
    expect(AGENT_TEAM_PROBLEM_CODES.agent_team_not_found).toBe((missing as ApiProblemError).status);
  });
});

describe('agent teams and run trees (issue #1516, ADR-0104 acceptance)', () => {
  beforeEach(() => {
    installRbacHarness(
      [{ email: owner.email, name: 'Owner', workspaceId: TEAM_WORKSPACE, role: 'owner' }],
      { workspaceId: TEAM_WORKSPACE, newId: () => crypto.randomUUID() },
    );
    installTestDomains({
      agentTeams: createInMemoryAgentTeamsRuntime({
        lookup: (workspaceId, agentId, agentVersionId) => {
          const pinned = names.get(agentVersionId);
          return workspaceId === TEAM_WORKSPACE && pinned?.agentId === agentId ? pinned.name : null;
        },
      }),
    });
  });

  afterEach(() => {
    clearApplicationContext();
  });

  it('renders a run with parentRunId on the list item, and its tree on the read', async () => {
    const store = new InMemoryRunStore();
    const create = (id: string) =>
      store.create({
        engine: 'claude-agent-sdk',
        id,
        workspaceId: TEAM_WORKSPACE,
        agentId: LEAD.agentId,
        sessionId: id,
      });
    const root = await create(crypto.randomUUID());
    const child = await create(crypto.randomUUID());
    store.seedChildForTests(child.id, root.id, '0.004000');

    expect(RunResourceSchema.parse(renderRun(root)).parentRunId).toBeNull();
    const detail = RunDetailResponseSchema.parse({ run: await renderRunDetail(store, root) }).run;
    expect(detail.children?.map((each) => [each.id, each.parentRunId])).toEqual([
      [child.id, root.id],
    ]);
    expect(detail.treeCost).toEqual({ amount: '0.004000', currency: 'USD' });
    const leaf = await store.get(child.id);
    if (leaf === null) throw new Error('the child run vanished');
    expect(
      RunDetailResponseSchema.parse({ run: await renderRunDetail(store, leaf) }).run,
    ).toMatchObject({
      parentRunId: root.id,
      children: [],
    });
  });
});
