/**
 * The skills route handlers, imported as Next.js will import them and driven with real `Request`
 * objects. Mirrors `apps/web/server/files/routes.test.ts`'s shape.
 *
 * The acceptance-criterion proof lives in the last `describe` block below: a real directory tree
 * on disk — shaped like `.claude/skills/<name>/`, with one file ending in a trailing newline and
 * one that does not, plus a third carrying embedded CRLFs — imported through `POST /api/skills`
 * and read back through `GET /api/skills/:name?export=true`, both real HTTP route handlers, with
 * every file's bytes compared for exact equality and hashed with SHA-256 on both sides. See
 * `apps/web/app/api/skills/[name]/route.ts`'s own header for why export is a query flag on the
 * detail route rather than a sibling `/export` route.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as listRoute, POST as importRoute } from '../../app/api/skills/route';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { createLocalFilesystemObjectStoreProvider } from './object-store-bridge';
import { skillFileKey, skillMetaKey } from './keys';
import { clearSkillsRuntime, configureSkillsRuntime, type WorkspaceResolution } from './runtime';
import { createRepositorySkillsStoreProvider } from './store';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import {
  createInMemoryWorkspaceScopeResolver,
  openDatabaseRoot,
  type DatabaseRoot,
} from '@agent-workspace/core/db';
import {
  apiKeys,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { createPostgresDirectory } from '../rbac/postgres-directory';
import { Principal } from '../rbac/principal';
import { clearRbacRuntime, configureRbacRuntime } from '../rbac/runtime';

const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, in the DB-backed suite below. */
const ACTOR_HEADER = 'x-test-actor';
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

let rootDir: string;

/**
 * K-4 (issue #234): a route with no catalog wired now answers `503 skills_runtime_not_configured`
 * rather than a body without the id every `SkillDetail` requires — see `apps/web/app/api/
 * skills/route.ts`. The composed control plane always wires a real, PostgreSQL-backed one
 * (`apps/web/server/composition/register.ts`); this in-memory stand-in gives the tests below the
 * same "a catalog is always configured" premise without a database, exactly the way
 * `createInMemoryAgentStoreProvider` stands in for `apps/web/server/agents/store.ts`'s PostgreSQL
 * half. Only `listSkills`/`putSkill` are real — the file operations are unused by these routes.
 */
interface CatalogRow {
  readonly id: string;
  readonly name: string;
  readonly skillMd: string;
  readonly enabled: boolean;
}

function createInMemoryCatalog(): ResourceCatalogStoreProvider {
  const byWorkspace = new Map<string, Map<string, CatalogRow>>();
  let nextId = 0;
  return {
    forWorkspace(workspaceId: string) {
      const rows = byWorkspace.get(workspaceId) ?? new Map<string, CatalogRow>();
      byWorkspace.set(workspaceId, rows);
      const repository = {
        listFiles: () => Promise.reject(new Error('unused')),
        putFile: () => Promise.reject(new Error('unused')),
        renameFile: () => Promise.reject(new Error('unused')),
        deleteFile: () => Promise.reject(new Error('unused')),
        listSkills: () =>
          Promise.resolve(
            [...rows.values()].map((row) => ({
              ...row,
              createdBy: null,
              ownerPrincipalId: 'test-owner',
            })),
          ),
        putSkill: (input: { name: string; skillMd: string; enabled: boolean }) => {
          const existing = rows.get(input.name);
          const id = existing?.id ?? `catalog-${String((nextId += 1))}`;
          const row = { id, name: input.name, skillMd: input.skillMd, enabled: input.enabled };
          rows.set(input.name, row);
          return Promise.resolve({ ...row, createdBy: null, ownerPrincipalId: 'test-owner' });
        },
        deleteSkill: (name: string) => {
          rows.delete(name);
          return Promise.resolve();
        },
      };
      return Promise.resolve(
        repository as unknown as Awaited<ReturnType<ResourceCatalogStoreProvider['forWorkspace']>>,
      );
    },
  };
}

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-routes-'));
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE_A, slug: 'acme' },
    { id: WORKSPACE_B, slug: 'globex' },
  ]);
  const store = createRepositorySkillsStoreProvider({
    store: createLocalFilesystemObjectStoreProvider(rootDir),
    scopes,
  });
  configureSkillsRuntime({
    store,
    catalog: createInMemoryCatalog(),
    resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      if (workspaceId === null) {
        return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
      }
      return Promise.resolve({ kind: 'workspace', workspaceId });
    },
  });
  configureRbacRuntime({
    // Issue #117: every create/sync path resolves `created_by`, falling back to the workspace's
    // oldest Owner when the caller cannot be matched by email (true of every request here, which
    // authenticates as an API key) — so each fixture workspace needs at least one seeded member.
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
    identify(request: Request) {
      const workspaceId = request.headers.get(WORKSPACE_HEADER);
      return Promise.resolve(
        workspaceId === null
          ? null
          : Principal.fromApiKey({
              principalId: 'ab152b86-785a-4b7d-9e6a-6c329ca7e085',
              apiKeyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
              workspaceId,
              role: 'owner',
              label: 'Skills route test key',
            }),
      );
    },
  });
});

