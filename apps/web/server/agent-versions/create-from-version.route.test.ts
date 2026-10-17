import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AgentVersionListResponseSchema,
  CreateAgentFromVersionResponseSchema,
} from '@indx-workspace/contracts/agent-versions';
import { AgentResourceSchema } from '@indx-workspace/contracts/agents';

import { POST } from '../../app/api/agents/route';
import { GET as listVersions } from '../../app/api/agents/[id]/versions/route';
import { MAX_REQUEST_BODY_BYTES } from '../agents/http';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { AgentStoreProvider } from '../agents/store';
import {
  clearAgentsRuntime,
  configureAgentsRuntime,
  type WorkspaceResolution,
} from '../agents/runtime';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../rbac/runtime';
import { MAX_CREATE_AGENT_BODY_BYTES } from './contract';
import { FIXTURE_PERMISSIONS, fromVersionRequest } from './fixtures';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
} from './memory-store';
import { clearAgentVersionsRuntime, configureAgentVersionsRuntime } from './runtime';

/**
 * `POST /api/agents {version, dryRun?}` (S1-06, issue #444) through the real route on the memory
 * stores, and the regression that the legacy and compound forms are served exactly as before.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';

const ACTORS = {
  builder: { principalId: 'a0000000-0000-4000-8000-000000000002', role: 'builder' },
  viewer: { principalId: 'a0000000-0000-4000-8000-000000000004', role: 'viewer' },
} as const;
type Actor = keyof typeof ACTORS;

let agents: AgentStoreProvider;
let versions: InMemoryAgentVersionStoreProvider;

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

beforeEach(() => {
  agents = createInMemoryAgentStoreProvider();
  versions = createInMemoryAgentVersionStoreProvider({ agents });
  configureAgentsRuntime({
    agents,
    agentResources: {
      forWorkspace: () => ({
        get: () => Promise.resolve({ files: [], skillIds: [], connectorIds: [] }),
        replace: (_agentId, next) => Promise.resolve({ kind: 'updated', assignments: next }),
      }),
    },
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
          label: `${actor} create key`,
        }),
      );
    },
  });
});

afterEach(() => {
  clearAgentsRuntime();
  clearAgentVersionsRuntime();
  clearRbacRuntime();
});

function headers(actor: Actor): Headers {
  return new Headers({
    [WORKSPACE_HEADER]: WORKSPACE,
    [ACTOR_HEADER]: actor,
    'content-type': 'application/json',
  });
}

function post(body: unknown, options: { actor?: Actor; raw?: string } = {}): Promise<Response> {
  return POST(
    new Request('https://example.invalid/api/agents', {
      method: 'POST',
      headers: headers(options.actor ?? 'builder'),
      body: options.raw ?? JSON.stringify(body),
    }),
  );
}

async function errorOf(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
}

const LEGACY_BODY = {
  name: 'Legacy agent',
  instructions: 'Made the old way.',
  modelConnectionId: null,
  model: null,
  permissions: FIXTURE_PERMISSIONS,
};

describe('POST /api/agents {version}', () => {
  it('creates the agent with version 1 and points local at it', async () => {
    const response = await post(fromVersionRequest());
    expect(response.status).toBe(201);
    const body = CreateAgentFromVersionResponseSchema.parse(await response.json());
    expect(body.agent.ownerPrincipalId).toBe(ACTORS.builder.principalId);
    expect(body.version.number).toBe(1);

    const listed = await listVersions(
      new Request(`https://example.invalid/api/agents/${body.agent.id}/versions`, {
        headers: headers('builder'),
      }),
      { params: Promise.resolve({ id: body.agent.id }) },
    );
    const listing = AgentVersionListResponseSchema.parse(await listed.json());
    expect(listing.pointers).toMatchObject([{ environment: 'local', number: 1 }]);
  });

  it('answers a dry run with {ok: true, number: 1} and creates nothing', async () => {
    const response = await post(fromVersionRequest({ dryRun: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, number: 1 });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
    expect(versions.versionCount()).toBe(0);
  });

  it('refuses a Viewer with 403 forbidden', async () => {
    const response = await post(fromVersionRequest(), { actor: 'viewer' });
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: 'forbidden' });
  });

  it('answers a pipeline refusal with nothing created', async () => {
    const response = await post(fromVersionRequest({ resources: { skills: ['triage'] } }));
    expect(response.status).toBe(422);
    expect(await errorOf(response)).toMatchObject({
      code: 'agent_definition_references_missing',
      details: ['skill:triage'],
    });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
  });

  it('answers 503 agent_policy_not_configured without the versions runtime', async () => {
    clearAgentVersionsRuntime();
    const response = await post(fromVersionRequest());
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'agent_policy_not_configured' });
  });

  it('reads a version body past the legacy bound, and refuses one past the create bound (risk 2)', async () => {
    const padded = JSON.stringify(fromVersionRequest()) + ' '.repeat(MAX_REQUEST_BODY_BYTES);
    expect((await post(undefined, { raw: padded })).status).toBe(201);
    const oversized =
      JSON.stringify(fromVersionRequest()) + ' '.repeat(MAX_CREATE_AGENT_BODY_BYTES);
    expect((await post(undefined, { raw: oversized })).status).toBe(413);
  });
});

describe('POST /api/agents legacy and compound forms (S1-06 risk 5 regression)', () => {
  it('still creates an agent from the legacy body', async () => {
    const response = await post(LEGACY_BODY);
    expect(response.status).toBe(201);
    expect(AgentResourceSchema.parse(await response.json()).name).toBe('Legacy agent');
  });

  it('answers a legacy body with an extra version key 400 invalid_body, as before version existed', async () => {
    const response = await post({ ...LEGACY_BODY, version: 1 });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_body' });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
  });

  it('refuses a compound body that also carries version, rather than ignoring version', async () => {
    const response = await post({
      agent: LEGACY_BODY,
      assignments: { files: [], skillIds: [], connectorIds: [] },
      version: fromVersionRequest().version,
    });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({
      code: 'invalid_body',
      details: ['version: not accepted beside agent'],
    });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
  });

  it('still creates from a compound body without version', async () => {
    const response = await post({
      agent: LEGACY_BODY,
      assignments: { files: [], skillIds: [], connectorIds: [] },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ agent: { name: 'Legacy agent' } });
  });
});
