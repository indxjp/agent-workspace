/**
 * Issue #535's write-path table: every write that can widen an agent (the seam check's list), driven
 * through its real route as the workspace **Owner**, answers `403 policy_cannot_widen` with the
 * `policyWidenings` details under a ceiling, writes one audit row unless it is a dry run, and is
 * unchanged without a ceiling. The runtimes are configured the way `register.ts` configures them:
 * one `ceilingFor` on the agents runtime, the version runtime and the run API.
 */
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as postAgents } from '../../app/api/agents/route';
import { PATCH as patchAgent } from '../../app/api/agents/[id]/route';
import { PUT as putPolicy } from '../../app/api/agents/[id]/policy/route';
import { PUT as putPointer } from '../../app/api/agents/[id]/pointers/route';
import { PUT as putResources } from '../../app/api/agents/[id]/resources/route';
import { POST as postVersion } from '../../app/api/agents/[id]/versions/route';
import type { AgentResourceAssignments } from '../../contracts/agents';
import { FIXTURE_POLICY, fromVersionRequest, versionRequest } from '../agent-versions/fixtures';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../agent-versions/memory-store';
import { clearApplicationContext } from '../application-context';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../application-context-fixtures';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { AgentStoreProvider } from '../agents/store';
import { setupCeilingRefusal } from '../composition/setup';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import { startRun } from '../runs/api';
import { InMemoryRunStore } from '../runs/memory-store';
import { recordingCeilingFor, type RecordingCeiling } from './fixtures';

const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OWNER = 'a0000000-0000-4000-8000-000000000001';
const CRM = 'c0000000-0000-4000-8000-0000000000c1';
const CONNECTION = 'd0000000-0000-4000-8000-0000000000d1';
const ALLOWED_MODEL = 'claude-sonnet-4-5';
const WIDE_MODEL = 'gpt-5.1';

const CEILING: ProjectPolicy = {
  permissions: { runCommands: false },
  limits: { maxTurns: 10 },
  models: [ALLOWED_MODEL],
  tools: ['tickets'],
};

const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

let agents: AgentStoreProvider;
let versions: InMemoryAgentVersionStoreProvider;
let agentId: string;
let recording: RecordingCeiling;
let launched: number;

function versionWithModel(model: string, dryRun?: true): ReturnType<typeof versionRequest> {
  const request = versionRequest(dryRun === undefined ? {} : { dryRun });
  const { definition } = request.body;
  return {
    ...request,
    body: { ...request.body, definition: { ...definition, agent: { ...definition.agent, model } } },
  };
}

function install(ceiling: boolean): void {
  const assignments = new Map<string, AgentResourceAssignments>();
  const ceilingFor = ceiling ? { ceilingFor: recording.ceilingFor } : {};
  const deploymentCeiling = ceiling
    ? ({ kind: 'enforced', ceilingFor: recording.ceilingFor } as const)
    : ({ kind: 'disabled' } as const);
  installTestDomains({
    agents: {
      agents,
      agentResources: {
        forWorkspace: (workspaceId) => ({
          get: async (id) =>
            (await agents.forWorkspace(workspaceId).get(id)) === null
              ? null
              : (assignments.get(id) ?? {
                  files: [],
                  skillIds: [],
                  connectorIds: [],
                  storageGrants: [],
                }),
          replace: async (id, next) => {
            if ((await agents.forWorkspace(workspaceId).get(id)) === null) {
              return { kind: 'not-found' as const };
            }
            const stored = { ...next, storageGrants: next.storageGrants ?? [] };
            assignments.set(id, stored);
            return { kind: 'updated' as const, assignments: stored };
          },
        }),
      },
      skillCatalog: {
        forWorkspace: () =>
          Promise.resolve({ listSkills: () => Promise.resolve([]) } as unknown as Awaited<
            ReturnType<ResourceCatalogStoreProvider['forWorkspace']>
          >),
      },
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      ceiling: deploymentCeiling,
    },
  });
  installTestDomains({
    agentVersions: {
      versions,
      ceiling: deploymentCeiling,
    },
  });
  installTestRunApi({
    authenticate: () =>
      Promise.resolve({
        principalId: OWNER,
        ownerPrincipalId: OWNER,
        userId: null,
        workspaceId: WORKSPACE,
        role: 'owner',
        scope: null,
      }),
    findAgent: async (_principal, id) =>
      (await agents.forWorkspace(WORKSPACE).get(id)) === null
        ? null
        : { id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
    openSession: (_principal, agent) =>
      Promise.resolve({
        id: 'e0000000-0000-4000-8000-0000000000e1',
        agentId: agent.id,
        engine: null,
      }),
    ownsRun: () => Promise.resolve(true),
    store: new InMemoryRunStore(),
    launch: () => {
      launched += 1;
    },
    ...ceilingFor,
  });
}

beforeEach(async () => {
  agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: ALLOWED_MODEL,
      runtimeProfileId: null,
      permissions: PERMISSIONS,
    },
    { principalId: OWNER, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentId = created.agent.id;
  versions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: { [WORKSPACE]: { connector: [{ id: CRM, name: 'crm' }] } },
  });
  recording = recordingCeilingFor(CEILING, { connectors: { [CRM]: 'crm' } });
  launched = 0;
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({ users: [] }),
      identify: () =>
        Promise.resolve(
          Principal.fromApiKey({
            principalId: OWNER,
            apiKeyId: 'b0000000-0000-4000-8000-000000000001',
            workspaceId: WORKSPACE,
            role: 'owner',
            label: 'owner key',
          }),
        ),
    },
  });
});