afterEach(async () => {
  clearSkillsRuntime();
  clearRbacRuntime();
  await rm(rootDir, { recursive: true, force: true });
});

function req(
  method: string,
  url: string,
  options: {
    workspace?: string;
    body?: BodyInit;
    contentType?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers(options.headers);
  if (options.workspace !== undefined) headers.set(WORKSPACE_HEADER, options.workspace);
  if (options.contentType !== undefined && options.contentType !== null) {
    headers.set('content-type', options.contentType);
  }
  return new Request(`https://example.invalid${url}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function nameContext(name: string): { params: Promise<{ name: string }> } {
  return { params: Promise.resolve({ name }) };
}

function postJson(workspace: string, body: unknown): Request {
  return req('POST', '/api/skills', {
    workspace,
    body: JSON.stringify(body),
    contentType: 'application/json',
  });
}

describe('skills routes, unconfigured', () => {
  it('answers 503, not 401 and not an empty 200, while nothing is wired', async () => {
    clearSkillsRuntime(); // this suite's beforeEach already configured one — undo it for this case
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
  });
});

/**
 * K-4 (issue #234): a store with no catalog is a distinct misconfiguration from no store at all
 * (the block above) — `withWorkspaceSkillsStore` still resolves a workspace and a store, but
 * `catalog` is `undefined`, which is exactly the state `SkillDetail.id` being required makes
 * unservable: no route may answer a body without the id every skill now carries.
 */
describe('K-4: a store with no catalog wired', () => {
  function useStoreWithoutCatalog(): void {
    const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]);
    const store = createRepositorySkillsStoreProvider({
      store: createLocalFilesystemObjectStoreProvider(rootDir),
      scopes,
    });
    configureSkillsRuntime({
      store,
      // No `catalog` — this is the one difference from the suite's own `beforeEach`.
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
    });
  }

  it('GET /api/skills answers 503 skills_runtime_not_configured', async () => {
    useStoreWithoutCatalog();
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
  });

  it('POST /api/skills answers 503 before writing anything', async () => {
    useStoreWithoutCatalog();
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('x').toString('base64') }],
      }),
    );
    expect(response.status).toBe(503);
  });

  it('GET /api/skills/:name and PATCH /api/skills/:name each answer 503', async () => {
    useStoreWithoutCatalog();
    const getResponse = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    expect(getResponse.status).toBe(503);
    const patchResponse = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patchResponse.status).toBe(503);
  });
});

/** K-4: a `SKILL.md` whose bytes are not valid UTF-8 can no longer be written at all. */
describe('K-4: a non-UTF-8 SKILL.md is refused', () => {
  // A lone continuation byte (0x80) is never valid UTF-8 on its own.
  const invalidUtf8Base64 = Buffer.from([0x80]).toString('base64');

  it('POST /api/skills refuses it with 400 malformed_content', async () => {
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'broken',
        files: [{ path: 'SKILL.md', contentBase64: invalidUtf8Base64 }],
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'malformed_content' } });
    // Nothing was written: a later import of the same name is not a 409.
    const retry = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'broken',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('ok').toString('base64') }],
      }),
    );
    expect(retry.status).toBe(201);
  });

  it('PATCH /api/skills/:name refuses replacing SKILL.md with invalid UTF-8 bytes', async () => {
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# ok').toString('base64') }],
      }),
    );
    const response = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ files: [{ path: 'SKILL.md', contentBase64: invalidUtf8Base64 }] }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'malformed_content' } });
  });
});

/**
 * K-4: the one state `POST`/`PATCH`'s new refusal cannot repair retroactively — a row written by
 * an earlier release with an unreadable `SKILL.md`. Simulated by writing the object directly, the
 * way an older build (with no UTF-8 guard) could have.
 */
describe('K-4: a pre-existing unreadable SKILL.md answers 500 store_inconsistent', () => {
  it('hides the whole GET /api/skills list rather than omitting the row or its id', async () => {
    // A well-formed skill, so the list is provably non-empty before the broken one is added.
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'fine',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# Fine').toString('base64') }],
      }),
    );
    // Simulate a pre-K-4 row: write the meta record and an unreadable SKILL.md directly to the
    // object store, bypassing the route layer's new UTF-8 guard entirely.
    const objectStore = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A);
    const now = new Date().toISOString();
    await objectStore.put(skillMetaKey('broken'), {
      body: new TextEncoder().encode(
        JSON.stringify({ name: 'broken', enabled: true, createdAt: now, updatedAt: now }),
      ),
      contentType: 'application/json',
    });
    await objectStore.put(skillFileKey('broken', 'SKILL.md'), {
      body: Uint8Array.from([0x80]),
      contentType: null,
    });

    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'store_inconsistent' } });
  });

  /**
   * Review finding: `GET`/`PATCH /api/skills/:name` used to bail out of the catalog sync with a
   * bare `return response;` when the export carried no `SKILL.md`, answering `200` with a body
   * that has no `id` — which `SkillDetailSchema` rejects — for exactly the row `GET /api/skills`
   * answers `500` for. The two routes must not disagree about one row.
   */
  it('answers 500 on GET and PATCH /api/skills/:name for a row with no SKILL.md object', async () => {
    // A meta record with no SKILL.md object at all: reachable from a pre-existing row, and from
    // `patchSkill`'s rollback path when no prior copy of SKILL.md was available to restore.
    const objectStore = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A);
    const now = new Date().toISOString();
    await objectStore.put(skillMetaKey('orphan'), {
      body: new TextEncoder().encode(
        JSON.stringify({ name: 'orphan', enabled: true, createdAt: now, updatedAt: now }),
      ),
      contentType: 'application/json',
    });

    const getResponse = await detailRoute(
      req('GET', '/api/skills/orphan', { workspace: WORKSPACE_A }),
      nameContext('orphan'),
    );
    expect(getResponse.status, await getResponse.clone().text()).toBe(500);
    expect(await getResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });

    const patchResponse = await patchRoute(
      req('PATCH', '/api/skills/orphan', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('orphan'),
    );
    expect(patchResponse.status, await patchResponse.clone().text()).toBe(500);
    expect(await patchResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });
  });

  /**
   * Review finding, the other half: a `SKILL.md` that *exists* but whose bytes are not valid UTF-8
   * is the same residual — `describeSkill` reports `source: null` for both — but `exportSkill`
   * base64-encodes those bytes just the same, so `manifest === undefined` is false and the route
   * used to answer `200` with an id built from a lossy `U+FFFD` decode, writing mojibake into the
   * catalog while `GET /api/skills` answered `500` for the very same row.
   */
  it('answers 500 on GET and PATCH /api/skills/:name for a SKILL.md with invalid UTF-8 bytes', async () => {
    const objectStore = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A);
    const now = new Date().toISOString();
    await objectStore.put(skillMetaKey('broken'), {
      body: new TextEncoder().encode(
        JSON.stringify({ name: 'broken', enabled: true, createdAt: now, updatedAt: now }),
      ),
      contentType: 'application/json',
    });
    // The same lone continuation byte the list test above writes: never valid UTF-8 on its own.
    await objectStore.put(skillFileKey('broken', 'SKILL.md'), {
      body: Uint8Array.from([0x80]),
      contentType: null,
    });

    const getResponse = await detailRoute(
      req('GET', '/api/skills/broken', { workspace: WORKSPACE_A }),
      nameContext('broken'),
    );
    expect(getResponse.status, await getResponse.clone().text()).toBe(500);
    expect(await getResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });

    const patchResponse = await patchRoute(
      req('PATCH', '/api/skills/broken', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('broken'),
    );
    expect(patchResponse.status, await patchResponse.clone().text()).toBe(500);
    expect(await patchResponse.json()).toMatchObject({ error: { code: 'store_inconsistent' } });
  });

  /**
   * The export path is deliberately unaffected: `SkillExportSchema` carries no `id`, so an export
   * of the same row needs no catalog and still answers 200 (with no files).
   */
  it('still exports the same row, because an export carries no id', async () => {
    const objectStore = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A);
    const now = new Date().toISOString();
    await objectStore.put(skillMetaKey('orphan'), {
      body: new TextEncoder().encode(
        JSON.stringify({ name: 'orphan', enabled: true, createdAt: now, updatedAt: now }),
      ),
      contentType: 'application/json',
    });

    const response = await detailRoute(
      req('GET', '/api/skills/orphan?export=true', { workspace: WORKSPACE_A }),
      nameContext('orphan'),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skill: { name: 'orphan', files: [] } });
  });
});

describe('POST /api/skills then GET /api/skills', () => {
  it('imports a skill and lists it back', async () => {
    const skillMd = '---\nname: demo\ndescription: A demo skill\n---\n\nBody.\n';
    const upload = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: Buffer.from(skillMd, 'utf8').toString('base64') },
        ],
      }),
    );
    expect(upload.status, await upload.clone().text()).toBe(201);
    const imported = (await upload.json()) as {
      skill: { name: string; description: string | null };
    };
    expect(imported.skill.name).toBe('demo');
    expect(imported.skill.description).toBe('A demo skill');

    const list = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { skills: Array<{ name: string }> };
    expect(body.skills.map((s) => s.name)).toEqual(['demo']);
  });

  it('rejects application/json-less bodies with 415', async () => {
    const response = await importRoute(
      req('POST', '/api/skills', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ name: 'demo', files: [] }),
      }),
    );
    expect(response.status).toBe(415);
  });

  it("a workspace cannot see another workspace's skills", async () => {
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'a-only',
        files: [{ path: 'SKILL.md', contentBase64: Buffer.from('x').toString('base64') }],
      }),
    );
    const list = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_B }));
    const body = (await list.json()) as { skills: Array<{ name: string }> };
    expect(body.skills).toEqual([]);
  });
});

describe('POST /api/skills when the catalog write fails', () => {
  it('leaves no trace of an import whose catalog write fails', async () => {
    const real = createInMemoryCatalog();
    let failNext = true;
    const catalog: ResourceCatalogStoreProvider = {
      forWorkspace: async (workspaceId) => {
        const repository = await real.forWorkspace(workspaceId);
        return {
          ...repository,
          putSkill: (input: Parameters<typeof repository.putSkill>[0]) => {
            if (!failNext) return repository.putSkill(input);
            failNext = false;
            return Promise.reject(new Error('database blip'));
          },
        };
      },
    };
    configureSkillsRuntime({
      store: createRepositorySkillsStoreProvider({
        store: createLocalFilesystemObjectStoreProvider(rootDir),
        scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]),
      }),
      catalog,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
    });
    const importBody = {
      name: 'demo',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from('# Demo').toString('base64') },
        { path: 'scripts/run.py', contentBase64: Buffer.from('print(1)').toString('base64') },
      ],
    };

    // The route rethrows; Next.js turns the unhandled error into the 500.
    await expect(importRoute(postJson(WORKSPACE_A, importBody))).rejects.toThrow('database blip');

    const list = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ skills: [] });
    const objectStore = createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A);
    expect(await objectStore.listPrefix('skills/demo')).toEqual([]);
    expect(await objectStore.get(skillMetaKey('demo'))).toBeNull();

    expect((await importRoute(postJson(WORKSPACE_A, importBody))).status).toBe(201);
  });
});

describe('GET/PATCH /api/skills/:name', () => {
  async function importDemo(): Promise<void> {
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [
          {
            path: 'SKILL.md',
            contentBase64: Buffer.from('---\nname: demo\n---\nbody\n').toString('base64'),
          },
        ],
      }),
    );
    expect(response.status).toBe(201);
  }

  it('404s a skill nobody imported', async () => {
    const response = await detailRoute(
      req('GET', '/api/skills/nope', { workspace: WORKSPACE_A }),
      nameContext('nope'),
    );
    expect(response.status).toBe(404);
  });

  it('gets the imported skill back', async () => {
    await importDemo();
    const response = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skill: { name: string } };
    expect(body.skill.name).toBe('demo');
  });

  it("one workspace cannot read or edit another workspace's skill by name", async () => {
    await importDemo();
    const get = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_B }),
      nameContext('demo'),
    );
    expect(get.status).toBe(404);

    const patch = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_B,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patch.status).toBe(404);

    // Proof A's copy is untouched by B's rejected patch.
    const stillEnabled = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    const body = (await stillEnabled.json()) as { skill: { enabled: boolean } };
    expect(body.skill.enabled).toBe(true);
  });

  it('disables a skill via PATCH', async () => {
    await importDemo();
    const patch = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({ enabled: false }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patch.status).toBe(200);
    const body = (await patch.json()) as { skill: { enabled: boolean } };
    expect(body.skill.enabled).toBe(false);
  });
});

describe('GET /api/skills/:name?export=true', () => {
  it('404s a skill nobody imported', async () => {
    const response = await detailRoute(
      req('GET', '/api/skills/nope?export=true', { workspace: WORKSPACE_A }),
      nameContext('nope'),
    );
    expect(response.status).toBe(404);
  });
});

/**
 * The wave plan's acceptance criterion for this task, verbatim: "a round-trip import then export
 * produces a BYTE-IDENTICAL tree, proven by hashing every file in both, INCLUDING one file with a
 * trailing newline and one without." This suite builds a real directory on disk shaped like
 * `.claude/skills/<name>/`, drives it through the real `POST /api/skills` and
 * `GET /api/skills/:name/export` route handlers (not the handler functions directly — the same
 * distinction `files/routes.test.ts` draws), writes the exported bytes back out to a second real
 * directory, and hashes every file in both with SHA-256, plus a byte-for-byte `Buffer.equals` on
 * top of the hash.
 */
describe('round-trip import -> export is byte-identical (the wave plan acceptance criterion)', () => {
  let sourceDir: string;
  let exportedDir: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-source-'));
    exportedDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-exported-'));
  });

  afterEach(async () => {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(exportedDir, { recursive: true, force: true });
  });

  function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  it('reproduces every byte, including a trailing newline, a missing one, and embedded CRLFs', async () => {
    // Build a real .claude/skills/<name>/ tree on disk — three files, three distinct
    // line-ending shapes, exactly the counter-examples a naive Windows implementation gets wrong.
    const skillRoot = path.join(sourceDir, '.claude', 'skills', 'round-trip-demo');
    await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });

    const files: Record<string, Buffer> = {
      // WITH a trailing newline.
      'SKILL.md': Buffer.from(
        '---\nname: round-trip-demo\ndescription: Proves byte-identical export\n---\n\nBody text.\n',
        'utf8',
      ),
      // WITHOUT a trailing newline.
      'scripts/run.sh': Buffer.from('#!/bin/sh\necho "no trailing newline"', 'utf8'),
      // Embedded CRLFs, which a text-mode read/write anywhere in the pipeline would collapse to LF.
      'notes.txt': Buffer.from('line one\r\nline two\r\nline three, no final EOL', 'utf8'),
    };

    for (const [relativePath, bytes] of Object.entries(files)) {
      const absolute = path.join(skillRoot, ...relativePath.split('/'));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, bytes); // no `encoding` option — see local-fs-store.ts's header
    }

    // Sanity check on the fixture itself, so a failure below is about the round trip and not
    // about this test having built a fixture that does not actually exercise the two shapes the
    // acceptance criterion names.
    expect(files['SKILL.md']?.subarray(-1).toString('utf8')).toBe('\n');
    expect(files['scripts/run.sh']?.subarray(-1).toString('utf8')).not.toBe('\n');

    // Import: read every file off disk, base64-encode its raw bytes, POST the manifest.
    const importBody = {
      name: 'round-trip-demo',
      files: Object.entries(files).map(([filePath, bytes]) => ({
        path: filePath,
        contentBase64: bytes.toString('base64'),
      })),
    };
    const imported = await importRoute(postJson(WORKSPACE_A, importBody));
    expect(imported.status, await imported.clone().text()).toBe(201);

    // Export: GET the tree back through the real route handler.
    const exported = await detailRoute(
      req('GET', '/api/skills/round-trip-demo?export=true', { workspace: WORKSPACE_A }),
      nameContext('round-trip-demo'),
    );
    expect(exported.status).toBe(200);
    const exportedBody = (await exported.json()) as {
      skill: { name: string; files: Array<{ path: string; contentBase64: string }> };
    };
    expect(exportedBody.skill.name).toBe('round-trip-demo');
    expect(exportedBody.skill.files).toHaveLength(Object.keys(files).length);

    // Write the exported tree back out to a second real directory, exactly the shape the source
    // was in, so "hashing every file in both" is about two directories on disk, not two in-memory
    // maps that happen to share a serialiser.
    for (const file of exportedBody.skill.files) {
      const absolute = path.join(exportedDir, ...file.path.split('/'));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.from(file.contentBase64, 'base64'));
    }

    // The proof: for every file in the source tree, the exported tree has a file at the same
    // relative path whose SHA-256 matches, AND whose bytes are `Buffer.equals`-identical — the
    // hash proves it at the granularity the acceptance criterion names, and the direct byte
    // comparison proves there is no hash collision papering over a real difference.
    let filesCompared = 0;
    for (const [relativePath, sourceBytes] of Object.entries(files)) {
      const exportedBytes = await readFile(path.join(exportedDir, ...relativePath.split('/')));
      expect(sha256(exportedBytes), `${relativePath}: SHA-256 mismatch`).toBe(sha256(sourceBytes));
      expect(exportedBytes, `${relativePath}: bytes differ`).toEqual(sourceBytes);
      filesCompared += 1;
    }
    expect(filesCompared).toBe(3); // a vacuous loop would pass every assertion above (ADR-0015)

    // And the reverse direction: no file exists in the exported tree that was not in the source.
    expect(exportedBody.skill.files.map((f) => f.path).sort()).toEqual(Object.keys(files).sort());
  });

  it('exporting twice in a row produces identical bytes both times (the guard is a filter, not a rewriter, one level up)', async () => {
    const bytes = Buffer.from('content with a trailing newline\n', 'utf8');
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'stable-export',
        files: [{ path: 'SKILL.md', contentBase64: bytes.toString('base64') }],
      }),
    );
    const first = await detailRoute(
      req('GET', '/api/skills/stable-export?export=true', { workspace: WORKSPACE_A }),
      nameContext('stable-export'),
    );
    const second = await detailRoute(
      req('GET', '/api/skills/stable-export?export=true', { workspace: WORKSPACE_A }),
      nameContext('stable-export'),
    );
    expect(await first.json()).toEqual(await second.json());
  });
});

/**
 * Verification round 2, finding 1: `ownershipOfName` (`apps/web/app/api/skills/[name]/route.ts`)
 * compares a skill's catalog `created_by` against the caller, but every test above runs as an
 * Owner, whose grant on `skills` is `any` (`permissions.ts`) — wide enough that `decide()` never
 * even looks at what `ownershipOfName` answered. This suite drives the same route as a Builder,
 * whose grant is `own`, so the comparison is the thing standing between the two Builders below.
 * See `apps/web/server/files/routes.test.ts`'s sibling suite for why this needs a real
 * `TEST_DATABASE_URL` and `describe.skipIf`s rather than `.skip`s without one.
 */
describe.skipIf(!hasDatabase)(
  'own/other ownership on GET/PATCH /api/skills/:name (issue #117, PostgreSQL-backed)',
  () => {
    let isolated: IsolatedTestDatabase;
    let root: DatabaseRoot;
    let dbRootDir: string;
    const workspace = {
      id: crypto.randomUUID(),
      slug: 'w9-117-skills-ownership',
      name: 'Skills ownership',
    };
    const builderA = {
      id: crypto.randomUUID(),
      email: 'builder-a@example.test',
      name: 'Builder A',
    };
    const builderB = {
      id: crypto.randomUUID(),
      email: 'builder-b@example.test',
      name: 'Builder B',
    };
    const apiKeyAId = '984a27be-a7ee-4d15-9aed-d54389b8c007';
    const apiKeyBId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const principalAId = 'cba4eb82-685c-43c2-bbba-65a7f8131e74';
    const principalBId = 'bf63147f-5888-4779-8c7f-8bcedc57e426';

    beforeAll(async () => {
      isolated = await createIsolatedTestDatabase('aw_skills_ownership');
      await isolated.db.insert(workspaces).values(workspace);
      await isolated.db.insert(users).values([builderA, builderB]);
      await isolated.db.insert(memberships).values([
        { workspaceId: workspace.id, userId: builderA.id, role: 'builder' },
        { workspaceId: workspace.id, userId: builderB.id, role: 'builder' },
      ]);
      await isolated.db.transaction(async (tx) => {
        await tx.insert(apiKeys).values([
          {
            id: apiKeyAId,
            workspaceId: workspace.id,
            name: 'Builder A skill key',
            role: 'builder',
            keyPrefix: 'ak_skill_a',
            keyHash: 'c'.repeat(64),
          },
          {
            id: apiKeyBId,
            workspaceId: workspace.id,
            name: 'Builder B skill key',
            role: 'builder',
            keyPrefix: 'ak_skill_b',
            keyHash: 'd'.repeat(64),
          },
        ]);
        await tx.insert(workspacePrincipals).values([
          {
            id: principalAId,
            workspaceId: workspace.id,
            kind: 'api_key',
            apiKeyId: apiKeyAId,
          },
          {
            id: principalBId,
            workspaceId: workspace.id,
            kind: 'api_key',
            apiKeyId: apiKeyBId,
          },
        ]);
      });
      root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    }, 180_000);

    afterAll(async () => {
      await root.close();
      await isolated.close();
    });

    beforeEach(async () => {
      dbRootDir = await mkdtemp(path.join(os.tmpdir(), 'w9-auth-117-skills-ownership-'));
      configureSkillsRuntime({
        store: createRepositorySkillsStoreProvider({
          store: createLocalFilesystemObjectStoreProvider(dbRootDir),
          scopes: root.scopes,
        }),
        catalog: createResourceCatalogStoreProvider({
          repositories: root.resourceCatalogs,
          scopes: root.scopes,
        }),
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          return Promise.resolve(
            workspaceId === null
              ? { kind: 'unauthenticated', reason: 'no test workspace header' }
              : { kind: 'workspace', workspaceId },
          );
        },
      });
      configureRbacRuntime({
        directory: createPostgresDirectory(root.directory),
        identify(request: Request) {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          const actor = request.headers.get(ACTOR_HEADER);
          return Promise.resolve(
            workspaceId === null || actor === null
              ? null
              : Principal.fromApiKey({
                  principalId: actor === builderA.email ? principalAId : principalBId,
                  apiKeyId: actor === builderA.email ? apiKeyAId : apiKeyBId,
                  workspaceId,
                  role: 'builder',
                  label: actor === builderA.email ? 'Builder A skill key' : 'Builder B skill key',
                }),
          );
        },
      });
    });

    afterEach(async () => {
      clearSkillsRuntime();
      clearRbacRuntime();
      await rm(dbRootDir, { recursive: true, force: true });
    });

    it('a Builder may read and edit the skill it imported, and no other Builder may (issue #117)', async () => {
      const imported = await importRoute(
        req('POST', '/api/skills', {
          workspace: workspace.id,
          body: JSON.stringify({
            name: 'shared',
            files: [
              {
                path: 'SKILL.md',
                contentBase64: Buffer.from('---\nname: shared\n---\nbody\n').toString('base64'),
              },
            ],
          }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: builderA.email },
        }),
      );
      expect(imported.status, await imported.clone().text()).toBe(201);

      // Builder's grant on `skills` is `{ read: 'any', write: 'own', run: 'own' }`
      // (`permissions.ts`) — `GET` is readable workspace-wide by design and is not an own/other
      // gate; `PATCH` is the write this task's `ownershipOfName` stands in front of, and it is
      // what this test proves. Both builders can read the same skill first, so the denial below
      // is provably about `PATCH`, not a workspace mismatch.
      const readByOther = await detailRoute(
        req('GET', '/api/skills/shared', {
          workspace: workspace.id,
          headers: { [ACTOR_HEADER]: builderB.email },
        }),
        nameContext('shared'),
      );
      expect(readByOther.status, await readByOther.clone().text()).toBe(200);

      // Builder B did not create this row: `own` is denied, and `decide()` never sees a role wide
      // enough to substitute for it (Builder's write grant on skills is `own`, not `any`).
      const deniedPatch = await patchRoute(
        req('PATCH', '/api/skills/shared', {
          workspace: workspace.id,
          body: JSON.stringify({ enabled: false }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: builderB.email },
        }),
        nameContext('shared'),
      );
      expect(deniedPatch.status).toBe(403);

      // Builder A did create it: the same route, the same skill, only the caller differs.
      const allowedPatch = await patchRoute(
        req('PATCH', '/api/skills/shared', {
          workspace: workspace.id,
          body: JSON.stringify({ enabled: false }),
          contentType: 'application/json',
          headers: { [ACTOR_HEADER]: builderA.email },
        }),
        nameContext('shared'),
      );
      expect(allowedPatch.status, await allowedPatch.clone().text()).toBe(200);
    });
  },
);
