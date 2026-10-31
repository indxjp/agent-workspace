import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from '@agent-workspace/core/storage';
import {
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
} from '@indx-workspace/contracts/agent-versions';

import { GET, POST } from './route';
import { createInMemoryAgentStoreProvider } from '../../../../../server/agents/memory-store';
import { type WorkspaceResolution } from '../../../../../server/agents/runtime';
import {
  FIXTURE_PERMISSIONS,
  FIXTURE_POLICY,
  versionRequest,
} from '../../../../../server/agent-versions/fixtures';
import {
  createInMemoryAgentVersionStoreProvider,
  type InMemoryAgentVersionStoreProvider,
  type SeededReference,
} from '../../../../../server/agent-versions/memory-store';
import { clearApplicationContext } from '../../../../../server/application-context';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import { createMemoryDirectory } from '../../../../../server/rbac/memory-directory';
import { Principal } from '../../../../../server/rbac/principal';
import { createSkillRowsWorld } from '../../../../../server/skills/rows-fixture';
import { createInMemoryCatalogStore } from '../../../../../server/resources/catalog-store.memory';
import { listCatalogFiles } from '@agent-workspace/core/db';

/**
 * `GET`/`POST /api/agents/:id/versions` (S1-05, issue #443) on the memory stores, driven with
 * real `Request` objects. RBAC is real: `decide()` answers `403 forbidden` for a Viewer's `POST`
 * and for a Builder on another principal's agent before the handler runs. The full role matrix is
 * `apps/web/server/rbac/authorisation-matrix.test.ts`'s, derived from the route declaration.
 */
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const OTHER_WORKSPACE = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_HEADER = 'x-test-workspace';
const ACTOR_HEADER = 'x-test-actor';

const ACTORS = {
  owner: { principalId: 'a0000000-0000-4000-8000-000000000001', role: 'owner' },
  builderA: { principalId: 'a0000000-0000-4000-8000-000000000002', role: 'builder' },
  builderB: { principalId: 'a0000000-0000-4000-8000-000000000003', role: 'builder' },
  viewer: { principalId: 'a0000000-0000-4000-8000-000000000004', role: 'viewer' },
} as const;
type Actor = keyof typeof ACTORS;

let versions: InMemoryAgentVersionStoreProvider;
let agentOfBuilderA: string;
let skillRows: SeededReference[];

function isActor(value: string): value is Actor {
  return Object.hasOwn(ACTORS, value);
}

beforeEach(async () => {
  skillRows = [];
  const agents = createInMemoryAgentStoreProvider();
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: null,
      model: null,
      permissions: FIXTURE_PERMISSIONS,
    },
    { principalId: ACTORS.builderA.principalId, userId: null },
  );
  if (created.kind !== 'created') throw new Error('the memory store creates the fixture agent');
  agentOfBuilderA = created.agent.id;
  versions = createInMemoryAgentVersionStoreProvider({
    agents,
    references: {
      [WORKSPACE]: { connector: [{ id: 'c1', name: 'tickets' }], skill: skillRows },
    },
  });

  installTestDomains({
    agents: {
      agents,
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
            label: `${actor} versions key`,
          }),
        );
      },
    },
  });
});

afterEach(() => {
  clearApplicationContext();
});

