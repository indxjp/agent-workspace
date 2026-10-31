/**
 * `DELETE /api/skills/:name` (issue #240, S-12), driven through the real route file against the
 * local-filesystem object store: the role gate, workspace concealment, the `409 skill_in_use`
 * refusal naming every assigned agent, the delete removing both the catalog row and the bytes, and
 * the retry that finishes a delete interrupted after its catalog step. The PostgreSQL transaction
 * is `packages/core/src/db/repositories/resource-catalogs.test.ts`.
 */
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createInMemoryWorkspaceScopeResolver, type CatalogSkill } from '@agent-workspace/core/db';

import { GET as listRoute, POST as importRoute } from '../../app/api/skills/route';
import {
  DELETE as deleteRoute,
  GET as detailRoute,
  PATCH as patchRoute,
} from '../../app/api/skills/[name]/route';
import { POST as publishRoute } from '../../app/api/skills/[name]/revisions/route';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { parseRole, type Role } from '../rbac/roles';
import { createStorageService, type StorageService } from '../storage/service';
import { deleteSkill } from './delete';
import { skillDeleteMarkerKey, skillMetaKey, skillRevisionRowFolder, skillRowFolder } from './keys';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { listAll, readWhole } from '@agent-workspace/core/storage/streams';
import {
  createRepositorySkillsStoreProvider,
  type WorkspaceSkillsStoreProvider,
} from '../storage/store';
import { listCatalogFiles } from '@agent-workspace/core/db';

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';
const OWNER = 'ab152b86-785a-4b7d-9e6a-6c329ca7e085';
const OTHER_BUILDER = 'bc152b86-785a-4b7d-9e6a-6c329ca7e086';
const THIRD_BUILDER = 'cd152b86-785a-4b7d-9e6a-6c329ca7e087';
const AGENT = '77777777-7777-4777-8777-777777777777';
const WORKSPACE_HEADER = 'x-test-workspace';
const ROLE_HEADER = 'x-test-role';
const PRINCIPAL_HEADER = 'x-test-principal';

let rootDir: string;
let skills: WorkspaceSkillsStoreProvider;
/**
 * Runs when the delete removes the skill's file rows — after its catalog step, before its byte
 * step. A test sets it to fail the delete there, or to race a list against it.
 */
let onSkillFileDelete: (() => Promise<void>) | null = null;
let catalog: ReturnType<typeof createInMemoryCatalogStore>;
/** The files catalog service the skills' rows are saved and removed through. */
let storage: StorageService;

beforeEach(async () => {
  catalog = createInMemoryCatalogStore();
  const rowsService = createStorageService({
    catalog: (workspaceId) => catalog.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
  storage = {
    ...rowsService,
    remove: async (ctx, area, target, options) => {
      const hook = onSkillFileDelete;
      if (hook !== null && target === skillRowFolder('demo')) {
        onSkillFileDelete = null;
        await hook();
      }
      return rowsService.remove(ctx, area, target, options);
    },
  };
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'sdk-08-skill-delete-'));
  skills = createRepositorySkillsStoreProvider({
    store: createLocalFilesystemObjectStoreProvider(rootDir),
    scopes: createInMemoryWorkspaceScopeResolver([
      { id: WORKSPACE_A, slug: 'acme' },
      { id: WORKSPACE_B, slug: 'globex' },
    ]),
  });
  const real = skills;
  installTestDomains({
    skills: {
      kind: 'serving',
      runtime: {
        store: real,
        catalog,
        storage,
        resolveWorkspace: (request) => {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          return Promise.resolve(
            workspaceId === null
              ? { kind: 'unauthenticated', reason: 'no test workspace header' }
              : { kind: 'workspace', workspaceId },
          );
        },
      },
    },
  });
  installTestDomains({
    rbac: {
      directory: createMemoryDirectory({
        users: [
          {
            email: 'owner-a@example.test',
            name: 'Owner A',
            workspaceId: WORKSPACE_A,
            role: 'owner',
          },
          {
            email: 'owner-b@example.test',
            name: 'Owner B',
            workspaceId: WORKSPACE_B,
            role: 'owner',
          },
        ],
      }),
      identify: (request) => {
        const workspaceId = request.headers.get(WORKSPACE_HEADER);
        return Promise.resolve(
          workspaceId === null
            ? null
            : Principal.fromApiKey({
                principalId: request.headers.get(PRINCIPAL_HEADER) ?? OWNER,
                apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                workspaceId,
                role: parseRole(request.headers.get(ROLE_HEADER)) ?? 'owner',
                label: 'Skill delete test key',
              }),
        );
      },
    },
  });
});

