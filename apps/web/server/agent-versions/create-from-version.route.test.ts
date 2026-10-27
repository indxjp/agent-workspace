import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from '@agent-workspace/core/storage';
import {
  AgentVersionListResponseSchema,
  CreateAgentFromVersionResponseSchema,
} from '@indx-workspace/contracts/agent-versions';
import { AgentResourceSchema } from '@indx-workspace/contracts/agents';

import { POST } from '../../app/api/agents/route';
import {
  GET as listVersions,
  POST as createVersion,
} from '../../app/api/agents/[id]/versions/route';
import { MAX_REQUEST_BODY_BYTES } from '../agents/http';
import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { AgentStoreProvider } from '../agents/store';
import { type WorkspaceResolution } from '../agents/runtime';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createSkillRowsWorld } from '../skills/rows-fixture';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createRepositoryStorageConnectionsStoreProvider } from '../storage-connections/store';
import { MAX_CREATE_AGENT_BODY_BYTES } from './contract';
import { FIXTURE_PERMISSIONS, fromVersionRequest, versionRequest } from './fixtures';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
  type SeededReference,
} from './memory-store';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

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
  installTestDomains({
    agents: {
      agents,
      agentResources: {
        forWorkspace: () => ({
          get: () =>
            Promise.resolve({ files: [], skillIds: [], connectorIds: [], storageGrants: [] }),
          replace: (_agentId, next) =>
            Promise.resolve({
              kind: 'updated',
              assignments: { ...next, storageGrants: next.storageGrants ?? [] },
            }),
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
    },
  });
  installTestDomains({ agentVersions: { versions } });
  installTestDomains({
    rbac: {
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
    },
  });
});

afterEach(() => {
  clearApplicationContext();
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

  it("refuses via 'builder' from a client with 400 invalid_agent_version, creating nothing", async () => {
    const request = fromVersionRequest();
    const response = await post({ ...request, version: { ...request.version, via: 'builder' } });
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toMatchObject({ code: 'invalid_agent_version' });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
  });

  it('installs a built-in skill the first version names, then creates the agent', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'create-builtin-'));
    try {
      const skillRows: SeededReference[] = [];
      installTestDomains({
        agentVersions: {
          versions: createInMemoryAgentVersionStoreProvider({
            agents,
            references: { [WORKSPACE]: { skill: skillRows } },
          }),
        },
      });
      const memory = createInMemoryCatalogStore();
      const catalog = memory.forWorkspaceSync(WORKSPACE);
      const put = catalog.putSkill.bind(catalog);
      // Stands in for the `agent_skills` join: a skill the installer creates must resolve as a reference.
      vi.spyOn(catalog, 'putSkill').mockImplementation(async (input) => {
        const skill = await put(input);
        skillRows.push({ id: skill.id, name: skill.name });
        return skill;
      });
      installTestDomains({
        skills: {
          kind: 'serving',
          runtime: {
            resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
            store: createLocalFilesystemObjectStoreProvider(root),
            catalog: memory,
            storage: createSkillRowsWorld(createInMemoryObjectStore(), WORKSPACE, catalog).storage,
          },
        },
      });

      const response = await post(fromVersionRequest({ resources: { skills: ['office-reader'] } }));

      expect(response.status).toBe(201);
      expect(skillRows.map((row) => row.name)).toEqual(['office-reader']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not install a built-in skill for a dry run: a dry run has no side effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'create-builtin-dry-'));
    try {
      const memory = createInMemoryCatalogStore();
      const catalog = memory.forWorkspaceSync(WORKSPACE);
      const putSkill = vi.spyOn(catalog, 'putSkill');
      const objects = createLocalFilesystemObjectStoreProvider(root);
      installTestDomains({
        skills: {
          kind: 'serving',
          runtime: {
            resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
            store: objects,
            catalog: memory,
            storage: createSkillRowsWorld(createInMemoryObjectStore(), WORKSPACE, catalog).storage,
          },
        },
      });

      const response = await post(
        fromVersionRequest({ dryRun: true, resources: { skills: ['office-reader'] } }),
      );

      expect(response.status).toBe(422);
      expect(putSkill).not.toHaveBeenCalled();
      expect(await catalog.listSkills()).toEqual([]);
      expect(await catalog.listFiles()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('answers 503 agents_runtime_not_configured with no application context installed', async () => {
    // The agents and versions runtimes are installed together, so the agents runtime's own 503
    // answers first.
    clearApplicationContext();
    const response = await post(fromVersionRequest());
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toMatchObject({ code: 'agents_runtime_not_configured' });
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
      assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
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
      assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ agent: { name: 'Legacy agent' } });
  });
});

/** A serving storage-connections domain holding `acme-data`, whose only allowed folder is `reports`. */
async function installAcmeDataConnection(): Promise<void> {
  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'storage' }]);
  const repositories = createInMemoryStorageConnectionRepositoryProvider();
  const scope = await scopes.forWorkspaceId(WORKSPACE);
  if (scope === null) throw new Error('fixture workspace did not resolve');
  await repositories.forScope(scope).create({
    id: crypto.randomUUID(),
    name: 'acme-data',
    provider: 's3',
    url: 's3://acme-bucket',
    allowedPrefixes: ['reports'],
    writeAllowed: false,
  });
  installTestDomains({
    storageConnections: {
      kind: 'serving',
      runtime: {
        store: createRepositoryStorageConnectionsStoreProvider({
          repositories,
          scopes,
          secrets: createInMemorySecretsService(),
        }),
        fileRoots: [],
        egress: { production: true, allowHosts: [] },
        isConnectionGranted: () => Promise.resolve(false),
        audit: () => Promise.resolve(),
      },
    },
  });
}

const OUTSIDE_GRANT = {
  resources: { files: [{ path: 'storage://acme-data/secrets', access: 'read' as const }] },
};

describe('POST /api/agents {version} with a storage grant', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] refuses a folder outside the connection allowed list with 403', async () => {
    await installAcmeDataConnection();

    const response = await post(fromVersionRequest(OUTSIDE_GRANT));
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'storage_connection_prefix_not_allowed',
      details: ['storage://acme-data/secrets'],
    });
    expect(await agents.forWorkspace(WORKSPACE).list()).toEqual([]);
  });
});

describe('POST /api/agents/:id/versions with a storage grant', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] refuses a folder outside the connection allowed list with 403', async () => {
    const created = await post(fromVersionRequest());
    expect(created.status).toBe(201);
    const { agent } = CreateAgentFromVersionResponseSchema.parse(await created.json());
    await installAcmeDataConnection();

    const response = await createVersion(
      new Request(`https://example.invalid/api/agents/${agent.id}/versions`, {
        method: 'POST',
        headers: headers('builder'),
        body: JSON.stringify(versionRequest(OUTSIDE_GRANT)),
      }),
      { params: Promise.resolve({ id: agent.id }) },
    );
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({
      code: 'storage_connection_prefix_not_allowed',
      details: ['storage://acme-data/secrets'],
    });
    expect(versions.versionCount()).toBe(1);
  });
});