afterEach(() => {
  clearApplicationContext();
  resetTestRunApi();
});

function request(method: string, path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const idContext = () => ({ params: Promise.resolve({ id: agentId }) });

interface WritePath {
  readonly name: string;
  readonly details: readonly string[];
  /** Whether a refusal is audited (every path but the dry run). */
  readonly audited: boolean;
  /** Runs once before the ceiling is installed, e.g. to save a version the move then points at. */
  readonly before?: () => Promise<void>;
  readonly send: () => Promise<Response>;
  /** The status the same write answers without a ceiling. */
  readonly unceiled: number;
}

const WRITE_PATHS: readonly WritePath[] = [
  {
    name: 'version save',
    details: [`model:${WIDE_MODEL}`],
    audited: true,
    send: () =>
      postVersion(
        request('POST', `/api/agents/${agentId}/versions`, versionWithModel(WIDE_MODEL)),
        idContext(),
      ),
    unceiled: 201,
  },
  {
    name: 'version dry run',
    details: [`model:${WIDE_MODEL}`],
    audited: false,
    send: () =>
      postVersion(
        request('POST', `/api/agents/${agentId}/versions`, versionWithModel(WIDE_MODEL, true)),
        idContext(),
      ),
    unceiled: 200,
  },
  {
    name: 'pointer move to a version saved before the ceiling',
    details: [`model:${WIDE_MODEL}`],
    audited: true,
    before: async () => {
      const saved = await postVersion(
        request('POST', `/api/agents/${agentId}/versions`, versionWithModel(WIDE_MODEL)),
        idContext(),
      );
      expect(saved.status).toBe(201);
    },
    send: () =>
      putPointer(
        request('PUT', `/api/agents/${agentId}/pointers`, { environment: 'local', version: 1 }),
        idContext(),
      ),
    unceiled: 200,
  },
  {
    name: 'create from version',
    details: [`model:${WIDE_MODEL}`],
    audited: true,
    send: () => {
      const draft = fromVersionRequest({ name: 'New agent' });
      const { definition } = draft.version.body;
      return postAgents(
        request('POST', '/api/agents', {
          ...draft,
          version: {
            ...draft.version,
            body: {
              ...draft.version.body,
              definition: { ...definition, agent: { ...definition.agent, model: WIDE_MODEL } },
            },
          },
        }),
      );
    },
    unceiled: 201,
  },
  {
    name: 'legacy POST /api/agents',
    details: [`model:${WIDE_MODEL}`],
    audited: true,
    send: () =>
      postAgents(
        request('POST', '/api/agents', {
          name: 'Legacy',
          instructions: '',
          modelConnectionId: null,
          model: WIDE_MODEL,
          permissions: PERMISSIONS,
        }),
      ),
    unceiled: 201,
  },
  {
    name: 'compound POST /api/agents',
    details: ['tool:crm'],
    audited: true,
    send: () =>
      postAgents(
        request('POST', '/api/agents', {
          agent: {
            name: 'Compound',
            instructions: '',
            modelConnectionId: null,
            model: ALLOWED_MODEL,
            permissions: PERMISSIONS,
          },
          assignments: { files: [], skillIds: [], connectorIds: [CRM], storageGrants: [] },
        }),
      ),
    unceiled: 201,
  },
  {
    name: 'PATCH permissions on a compiled-policy agent',
    details: ['permissions.runCommands'],
    audited: true,
    send: () =>
      patchAgent(
        request('PATCH', `/api/agents/${agentId}`, {
          permissions: { ...PERMISSIONS, runCommands: true },
        }),
        idContext(),
      ),
    unceiled: 200,
  },
  {
    name: 'PUT policy',
    details: ['limits.maxTurns'],
    audited: true,
    send: () =>
      putPolicy(
        request('PUT', `/api/agents/${agentId}/policy`, {
          ...FIXTURE_POLICY,
          limits: { maxTurns: 20, maxBudgetUsd: null },
        }),
        idContext(),
      ),
    unceiled: 200,
  },
  {
    name: 'PUT resources',
    details: ['tool:crm'],
    audited: true,
    send: () =>
      putResources(
        request('PUT', `/api/agents/${agentId}/resources`, {
          files: [],
          skillIds: [],
          connectorIds: [CRM],
          storageGrants: [],
        }),
        idContext(),
      ),
    unceiled: 200,
  },
  {
    name: 'run start modelOverride',
    details: [`model:${WIDE_MODEL}`],
    audited: true,
    send: () =>
      startRun(
        request('POST', `/api/agents/${agentId}/runs`, {
          prompt: 'hi',
          modelConnectionId: CONNECTION,
          model: WIDE_MODEL,
        }),
        agentId,
      ),
    unceiled: 202,
  },
];

describe('the deployment policy ceiling at every write path (issue #535)', () => {
  it.each(WRITE_PATHS)('$name answers 403 policy_cannot_widen to the Owner', async (path) => {
    install(false);
    await path.before?.();
    install(true);
    const before = await agents.forWorkspace(WORKSPACE).get(agentId);
    const response = await path.send();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: 'policy_cannot_widen',
        message: "The agent would be wider than this deployment's policy ceiling allows.",
        details: path.details,
      },
    });
    expect(recording.audit).toHaveLength(path.audited ? 1 : 0);
    if (path.audited) {
      expect(recording.audit[0]).toMatchObject({
        action: 'agent-changed',
        actorPrincipalId: expect.any(String) as unknown,
        subjectLabel: expect.stringContaining(
          `: refused policy_cannot_widen ${path.details.join(', ')}`,
        ) as unknown,
      });
    }
    // Nothing was written: the agent row is as it was, no agent was added, no run launched.
    expect(await agents.forWorkspace(WORKSPACE).get(agentId)).toEqual(before);
    expect(await agents.forWorkspace(WORKSPACE).list()).toHaveLength(1);
    expect(launched).toBe(0);
  });

  it.each(WRITE_PATHS)('$name is unchanged without a ceiling', async (path) => {
    install(false);
    await path.before?.();
    const response = await path.send();
    expect(response.status).toBe(path.unceiled);
    expect(recording.audit).toHaveLength(0);
  });

  it('answers the same status and body to a dry run and a save (C8)', async () => {
    install(true);
    const dry = await postVersion(
      request('POST', `/api/agents/${agentId}/versions`, versionWithModel(WIDE_MODEL, true)),
      idContext(),
    );
    const save = await postVersion(
      request('POST', `/api/agents/${agentId}/versions`, versionWithModel(WIDE_MODEL)),
      idContext(),
    );
    expect(dry.status).toBe(save.status);
    expect(await dry.json()).toEqual(await save.json());
    expect(recording.audit).toHaveLength(1);
  });

  it('refuses first-run setup over the ceiling, before any write', () => {
    expect(setupCeilingRefusal(WIDE_MODEL, CEILING, null)).toEqual({
      failure: {
        ok: false,
        status: 403,
        code: 'policy_cannot_widen',
        message: `The first agent would be wider than this deployment's policy ceiling allows: model:${WIDE_MODEL}`,
      },
      widenings: [`model:${WIDE_MODEL}`],
    });
    expect(setupCeilingRefusal(ALLOWED_MODEL, CEILING, null)).toBeNull();
    expect(setupCeilingRefusal(WIDE_MODEL, null, null)).toBeNull();
  });

  it('judges the agent setup updates as stored: its policy and its connectors', () => {
    // Setup keeps an existing agent's policy and assignments, so a re-run over an agent whose
    // stored limits and connectors exceed the ceiling is refused like a PATCH of it would be.
    const stored = {
      id: agentId,
      policy: { ...FIXTURE_POLICY, limits: { maxTurns: 50, maxBudgetUsd: null } },
      tools: ['crm', 'tickets'],
    };
    expect(setupCeilingRefusal(ALLOWED_MODEL, CEILING, stored)?.widenings).toEqual([
      'limits.maxTurns',
      'tool:crm',
    ]);
    expect(
      setupCeilingRefusal(ALLOWED_MODEL, CEILING, { ...stored, policy: FIXTURE_POLICY, tools: [] }),
    ).toBeNull();
  });

  it('labels a run start refusal by the step, not the agent id the row already holds', async () => {
    install(true);
    const response = await startRun(
      request('POST', `/api/agents/${agentId}/runs`, {
        prompt: 'hi',
        modelConnectionId: CONNECTION,
        model: WIDE_MODEL,
      }),
      agentId,
    );
    expect(response.status).toBe(403);
    expect(recording.audit).toMatchObject([
      {
        subjectId: agentId,
        subjectLabel: `run start: refused policy_cannot_widen model:${WIDE_MODEL}`,
      },
    ]);
  });
});
