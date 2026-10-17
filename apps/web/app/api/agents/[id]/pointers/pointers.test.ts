import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import {
  AgentVersionResourceSchema,
  SetAgentPointerResponseSchema,
} from '@indx-workspace/contracts/agent-versions';

import { PUT } from './route';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import {
  clearAgentsRuntime,
  configureAgentsRuntime,
  type WorkspaceResolution,
} from '../../../../../server/agents/runtime';
import { MAX_POINTER_BODY_BYTES } from '../../../../../server/agent-versions/contract';
import { FIXTURE_PERMISSIONS, versionRequest } from '../../../../../server/agent-versions/fixtures';
import { createAgentVersion } from '../../../../../server/agent-versions/handlers';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from '../../../../../server/agent-versions/memory-store';
import {
  clearAgentVersionsRuntime,
  configureAgentVersionsRuntime,
} from '../../../../../server/agent-versions/runtime';
import { clearAuditRuntime, configureAuditRuntime } from '../../../../../server/audit/runtime';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../../../../../server/rbac/runtime';

/**
 * `PUT /api/agents/:id/pointers` (S1-06, issue #444) on the memory stores, driven with real
 * `Request` objects. RBAC is real: `decide()` answers `403 forbidden` for a Viewer and for a Builder
 * on another principal's agent before the handler runs. The full role matrix is
 * `apps/web/server/rbac/authorisation-matrix.test.ts`'s, derived from the route declaration.
 *
 * The move's `agent-changed` audit row is written by the version store inside the pointer
 * transaction (#478), so these tests read it from the memory store's `audits()`. An audit runtime
 * is installed with a spy writer only to prove the route no longer writes through it.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';

const ACTORS = {
  builderA: { principalId: 'a0000000-0000-4000-8000-000000000002', role: 'builder' },
  builderB: { principalId: 'a0000000-0000-4000-8000-000000000003', role: 'builder' },
  viewer: { principalId: 'a0000000-0000-4000-8000-000000000004', role: 'viewer' },
} as const;
type Actor = keyof typeof ACTORS;

let versions: InMemoryAgentVersionStoreProvider;
let agentOfBuilderA: string;
let auditWrites: unknown[];

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

function installAudit(): void {
  configureAuditRuntime({
    scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'pointers' }]),
    repositories: {
      forScope: () => ({
        write: (event) => {
          auditWrites.push(event);
          return Promise.resolve();
        },
        count: () => Promise.resolve(auditWrites.length),
        list: () => Promise.reject(new Error('not read by these tests')),
      }),
    },
  });
}

beforeEach(async () => {
  auditWrites = [];
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Before any version.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: ACTORS.builderA.principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentOfBuilderA = created.agent.id;
  versions = createInMemoryAgentVersionStoreProvider({ agents });
  const store = await versions.forWorkspace(WORKSPACE);
  if (store === null) throw new Error('the memory store answers every workspace');
  const saved = await createAgentVersion(
    versionRequest({ instructions: 'Version one.' }),
    created.agent,
    ACTORS.builderA.principalId,
    { store },
  );
  AgentVersionResourceSchema.parse(saved.body);

  configureAgentsRuntime({
    agents,
    resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? { kind: 'unauthenticated', reason: 'no test workspace header' }
          : { kind: 'workspace', workspaceId },
      );
    },
  });
  configureAgentVersionsRuntime({ versions });
  installAudit();
  configureRbacRuntime({
    directory: createMemoryDirectory({ users: [] }),
    identify: (request) => {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      const actor = request.headers.get(ACTOR_HEADER);
      if (workspaceId === null || actor === null || !isActor(actor)) return Promise.resolve(null);
      return Promise.resolve(
        Principal.fromApiKey({
          ...ACTORS[actor],
          apiKeyId: ACTORS[actor].principalId.replace(/^a/u, 'b'),
          workspaceId,
          label: `${actor} pointers key`,
        }),
      );
    },
  });
});

afterEach(() => {
  clearAgentsRuntime();
  clearAgentVersionsRuntime();
  clearAuditRuntime();
  clearRbacRuntime();
});

function put(options: { actor: Actor; id?: string; body: unknown }): Promise<Response> {
  const id = options.id ?? agentOfBuilderA;
  const request = new Request(`https://example.invalid/api/agents/${id}/pointers`, {
    method: 'PUT',
    headers: new Headers({
      [WORKSPACE_HEADER]: WORKSPACE,
      [ACTOR_HEADER]: options.actor,
      'content-type': 'application/json',
    }),
    body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body),
  });
  return PUT(request, { params: Promise.resolve({ id }) });
}

async function errorOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
}

describe('PUT /api/agents/:id/pointers', () => {
  it('points local at the version and answers the agent as it now runs', async () => {
    const response = await put({ actor: 'builderA', body: { environment: 'local', version: 1 } });
    expect(response.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(await response.json());
    expect(body.agent).toMatchObject({ id: agentOfBuilderA, instructions: 'Version one.' });
    expect(body.pointer).toMatchObject({ environment: 'local', number: 1 });
    expect(versions.audits()).toEqual([
      {
        workspaceId: WORKSPACE,
        action: 'agent-changed',
        subjectId: agentOfBuilderA,
        subjectLabel: 'Support triage: local -> version 1',
        actorPrincipalId: ACTORS.builderA.principalId,
        actorUserId: null,
        actorLabel: 'builderA pointers key',
      },
    ]);
    // Exactly one row: the route writes nothing through the separate audit runtime.
    expect(auditWrites).toEqual([]);
  });

  it('points production through the same route, leaving the agent row as it was (#612)', async () => {
    const response = await put({
      actor: 'builderA',
      body: { environment: 'production', version: 1 },
    });
    expect(response.status).toBe(200);
    const body = SetAgentPointerResponseSchema.parse(await response.json());
    expect(body.agent.instructions).toBe('Before any version.');
    expect(body.pointer).toMatchObject({ environment: 'production', number: 1 });
    expect(versions.audits().map((row) => row.subjectLabel)).toEqual([
      'Support triage: production -> version 1',
    ]);
  });

  it.each(['local', 'production'])(
    'refuses a Viewer moving %s with 403 forbidden before the handler',
    async (environment) => {
      const response = await put({ actor: 'viewer', body: { environment, version: 1 } });
      expect(response.status).toBe(403);
      expect(await errorOf(response)).toMatchObject({ code: 'forbidden' });
      expect(versions.pointerCount()).toBe(0);
      expect(versions.audits()).toEqual([]);
    },
  );

  it("refuses a Builder on another principal's agent with 403 forbidden", async () => {
    const response = await put({ actor: 'builderB', body: { environment: 'local', version: 1 } });
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: 'forbidden' });
    expect(versions.pointerCount()).toBe(0);
    expect(versions.audits()).toEqual([]);
  });

  it('answers 400 invalid_agent_id for an id that is not a UUID', async () => {
    const response = await put({
      actor: 'builderA',
      id: 'not-a-uuid',
      body: { environment: 'local', version: 1 },
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_agent_id' });
  });

  it('answers 400 invalid_agent_version for an environment that does not exist', async () => {
    const response = await put({ actor: 'builderA', body: { environment: 'preview', version: 1 } });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error).toMatchObject({ code: 'invalid_agent_version' });
    expect(JSON.stringify(error)).toContain('environment: ');
  });

  it('answers 404 agent_version_not_found for a number the agent does not have', async () => {
    const response = await put({ actor: 'builderA', body: { environment: 'local', version: 2 } });
    expect(response.status).toBe(404);
    expect(await errorOf(response)).toMatchObject({
      code: 'agent_version_not_found',
      details: ['version:2'],
    });
    expect(versions.audits()).toEqual([]);
  });

  it('answers 413 for a body beyond the pointer bound', async () => {
    const response = await put({
      actor: 'builderA',
      body: JSON.stringify({
        environment: 'local',
        version: 1,
        pad: 'x'.repeat(MAX_POINTER_BODY_BYTES),
      }),
    });
    expect(response.status).toBe(413);
  });

  it('answers 503 agent_policy_not_configured without the versions runtime', async () => {
    clearAgentVersionsRuntime();
    const response = await put({ actor: 'builderA', body: { environment: 'local', version: 1 } });
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'agent_policy_not_configured' });
  });

  it('moves and records exactly one row through the version store without the audit runtime (#478)', async () => {
    clearAuditRuntime();
    const response = await put({ actor: 'builderA', body: { environment: 'local', version: 1 } });
    expect(response.status).toBe(200);
    expect(versions.pointerCount()).toBe(1);
    expect(versions.audits()).toEqual([
      expect.objectContaining({ action: 'agent-changed', subjectId: agentOfBuilderA }),
    ]);
    expect(auditWrites).toEqual([]);
  });
});