afterEach(async () => {
  onSkillFileDelete = null;
  clearApplicationContext();
  await rm(rootDir, { recursive: true, force: true });
});

interface Caller {
  readonly workspace?: string;
  readonly role?: Role;
  readonly principal?: string;
}

function req(method: string, url: string, caller: Caller = {}, body?: unknown): Request {
  const headers = new Headers({ [WORKSPACE_HEADER]: caller.workspace ?? WORKSPACE_A });
  if (caller.role !== undefined) headers.set(ROLE_HEADER, caller.role);
  if (caller.principal !== undefined) headers.set(PRINCIPAL_HEADER, caller.principal);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const context = (name: string): { params: Promise<{ name: string }> } => ({
  params: Promise.resolve({ name }),
});

async function importDemo(caller: Caller = {}): Promise<void> {
  const response = await importRoute(
    req('POST', '/api/skills', caller, {
      name: 'demo',
      files: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('---\nname: demo\n---\n# Demo').toString('base64'),
        },
        { path: 'scripts/run.sh', contentBase64: Buffer.from('echo hi').toString('base64') },
      ],
    }),
  );
  expect(response.status, await response.clone().text()).toBe(201);
}

function remove(name: string, caller: Caller = {}): Promise<Response> {
  return deleteRoute(req('DELETE', `/api/skills/${name}`, caller), context(name));
}

/** Where a skill's files are held: the paths of its `skills` rows (a folder is `.skills/demo`). */
async function rowPaths(workspaceId: string, folder = skillRowFolder('demo')): Promise<string[]> {
  const listed = await storage.list({ workspaceId }, 'skills', folder);
  return listed.rows.map((row) => row.path);
}

async function storedKeys(workspaceId: string): Promise<readonly string[]> {
  const store = skills.forWorkspace(workspaceId);
  const files = await listAll(store, 'skills/demo', { recursive: true });
  const meta = await readWhole(store, skillMetaKey('demo'));
  return [
    ...(await rowPaths(workspaceId)),
    ...files.map((entry) => entry.key),
    ...(meta === null ? [] : [skillMetaKey('demo')]),
  ];
}

function publish(caller: Caller = {}): Promise<Response> {
  return publishRoute(
    req('POST', '/api/skills/demo/revisions', caller, {
      files: [
        {
          path: 'SKILL.md',
          contentBase64: Buffer.from('---\nname: demo\n---\n# v1').toString('base64'),
        },
      ],
    }),
    context('demo'),
  );
}

describe('POST /api/skills/:name/revisions (SDK-19, N-1)', () => {
  it('refuses a Viewer and a Builder who does not own the skill, and lets the owner and an Admin publish', async () => {
    await importDemo({ role: 'builder', principal: OTHER_BUILDER });
    for (const caller of [
      { role: 'viewer' },
      { role: 'builder', principal: THIRD_BUILDER },
    ] as const) {
      const response = await publish(caller);
      expect(response.status, JSON.stringify(caller)).toBe(403);
    }
    const owner = await publish({ role: 'builder', principal: OTHER_BUILDER });
    expect(owner.status, await owner.clone().text()).toBe(201);
    const admin = await publish({ role: 'admin', principal: THIRD_BUILDER });
    expect(admin.status, await admin.clone().text()).toBe(201);
    expect(((await admin.json()) as { revision: { number: number } }).revision.number).toBe(2);
  });

  it('is removed with the skill: no revision bytes survive its delete', async () => {
    await importDemo();
    expect((await publish()).status).toBe(201);
    const folder = skillRevisionRowFolder('demo', 1);
    expect(await rowPaths(WORKSPACE_A, folder)).toHaveLength(1);
    expect((await remove('demo')).status).toBe(204);
    expect(await rowPaths(WORKSPACE_A, folder)).toHaveLength(0);
  });
});

