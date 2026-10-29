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
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET as listRoute, POST as importRoute } from '../../app/api/skills/route';
import { GET as detailRoute, PATCH as patchRoute } from '../../app/api/skills/[name]/route';
import { POST as publishRoute } from '../../app/api/skills/[name]/revisions/route';
import {
  createInMemoryObjectStore,
  createLocalFilesystemObjectStoreProvider,
} from '@agent-workspace/core/storage';
import { listAll, readWhole } from '@agent-workspace/core/storage/streams';
import { SkillResponseSchema, SkillRevisionResponseSchema } from '@indx-workspace/contracts/skills';
import { skillFileKey, skillMetaKey, skillRevisionRowFolder, skillRowFolder } from './keys';
import type { WorkspaceResolution } from './runtime';
import { createRepositorySkillsStoreProvider } from '../storage/store';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createStorageService, type StorageService } from '../storage/service';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
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

const WORKSPACE_A = '33333333-3333-4333-8333-333333333333';
const WORKSPACE_B = '44444444-4444-4444-8444-444444444444';
const WORKSPACE_HEADER = 'x-test-workspace';
/** issue #117: which seeded member a request authenticates as, in the DB-backed suite below. */
const ACTOR_HEADER = 'x-test-actor';
const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

let rootDir: string;
/** The skills' rows service of the in-memory suite's runtime. */
let skillsService: StorageService;

/** The service a skill's rows are saved through, over the catalogs the runtime holds. */
function skillsStorage(catalogs: ResourceCatalogStoreProvider): StorageService {
  return createStorageService({
    catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
    objects: createInMemoryObjectStore(),
    log: noLog,
  });
}

let catalogs: ReturnType<typeof createInMemoryCatalogStore>;

beforeEach(async () => {
  catalogs = createInMemoryCatalogStore();
  skillsService = skillsStorage(catalogs);
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'w2-cp-04-routes-'));
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: WORKSPACE_A, slug: 'acme' },
    { id: WORKSPACE_B, slug: 'globex' },
  ]);
  const store = createRepositorySkillsStoreProvider({
    store: createLocalFilesystemObjectStoreProvider(rootDir),
    scopes,
  });
  installTestDomains({
    skills: {
      kind: 'serving',
      runtime: {
        store,
        catalog: catalogs,
        storage: skillsService,
        resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
          const workspaceId = request.headers.get(WORKSPACE_HEADER);
          if (workspaceId === null) {
            return Promise.resolve({ kind: 'unauthenticated', reason: 'no test workspace header' });
          }
          return Promise.resolve({ kind: 'workspace', workspaceId });
        },
      },
    },
  });
  installTestDomains({
    rbac: {
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
    },
  });
});

afterEach(async () => {
  clearApplicationContext();
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
    // The role gate lives in the same context, so with none installed it answers first; the skills
    // runtime's own answer is the `unavailable` case below.
    clearApplicationContext(); // this suite's beforeEach already configured one — undo it for this case
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'rbac_runtime_not_configured' },
    });
  });

  it('answers the same 503 when the skills storage is unavailable', async () => {
    installTestDomains({ skills: { kind: 'unavailable' } });
    const response = await listRoute(req('GET', '/api/skills', { workspace: WORKSPACE_A }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
  });
});

/**
 * Issue #1698: a skill is written as `skills` rows or not at all. A runtime without the files
 * catalog service (`storage`) must refuse the write, not fall back to the old bare object prefix.
 */