function call(
  handler: typeof GET,
  options: { actor: Actor; id?: string; workspace?: string; body?: unknown },
): Promise<Response> {
  const headers = new Headers({
    [WORKSPACE_HEADER]: options.workspace ?? WORKSPACE,
    [ACTOR_HEADER]: options.actor,
  });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const id = options.id ?? agentOfBuilderA;
  const request = new Request(`https://example.invalid/api/agents/${id}/versions`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return handler(request, { params: Promise.resolve({ id }) });
}

async function errorCode(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
}

describe('POST /api/agents/:id/versions', () => {
  it('refuses a Viewer dry run with 403 forbidden before the handler', async () => {
    const response = await call(POST, {
      actor: 'viewer',
      body: { ...versionRequest(), dryRun: true },
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toMatchObject({ code: 'forbidden' });
  });

  it("refuses a Builder on another principal's agent with 403 forbidden", async () => {
    const response = await call(POST, { actor: 'builderB', body: versionRequest() });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toMatchObject({ code: 'forbidden' });
    expect(versions.versionCount()).toBe(0);
  });

  it('answers 400 invalid_agent_id for an id that is not a UUID, before RBAC decides', async () => {
    for (const handler of [POST, GET]) {
      const response = await call(handler, {
        actor: 'viewer',
        id: 'nope',
        ...(handler === POST ? { body: versionRequest() } : {}),
      });
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toMatchObject({ code: 'invalid_agent_id' });
    }
  });

  it("refuses via 'builder' from a client with 400 invalid_agent_version, saving nothing", async () => {
    const response = await call(POST, {
      actor: 'builderA',
      body: { ...versionRequest(), via: 'builder' },
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toMatchObject({ code: 'invalid_agent_version' });
    expect(versions.versionCount()).toBe(0);
  });

  it('answers 404 agent_not_found for a foreign id before RBAC decides', async () => {
    const foreign = await call(POST, {
      actor: 'owner',
      workspace: OTHER_WORKSPACE,
      body: versionRequest(),
    });
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toMatchObject({ code: 'agent_not_found' });
  });

  it('saves version 1 for the owning Builder, and the next for the workspace Owner', async () => {
    const dryRun = await call(POST, {
      actor: 'builderA',
      body: { ...versionRequest(), dryRun: true },
    });
    expect(dryRun.status).toBe(200);
    expect(await dryRun.json()).toEqual({ ok: true, number: 1 });
    expect(versions.versionCount()).toBe(0);

    const first = await call(POST, { actor: 'builderA', body: versionRequest() });
    expect(first.status).toBe(201);
    const resource = AgentVersionResourceSchema.parse(await first.json());
    expect(resource).toMatchObject({
      number: 1,
      agentId: agentOfBuilderA,
      createdByPrincipalId: ACTORS.builderA.principalId,
    });

    const second = await call(POST, { actor: 'owner', body: versionRequest() });
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ number: 2 });
  });

  it('refuses a connector on an engine without mcp with 422 and details ["mcp"], dry run or not', async () => {
    const body = versionRequest({
      policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
      resources: { connectors: ['tickets'] },
    });
    for (const request of [{ ...body, dryRun: true }, body]) {
      const response = await call(POST, { actor: 'builderA', body: request });
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toMatchObject({
        code: 'engine_capability_unsupported',
        details: ['mcp'],
      });
    }
    expect(versions.versionCount()).toBe(0);
  });

  it('refuses a missing skill with 422 and details ["skill:<name>"], dry run or not', async () => {
    const body = versionRequest({ resources: { skills: ['triage'] } });
    for (const request of [{ ...body, dryRun: true }, body]) {
      const response = await call(POST, { actor: 'builderA', body: request });
      expect(response.status).toBe(422);
      expect(await errorCode(response)).toMatchObject({
        code: 'agent_definition_references_missing',
        details: ['skill:triage'],
      });
    }
    expect(versions.versionCount()).toBe(0);
  });

  it('saves a version naming a built-in skill on a workspace that has never imported it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'versions-builtin-'));
    try {
      const objects = createLocalFilesystemObjectStoreProvider(root);
      const memory = createInMemoryCatalogStore();
      const catalog = memory.forWorkspaceSync(WORKSPACE);
      const put = catalog.putSkill.bind(catalog);
      // Stands in for the `agent_skills` join: a skill the installer creates must resolve as a reference.
      vi.spyOn(catalog, 'putSkill').mockImplementation(async (input) => {
        const skill = await put(input);
        if (!skillRows.some((row) => row.id === skill.id)) {
          skillRows.push({ id: skill.id, name: skill.name });
        }
        return skill;
      });
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
      const body = versionRequest({ resources: { skills: ['office-reader'] } });

      const saved = await call(POST, { actor: 'builderA', body });

      expect(saved.status).toBe(201);
      expect((await catalog.listSkills()).map((skill) => skill.name)).toEqual(['office-reader']);
      expect((await listCatalogFiles(catalog)).map((file) => file.path)).toContainEqual(
        expect.stringMatching(/office-reader\/scripts\/pdf\.mjs$/),
      );

      const again = await call(POST, { actor: 'builderA', body });
      expect(again.status).toBe(201);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not install a built-in skill for a dry run: a dry run has no side effects', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'versions-builtin-dry-'));
    try {
      const objects = createLocalFilesystemObjectStoreProvider(root);
      const memory = createInMemoryCatalogStore();
      const catalog = memory.forWorkspaceSync(WORKSPACE);
      const putSkill = vi.spyOn(catalog, 'putSkill');
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
      const body = versionRequest({ resources: { skills: ['office-reader'] } });

      const dry = await call(POST, { actor: 'builderA', body: { ...body, dryRun: true } });

      expect(dry.status).toBe(422);
      expect(putSkill).not.toHaveBeenCalled();
      expect(await catalog.listSkills()).toEqual([]);
      expect(await listCatalogFiles(catalog)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('answers 503 rbac_runtime_not_configured with no application context installed', async () => {
    // The RBAC runtime lives in the context, so the gate refuses first (fail closed) before any
    // version store is read.
    clearApplicationContext();
    const response = await call(POST, { actor: 'builderA', body: versionRequest() });
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toMatchObject({ code: 'rbac_runtime_not_configured' });
  });
});

describe('GET /api/agents/:id/versions', () => {
  it('lists the saved versions for a Viewer, in the published shape', async () => {
    await call(POST, { actor: 'builderA', body: versionRequest() });
    const response = await call(GET, { actor: 'viewer' });
    expect(response.status).toBe(200);
    const listing = AgentVersionListResponseSchema.parse(await response.json());
    expect(listing.items.map((item) => item.number)).toEqual([1]);
    expect(listing.pointers).toEqual([]);
    // Saving a version does not write the agent row, so it is not materialised from one.
    expect(listing.materialised).toBeNull();
    expect(listing.evaluations).toEqual([]);
  });

  it('lists the newest evaluation of each evaluated version for a Viewer (#714)', async () => {
    for (const instructions of ['one', 'two', 'three'])
      await call(POST, { actor: 'builderA', body: versionRequest({ instructions }) });
    const saved = AgentVersionListResponseSchema.parse(
      await (await call(GET, { actor: 'viewer' })).json(),
    );
    const [first, second] = [...saved.items].sort((a, b) => a.number - b.number);
    if (first === undefined || second === undefined) throw new Error('three versions were saved');
    versions.recordEvaluation(first.id, { score: 0.5, passed: 1, total: 2, failing: ['a'] });
    versions.recordEvaluation(first.id, { score: 0.9, passed: 9, total: 10, failing: ['b'] });
    versions.recordEvaluation(second.id, { score: 1, passed: 3, total: 3, failing: [] });

    const response = await call(GET, { actor: 'viewer' });
    expect(response.status).toBe(200);
    const listing = AgentVersionListResponseSchema.parse(await response.json());
    expect(listing.evaluations).toEqual([
      { version: 1, score: 0.9, passed: 9, total: 10 },
      { version: 2, score: 1, passed: 3, total: 3 },
    ]);
  });

  it('answers 404 agent_not_found for the agent of another workspace (#714)', async () => {
    const response = await call(GET, { actor: 'viewer', workspace: OTHER_WORKSPACE });
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toMatchObject({ code: 'agent_not_found' });
  });
});