describe('DELETE /api/skills/:name', () => {
  it('refuses a Viewer and a Builder who does not own the skill', async () => {
    await importDemo();
    for (const caller of [
      { role: 'viewer' },
      { role: 'builder', principal: OTHER_BUILDER },
    ] as const) {
      const response = await remove('demo', caller);
      expect(response.status, JSON.stringify(caller)).toBe(403);
    }
    expect(await storedKeys(WORKSPACE_A)).toHaveLength(2);
  });

  it('lets an Admin key list, import, update and delete any skill (ADR-0116)', async () => {
    await importDemo({ role: 'builder', principal: OTHER_BUILDER });
    const admin = { role: 'admin', principal: THIRD_BUILDER } as const;
    const listed = await listRoute(req('GET', '/api/skills', admin));
    expect(listed.status, await listed.clone().text()).toBe(200);
    const imported = await importRoute(
      req('POST', '/api/skills', admin, {
        name: 'admin-made',
        files: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('---\nname: admin-made\n---\n').toString('base64'),
          },
        ],
      }),
    );
    expect(imported.status, await imported.clone().text()).toBe(201);
    // Another member's skill: Admin's width is `any`, not `own`.
    const patched = await patchRoute(
      req('PATCH', '/api/skills/demo', admin, { enabled: false }),
      context('demo'),
    );
    expect(patched.status, await patched.clone().text()).toBe(200);
    expect((await remove('demo', admin)).status).toBe(204);
    expect(await storedKeys(WORKSPACE_A)).toEqual([]);
  });

  it('lets the owning Builder delete it', async () => {
    await importDemo({ role: 'builder', principal: OTHER_BUILDER });
    const response = await remove('demo', { role: 'builder', principal: OTHER_BUILDER });
    expect(response.status).toBe(204);
    expect(await storedKeys(WORKSPACE_A)).toEqual([]);
  });

  it("answers 404 for another workspace's skill and deletes nothing", async () => {
    await importDemo();
    const response = await remove('demo', { workspace: WORKSPACE_B });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'skill_not_found' } });
    expect(await storedKeys(WORKSPACE_A)).toHaveLength(2);
  });

  it('refuses an assigned skill with 409 skill_in_use naming the agent and keeps row and bytes', async () => {
    await importDemo();
    catalog.forWorkspaceSync(WORKSPACE_A).assignSkill('demo', AGENT);

    const refused = await remove('demo');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: 'skill_in_use', details: [`agent:${AGENT}`] },
    });
    expect(await storedKeys(WORKSPACE_A)).toHaveLength(2);
    const stillThere = await detailRoute(req('GET', '/api/skills/demo'), context('demo'));
    expect(stillThere.status).toBe(200);
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] a skill in use keeps its catalog rows', async () => {
    await importDemo();
    const workspaceCatalog = catalog.forWorkspaceSync(WORKSPACE_A);
    workspaceCatalog.assignSkill('demo', AGENT);
    const refused = await deleteSkill(skills.forWorkspace(WORKSPACE_A), workspaceCatalog, 'demo', {
      storage,
      workspaceId: WORKSPACE_A,
    });

    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'skill_in_use' } } });
    expect((await listCatalogFiles(workspaceCatalog)).map((row) => row.path)).toContain(
      '.skills/demo/SKILL.md',
    );
  });

  it("deletes an unassigned skill's row and bytes, then answers 404", async () => {
    await importDemo();
    const deleted = await remove('demo');
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(await storedKeys(WORKSPACE_A)).toEqual([]);
    expect(await (await catalog.forWorkspace(WORKSPACE_A)).listSkills()).toEqual([]);

    const gone = await detailRoute(req('GET', '/api/skills/demo'), context('demo'));
    expect(gone.status).toBe(404);
    expect((await remove('demo')).status).toBe(404);
  });

  it('finishes a delete that stopped after removing the catalog row with no marker (a pre-#240 state)', async () => {
    await importDemo();
    await (await catalog.forWorkspace(WORKSPACE_A)).deleteSkill('demo');
    expect(await storedKeys(WORKSPACE_A)).toHaveLength(2);

    const response = await remove('demo');
    expect(response.status).toBe(204);
    expect(await storedKeys(WORKSPACE_A)).toEqual([]);
  });

  describe('an interrupted or raced delete (ADR-0077 D3)', () => {
    async function listedNames(caller: Caller): Promise<readonly string[]> {
      const response = await listRoute(req('GET', '/api/skills', caller));
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as { skills: Array<{ name: string }> };
      return body.skills.map((skill) => skill.name);
    }

    async function catalogRows(): Promise<readonly CatalogSkill[]> {
      return (await catalog.forWorkspace(WORKSPACE_A)).listSkills();
    }

    it('keeps an interrupted delete from being resurrected or claimed, and lets its owner finish it', async () => {
      const builder = { role: 'builder', principal: OTHER_BUILDER } as const;
      await importDemo(builder);
      onSkillFileDelete = () => Promise.reject(new Error('object store unavailable'));
      await expect(remove('demo', builder)).rejects.toThrow('object store unavailable');
      // The row stays, marked, with the owner a retry needs.
      expect(await catalogRows()).toMatchObject([
        { name: 'demo', pendingDelete: { ownerPrincipalId: OTHER_BUILDER } },
      ]);
      expect(await storedKeys(WORKSPACE_A)).toHaveLength(2);

      // Neither a list nor a read by anyone brings the row back or hands it to the reader.
      for (const reader of [{ role: 'builder', principal: THIRD_BUILDER }, {}] as const) {
        expect(await listedNames(reader)).toEqual([]);
        const detail = await detailRoute(req('GET', '/api/skills/demo', reader), context('demo'));
        expect(detail.status).toBe(404);
      }
      expect((await catalogRows()).map((row) => row.name)).toEqual(['demo']);

      // Another Builder cannot finish it; the owning Builder can.
      expect((await remove('demo', { role: 'builder', principal: THIRD_BUILDER })).status).toBe(
        403,
      );
      const retried = await remove('demo', builder);
      expect(retried.status).toBe(204);
      expect(await storedKeys(WORKSPACE_A)).toEqual([]);
      expect(
        await readWhole(skills.forWorkspace(WORKSPACE_A), skillDeleteMarkerKey('demo')),
      ).toBeNull();
      expect(await catalogRows()).toEqual([]);
      expect((await remove('demo')).status).toBe(404);
    });

    it('a list that races the delete neither re-creates the row nor changes its owner', async () => {
      const builder = { role: 'builder', principal: OTHER_BUILDER } as const;
      await importDemo(builder);
      let raced: readonly string[] | null = null;
      onSkillFileDelete = async () => {
        raced = await listedNames({ role: 'builder', principal: THIRD_BUILDER });
      };
      expect((await remove('demo', builder)).status).toBe(204);
      expect(raced).toEqual([]);
      expect(await catalogRows()).toEqual([]);
      expect(await listedNames({})).toEqual([]);
    });

    it('sweeps a row a sync inserted after reading the platform record, before the marker existed', async () => {
      await importDemo();
      onSkillFileDelete = async () => {
        await (
          await catalog.forWorkspace(WORKSPACE_A)
        ).putSkill({
          name: 'demo',
          skillMd: '# stale sync',
          enabled: true,
          ownerPrincipalId: THIRD_BUILDER,
          createdBy: null,
        });
      };
      expect((await remove('demo')).status).toBe(204);
      expect(await catalogRows()).toEqual([]);
    });

    it('leaves the row unmarked when the delete is refused as in use', async () => {
      await importDemo();
      catalog.forWorkspaceSync(WORKSPACE_A).assignSkill('demo', AGENT);
      expect((await remove('demo')).status).toBe(409);
      expect(await catalogRows()).toMatchObject([{ name: 'demo', pendingDelete: null }]);
      expect(await listedNames({})).toEqual(['demo']);
    });
  });
});