describe('skills write route and the rows service', () => {
  const importBody = {
    name: 'demo',
    files: [
      { path: 'SKILL.md', contentBase64: Buffer.from('---\nname: demo\n---\n').toString('base64') },
    ],
  };

  // @story US-STO-08
  it('[US-STO-08][api][sdk] POST /api/skills with the rows service answers 201 and saves a skills row', async () => {
    const response = await importRoute(postJson(WORKSPACE_A, importBody));

    expect(response.status, await response.clone().text()).toBe(201);
    const listed = await skillsService.list(
      { workspaceId: WORKSPACE_A },
      'skills',
      skillRowFolder('demo'),
    );
    expect(listed.rows.map((row) => row.path)).toEqual([`${skillRowFolder('demo')}/SKILL.md`]);
    expect(
      await readWhole(
        createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A),
        skillFileKey('demo', 'SKILL.md'),
      ),
    ).toBeNull();
  });

  // @story US-STO-08
  it('[US-STO-08][api][sdk] POST /api/skills without the rows service answers 503 and writes nothing', async () => {
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store: createRepositorySkillsStoreProvider({
            store: createLocalFilesystemObjectStoreProvider(rootDir),
            scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE_A, slug: 'acme' }]),
          }),
          catalog: catalogs,
          // No `storage` — the one difference from the suite's own `beforeEach`.
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
        },
      },
    });

    const response = await importRoute(postJson(WORKSPACE_A, importBody));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'skills_runtime_not_configured' },
    });
    expect(
      await readWhole(
        createLocalFilesystemObjectStoreProvider(rootDir).forWorkspace(WORKSPACE_A),
        skillFileKey('demo', 'SKILL.md'),
      ),
    ).toBeNull();
    expect(await catalogs.forWorkspaceSync(WORKSPACE_A).listSkills()).toEqual([]);
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
    installTestDomains({
      skills: {
        kind: 'serving',
        runtime: {
          store,
          // No `catalog` — this is the one difference from the suite's own `beforeEach`.
          resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE_A }),
        },
      },
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
    await objectStore.write(
      skillMetaKey('broken'),
      new TextEncoder().encode(
        JSON.stringify({ name: 'broken', enabled: true, createdAt: now, updatedAt: now }),
      ),
      { contentType: 'application/json' },
    );
    await objectStore.write(skillFileKey('broken', 'SKILL.md'), Uint8Array.from([0x80]), {
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
    await objectStore.write(
      skillMetaKey('orphan'),
      new TextEncoder().encode(
        JSON.stringify({ name: 'orphan', enabled: true, createdAt: now, updatedAt: now }),
      ),
      { contentType: 'application/json' },
    );

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
    await objectStore.write(
      skillMetaKey('broken'),
      new TextEncoder().encode(
        JSON.stringify({ name: 'broken', enabled: true, createdAt: now, updatedAt: now }),
      ),
      { contentType: 'application/json' },
    );
    // The same lone continuation byte the list test above writes: never valid UTF-8 on its own.
    await objectStore.write(skillFileKey('broken', 'SKILL.md'), Uint8Array.from([0x80]), {
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
    await objectStore.write(
      skillMetaKey('orphan'),
      new TextEncoder().encode(
        JSON.stringify({ name: 'orphan', enabled: true, createdAt: now, updatedAt: now }),
      ),
      { contentType: 'application/json' },
    );

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
    vi.spyOn(catalogs.forWorkspaceSync(WORKSPACE_A), 'putSkill').mockRejectedValueOnce(
      new Error('database blip'),
    );
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
    expect(await listAll(objectStore, 'skills/demo', { recursive: true })).toEqual([]);
    expect(await readWhole(objectStore, skillMetaKey('demo'))).toBeNull();

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

describe('POST /api/skills/:name/revisions (SDK-19, N-1)', () => {
  const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const skillMd = (body: string): string => b64(`---\nname: demo\n---\n${body}\n`);

  function publish(files: unknown, name = 'demo', workspace = WORKSPACE_A): Promise<Response> {
    return publishRoute(
      req('POST', `/api/skills/${name}/revisions`, {
        workspace,
        body: JSON.stringify({ files }),
        contentType: 'application/json',
      }),
      nameContext(name),
    );
  }

  /** The text of every file row of one published revision, by catalog path. */
  async function revisionRows(revision: number): Promise<Record<string, string>> {
    const ctx = { workspaceId: WORKSPACE_A };
    const listed = await skillsService.list(
      ctx,
      'skills',
      skillRevisionRowFolder('demo', revision),
    );
    const out: Record<string, string> = {};
    for (const row of listed.rows) {
      const opened = await skillsService.open(ctx, row);
      if (opened === null) throw new Error(`${row.path} has no bytes`);
      out[row.path] = await new Response(opened.body).text();
    }
    return out;
  }

  async function revisionBytes(revision: number): Promise<string | null> {
    const rows = await revisionRows(revision);
    return rows[`${skillRevisionRowFolder('demo', revision)}/SKILL.md`] ?? null;
  }

  async function importDemo(): Promise<void> {
    const response = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: skillMd('v0') }],
      }),
    );
    expect(response.status).toBe(201);
  }

  it('numbers revisions 1, 2 and lists them newest first on GET', async () => {
    await importDemo();
    const first = await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
    expect(first.status, await first.clone().text()).toBe(201);
    const published = SkillRevisionResponseSchema.safeParse(await first.json());
    expect(published.success, JSON.stringify(published)).toBe(true);
    expect(published.data?.revision).toMatchObject({ number: 1, fileCount: 1 });
    const second = await publish([
      { path: 'SKILL.md', contentBase64: skillMd('v2') },
      { path: 'notes.txt', contentBase64: b64('n') },
    ]);
    expect(((await second.json()) as { revision: { number: number } }).revision.number).toBe(2);

    const detail = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    const parsed = SkillResponseSchema.safeParse(await detail.json());
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);
    const skill = parsed.data?.skill;
    expect(skill?.revisions?.map((r) => [r.number, r.fileCount])).toEqual([
      [2, 2],
      [1, 1],
    ]);
    expect(skill?.files.map((f) => f.path)).toEqual(['SKILL.md', 'notes.txt']);
  });

  it('leaves a published revision unchanged by a later publish, PATCH or disable', async () => {
    await importDemo();
    await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
    await publish([{ path: 'SKILL.md', contentBase64: skillMd('v2') }]);
    const patch = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          files: [{ path: 'SKILL.md', contentBase64: skillMd('patched') }],
          enabled: false,
        }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(patch.status, await patch.clone().text()).toBe(200);

    expect(await revisionBytes(1)).toContain('v1');
    expect(await revisionBytes(2)).toContain('v2');
    expect(await revisionBytes(3)).toBeNull();
  });

  it('cannot be written through import, PATCH or a re-publish: every route leaves the published bytes alone', async () => {
    await importDemo();
    await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
    const reimport = await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [{ path: 'SKILL.md', contentBase64: skillMd('reimported') }],
      }),
    );
    expect(reimport.status).toBe(409);

    // A skill file spelled like a revision key lands inside the skill's own prefix, not the revision's.
    const aimed = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          files: [{ path: 'skill-revisions/demo/1/SKILL.md', contentBase64: skillMd('aimed') }],
        }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(aimed.status, await aimed.clone().text()).toBe(200);
    const nested = await patchRoute(
      req('PATCH', '/api/skills/demo', {
        workspace: WORKSPACE_A,
        body: JSON.stringify({
          files: [{ path: '1/SKILL.md', contentBase64: skillMd('nested') }],
        }),
        contentType: 'application/json',
      }),
      nameContext('demo'),
    );
    expect(nested.status, await nested.clone().text()).toBe(200);

    const second = await publish([{ path: 'SKILL.md', contentBase64: skillMd('v2') }]);
    expect(second.status).toBe(201);
    expect(await revisionBytes(1)).toContain('v1');
    expect(await revisionBytes(2)).toContain('v2');
    // Each revision holds its SKILL.md alone: the files PATCHed in did not land in a revision.
    expect(Object.keys(await revisionRows(1))).toEqual([
      `${skillRevisionRowFolder('demo', 1)}/SKILL.md`,
    ]);
    expect(Object.keys(await revisionRows(2))).toEqual([
      `${skillRevisionRowFolder('demo', 2)}/SKILL.md`,
    ]);
    expect(await revisionRows(3)).toEqual({});
  });

  it('replaces the current content, dropping files the published set does not name', async () => {
    await importRoute(
      postJson(WORKSPACE_A, {
        name: 'demo',
        files: [
          { path: 'SKILL.md', contentBase64: skillMd('v0') },
          { path: 'old.txt', contentBase64: b64('old') },
        ],
      }),
    );
    await publish([{ path: 'SKILL.md', contentBase64: skillMd('v1') }]);
    const detail = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    const body = (await detail.json()) as { skill: { files: { path: string }[] } };
    expect(body.skill.files.map((f) => f.path)).toEqual(['SKILL.md']);
  });

  it('404s an unknown skill and refuses a body with no SKILL.md or bad base64 with 400', async () => {
    expect(
      (await publish([{ path: 'SKILL.md', contentBase64: skillMd('x') }], 'nope')).status,
    ).toBe(404);
    await importDemo();
    expect((await publish([{ path: 'a.txt', contentBase64: b64('a') }])).status).toBe(400);
    expect((await publish([{ path: 'SKILL.md', contentBase64: '***' }])).status).toBe(400);
    expect((await publish('not-an-array')).status).toBe(400);
    const detail = await detailRoute(
      req('GET', '/api/skills/demo', { workspace: WORKSPACE_A }),
      nameContext('demo'),
    );
    const body = (await detail.json()) as { skill: { revisions: unknown[] } };
    expect(body.skill.revisions).toEqual([]);
  });

  it('refuses a body with a key other than files with 400 malformed_body', async () => {
    await importDemo();
    for (const body of [
      { files: [{ path: 'SKILL.md', contentBase64: skillMd('x') }], name: 'other' },
      { files: [{ path: 'SKILL.md', contentBase64: skillMd('x') }], typo: 1 },
      [],
    ]) {
      const response = await publishRoute(
        req('POST', '/api/skills/demo/revisions', {
          workspace: WORKSPACE_A,
          body: JSON.stringify(body),
          contentType: 'application/json',
        }),
        nameContext('demo'),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'malformed_body' } });
    }
    expect(await revisionBytes(1)).toBeNull();
  });

  it("does not publish another workspace's skill", async () => {
    await importDemo();
    const response = await publish(
      [{ path: 'SKILL.md', contentBase64: skillMd('x') }],
      'demo',
      WORKSPACE_B,
    );
    expect(response.status).toBe(404);
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
      const dbCatalogs = createResourceCatalogStoreProvider({
        repositories: root.resourceCatalogs,
        scopes: root.scopes,
      });
      installTestDomains({
        skills: {
          kind: 'serving',
          runtime: {
            store: createRepositorySkillsStoreProvider({
              store: createLocalFilesystemObjectStoreProvider(dbRootDir),
              scopes: root.scopes,
            }),
            catalog: dbCatalogs,
            storage: skillsStorage(dbCatalogs),
            resolveWorkspace(request: Request): Promise<WorkspaceResolution> {
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
        },
      });
    });

    afterEach(async () => {
      clearApplicationContext();
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
