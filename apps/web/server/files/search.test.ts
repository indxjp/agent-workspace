import { createHash } from 'node:crypto';
import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import {
  bytesToStream,
  createInMemoryObjectStore,
  createInMemoryObjectStoreProvider,
  storageObjectName,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { FileSearchResponseSchema } from '@indx-workspace/contracts/files';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GET as downloadRoute } from '../../app/api/files/[id]/route';
import { GET as searchRoute } from '../../app/api/files/search/route';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import { buildRunRequestFor } from '../compose/run-request';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { recordRunFileGrants } from '../composition/wiring/run-launcher';
import type { RunTokenIssuer } from '../gateway/issuer';
import { createMemoryDirectory } from '../rbac/memory-directory';
import { Principal } from '../rbac/principal';
import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { InMemoryRunStore } from '../runs/memory-store';
import {
  createResourceCatalogStoreProvider,
  type ResourceCatalogStoreProvider,
} from '../resources/catalog-store';
import { createStorageService, type StorageContext, type StorageService } from '../storage/service';
import { EXTRACT_MAX_FILE_BYTES } from './extract';
import { encodeFileId } from './file-id';
import { searchFiles } from './search';
import { createRepositoryObjectStoreProvider, type FileTextStore } from './store';
import type { CatalogFile } from '../storage/store';
import { seedCatalogFile } from '@agent-workspace/core/db';
import { listCatalogFiles } from '@agent-workspace/core/db';

/** The SHA-256 of no bytes, built at runtime: a reference whose content is never read here. */
const EMPTY_SHA256 = createHash('sha256').digest('hex');

interface FakeFile {
  id: string;
  path: string;
  contentType: string | null;
  body: string;
  version: number;
}

const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999';
const OWNER_ID = '88888888-8888-4888-8888-888888888888';

/** A texts port over plain arrays: a hit is a passage holding every quoted term of the query. */
async function fixture(files: FakeFile[]) {
  const store = createInMemoryObjectStore();
  const catalog = createInMemoryCatalogStore().forWorkspaceSync(WORKSPACE_ID);
  for (const file of files) {
    const row = await seedCatalogFile(catalog, {
      path: file.path,
      kind: 'file',
      sizeBytes: file.body.length,
      contentType: file.contentType,
      ownerPrincipalId: OWNER_ID,
    });
    file.id = row.id;
  }
  const cached = new Map<
    string,
    { version: number; passages: { page: number | null; text: string; terms: string }[] }
  >();
  const texts: FileTextStore = {
    listStale: () =>
      Promise.resolve(
        files
          .filter((file) => cached.get(file.path)?.version !== file.version)
          .map((file) => ({
            id: file.id,
            path: file.path,
            storageKey: file.path,
            contentType: file.contentType,
            sizeBytes: file.body.length,
            updatedAt: String(file.version),
          })),
      ),
    replace: (fileId, source, passages) => {
      const path = files.find((file) => file.id === fileId)?.path;
      if (path === undefined) throw new Error(`replace called with an unseeded id ${fileId}`);
      cached.set(path, { version: Number(source.updatedAt), passages: [...passages] });
      return Promise.resolve(true);
    },
    search: (tsquery, limit, allowed) => {
      const wanted = [...tsquery.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
      const hits = files.flatMap((file) =>
        allowed !== null && !allowed.includes(file.id)
          ? []
          : (cached.get(file.path)?.passages ?? [])
              .filter(
                (p) => p.terms !== '' && wanted.every((term) => p.terms.split(' ').includes(term)),
              )
              .map((p) => ({
                fileId: file.id,
                path: file.path,
                page: p.page,
                text: p.text,
                score: 0.5,
              })),
      );
      return Promise.resolve(hits.slice(0, limit));
    },
  };
  const put = async () => {
    for (const file of files) {
      await store.write(file.path, Buffer.from(file.body), { contentType: file.contentType });
    }
  };
  // The fixture writes each file at its path; a row's own key names an object nobody wrote.
  const open = (row: CatalogFile) => store.read(row.path);
  return { open, texts, put, catalog, cached };
}

const file = (path: string, body: string, contentType: string | null = 'text/plain'): FakeFile => ({
  id: '',
  path,
  contentType,
  body,
  version: 1,
});

describe('searchFiles', () => {
  it('extracts on demand, finds Japanese text, and does not extract again', async () => {
    const files = [file('manuals/pump.txt', '保守手順書 第3章')];
    const { open, texts, put, catalog } = await fixture(files);
    await put();
    const first = await searchFiles(
      { open, texts, catalog },
      { query: '手順', limit: 10, grants: null },
    );
    expect(first?.hits.map((hit) => hit.path)).toEqual(['manuals/pump.txt']);
    expect(first?.hits[0]?.snippet).toContain('手順');
    expect(first?.pending).toBe(0);
    expect(await texts.listStale()).toEqual([]);
  });

  it('answers null for a query with no searchable term', async () => {
    const { open, texts, catalog } = await fixture([]);
    await expect(
      searchFiles({ open, texts, catalog }, { query: '&|!', limit: 10, grants: null }),
    ).resolves.toBeNull();
  });

  it('declares what the budget left undone, and a retry converges', async () => {
    const files = [file('a.txt', 'pump'), file('b.txt', 'pump'), file('c.txt', 'pump')];
    const { open, texts, put, catalog } = await fixture(files);
    await put();
    const run = () =>
      searchFiles({ open, texts, catalog, budget: 2 }, { query: 'pump', limit: 10, grants: null });
    expect((await run())?.pending).toBe(1);
    const second = await run();
    expect(second?.pending).toBe(0);
    expect(second?.hits).toHaveLength(3);
  });

  it('extracts again when a file changes', async () => {
    const files = [file('a.txt', 'alpha')];
    const { open, texts, put, catalog } = await fixture(files);
    await put();
    const deps = { open, texts, catalog };
    await searchFiles(deps, { query: 'alpha', limit: 10, grants: null });
    const changed = files[0];
    if (changed === undefined) throw new Error('unreachable');
    changed.body = 'bravo';
    changed.version = 2;
    await put();
    expect(
      (await searchFiles(deps, { query: 'bravo', limit: 10, grants: null }))?.hits,
    ).toHaveLength(1);
    expect(
      (await searchFiles(deps, { query: 'alpha', limit: 10, grants: null }))?.hits,
    ).toHaveLength(0);
  });

  it('records a marker for an unsupported or unparseable file and never retries it', async () => {
    const files = [
      file('photo.png', 'x', 'image/png'),
      file('broken.pdf', 'not a pdf', 'application/pdf'),
    ];
    const { open, texts, put, catalog, cached } = await fixture(files);
    await put();
    const result = await searchFiles(
      { open, texts, catalog },
      { query: 'x', limit: 10, grants: null },
    );
    expect(result).toEqual({ hits: [], pending: 0 });
    expect(cached.get('photo.png')?.passages).toEqual([{ page: null, text: '', terms: '' }]);
    expect(cached.get('broken.pdf')?.passages).toEqual([{ page: null, text: '', terms: '' }]);
    expect(await texts.listStale()).toEqual([]);
  });

  it('restricts a run to its granted folders, and extracts only those', async () => {
    const files = [file('manuals/a.txt', 'pump'), file('hr/b.txt', 'pump')];
    const { open, texts, put, catalog, cached } = await fixture(files);
    await put();
    const result = await searchFiles(
      { open, texts, catalog },
      { query: 'pump', limit: 10, grants: ['manuals'] },
    );
    expect(result?.hits.map((hit) => hit.path)).toEqual(['manuals/a.txt']);
    expect(cached.has('hr/b.txt')).toBe(false);
  });

  describe('.attachments/ (surface visitors’ uploads, issue #1575)', () => {
    const SID = '44444444-4444-4444-8444-444444444444';
    const scan = `.attachments/${SID}/u1/scan.txt`;
    const query = { query: 'zebracorn', limit: 10 };

    it('never extracts or returns a reserved file in a whole-workspace search', async () => {
      const { open, texts, put, catalog, cached } = await fixture([
        file(scan, 'zebracorn invoice'),
        file(`.ATTACHMENTS/${SID}/u2/other.txt`, 'zebracorn receipt'),
      ]);
      await put();
      const result = await searchFiles({ open, texts, catalog }, { ...query, grants: null });
      expect(result?.hits).toEqual([]);
      expect(cached.size).toBe(0);
    });

    it('still finds the same word in an ordinary file', async () => {
      const { open, texts, put, catalog } = await fixture([
        file(scan, 'zebracorn invoice'),
        file('notes/zoo.txt', 'zebracorn sighting'),
      ]);
      await put();
      const result = await searchFiles({ open, texts, catalog }, { ...query, grants: null });
      expect(result?.hits.map((hit) => hit.path)).toEqual(['notes/zoo.txt']);
    });

    it('lets a run search the attachment its grants name', async () => {
      const { open, texts, put, catalog } = await fixture([
        file(scan, 'zebracorn invoice'),
        file(`.attachments/${SID}/u2/other.txt`, 'zebracorn receipt'),
      ]);
      await put();
      const result = await searchFiles({ open, texts, catalog }, { ...query, grants: [scan] });
      expect(result?.hits.map((hit) => hit.path)).toEqual([scan]);
    });
  });
});

describe('a run started with a fileScope (issue #1539)', () => {
  const WORKSPACE = '22222222-2222-4222-8222-222222222222';
  const OWNER = {
    principalId: '77777777-7777-4777-8777-777777777777',
    userId: '66666666-6666-4666-8666-666666666666',
  };
  const ALL_ON = {
    readFiles: true,
    writeFiles: true,
    runCommands: true,
    unrestrictedNetwork: true,
  };
  const gateway: RunTokenIssuer = {
    baseUrl: 'http://gateway:4000',
    issue: () => Promise.resolve('run-token'),
  };
  const grantedFile = (path: string) => ({
    kind: 'file' as const,
    path,
    access: 'read' as const,
    size: 0,
    sha256: EMPTY_SHA256,
  });

  /** Compose the run, record its snapshot as the launcher does, and search under that snapshot. */
  async function searchAsRun(fileScope: readonly string[] | undefined) {
    const agents = createInMemoryAgentStoreProvider();
    const created = await agents.forWorkspace(WORKSPACE).create(
      {
        name: 'General',
        instructions: '',
        modelConnectionId: '77777777-7777-4777-8777-777777777777',
        model: null,
        permissions: ALL_ON,
      },
      OWNER,
    );
    if (created.kind !== 'created') throw new Error(created.kind);
    const run = await new InMemoryRunStore().create({
      engine: 'claude-agent-sdk',
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: WORKSPACE,
      agentId: created.agent.id,
      sessionId: '44444444-4444-4444-8444-444444444444',
    });
    const request = await buildRunRequestFor(
      {
        run,
        agent: { id: created.agent.id, workspaceId: WORKSPACE, engine: 'claude-agent-sdk' },
        session: { id: run.sessionId, agentId: created.agent.id, engine: null },
        principal: {
          principalId: OWNER.principalId,
          ownerPrincipalId: OWNER.principalId,
          userId: OWNER.userId,
          workspaceId: WORKSPACE,
          scope: null,
        },
        prompt: 'find the pump',
        ...(fileScope === undefined ? {} : { fileScope }),
      },
      {
        agent: created.agent,
        assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: [] },
        toolBundles: [],
        subagents: [],
      },
      { runnerUrl: 'http://runner:8080', workspaceRoot: '/workspace' },
      gateway,
      {},
      ALL_ON,
      null,
      {
        load: () =>
          Promise.resolve({
            files: [
              { kind: 'directory' as const, path: 'docs', access: 'read' as const },
              grantedFile('docs/alice/a.md'),
              grantedFile('docs/bob/b.md'),
            ],
            skills: [],
            mcpServers: {},
          }),
      },
    );

    let snapshot: readonly string[] = [];
    await recordRunFileGrants(
      {
        snapshotFileGrants: (_runId, paths) => {
          snapshot = paths;
          return Promise.resolve(true);
        },
      },
      run.id,
      request.resources?.files ?? [],
    );

    const files = [
      file('docs/alice/a.md', 'pump seal for alice'),
      file('docs/bob/b.md', 'pump seal for bob'),
    ];
    const { open, texts, put, catalog } = await fixture(files);
    await put();
    const result = await searchFiles(
      { open, texts, catalog },
      { query: 'pump', limit: 10, grants: snapshot },
    );
    return { snapshot, hits: result?.hits ?? [] };
  }

  it('searches only the narrowed set: no path and no snippet comes from outside it', async () => {
    const { snapshot, hits } = await searchAsRun(['docs/alice']);
    expect(snapshot).toEqual(['docs/alice/a.md']);
    expect(hits.map((hit) => hit.path)).toEqual(['docs/alice/a.md']);
    expect(JSON.stringify(hits)).not.toMatch(/bob/u);
  });

  it('searches every granted file when the run has no scope', async () => {
    const { snapshot, hits } = await searchAsRun(undefined);
    expect(snapshot).toEqual(['docs']);
    expect(hits.map((hit) => hit.path).sort()).toEqual(['docs/alice/a.md', 'docs/bob/b.md']);
  });
});

interface Member {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
}

interface World {
  readonly catalogs: ResourceCatalogStoreProvider;
  readonly scopes: WorkspaceScopeResolver;
  readonly a: Member;
  readonly b: Member;
}

const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function memoryWorld(): Promise<World> {
  const a = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  const b = { workspaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), userId: null };
  return Promise.resolve({
    catalogs: createInMemoryCatalogStore(),
    scopes: createInMemoryWorkspaceScopeResolver([
      { id: a.workspaceId, slug: 'acme' },
      { id: b.workspaceId, slug: 'globex' },
    ]),
    a,
    b,
  });
}

let isolated: IsolatedTestDatabase | undefined;

async function postgresMember(db: IsolatedTestDatabase['db']): Promise<Member> {
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'files' });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Member' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  return { workspaceId, principalId, userId };
}

async function postgresWorld(): Promise<World> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const scopes = createDatabaseWorkspaceScopeResolver(isolated.db);
  return {
    catalogs: createResourceCatalogStoreProvider({
      repositories: createDatabaseResourceCatalogRepositoryProvider(isolated.db),
      scopes,
    }),
    scopes,
    a: await postgresMember(isolated.db),
    b: await postgresMember(isolated.db),
  };
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL']?.trim();
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set; run this suite through `pnpm test`.');
  }
  isolated = await createIsolatedTestDatabase('aw_files_search');
}, 180_000);

afterAll(async () => isolated?.close());

const ctxOf = (member: Member): StorageContext => ({
  workspaceId: member.workspaceId,
  principalId: member.principalId,
  userId: member.userId,
});

/** A ready row whose recorded size is `claimedSize`, whatever its object holds. */
async function saveClaimedRow(
  world: World,
  objects: ObjectStore,
  path: string,
  body: Uint8Array,
  claimedSize: number,
) {
  const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
  const objectId = crypto.randomUUID();
  const reserved = await catalog.reserve(path, {
    objectId,
    ownerPrincipalId: world.a.principalId,
    sizeBytes: claimedSize,
    contentType: 'text/plain',
  });
  await objects.write(storageObjectName(world.a.workspaceId, 'files', objectId), body, {});
  const confirmed = await catalog.confirm(reserved.row, {
    sizeBytes: claimedSize,
    contentType: 'text/plain',
  });
  if (confirmed === null) throw new Error('the row did not confirm');
  return confirmed.row;
}

afterEach(() => {
  clearApplicationContext();
});

const ACTOR_HEADER = 'x-test-actor';

/** A texts port over the catalog's ready files, as the database repository is: a hit needs the whole word. */
function catalogTexts(
  world: World,
  workspaceId: string,
  cache: Map<string, string>,
): FileTextStore {
  const ready = async () =>
    (await listCatalogFiles(await world.catalogs.forWorkspace(workspaceId))).filter(
      (row) => row.kind === 'file',
    );
  return {
    listStale: async () =>
      (await ready())
        .filter((row) => !cache.has(row.id))
        .map((row) => ({
          id: row.id,
          path: row.path,
          storageKey: row.storageKey ?? row.path,
          contentType: row.contentType,
          sizeBytes: row.sizeBytes,
          updatedAt: '1',
        })),
    replace: (fileId, _source, passages) => {
      cache.set(fileId, passages.map((passage) => passage.terms).join(' '));
      return Promise.resolve(true);
    },
    search: async (tsquery, _limit, allowed) => {
      const wanted = [...tsquery.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
      return (await ready()).flatMap((row) =>
        (allowed === null || allowed.includes(row.id)) &&
        wanted.every((term) => (cache.get(row.id) ?? '').split(' ').includes(term))
          ? [{ fileId: row.id, path: row.path, page: null, text: 'found', score: 0.5 }]
          : [],
      );
    },
  };
}

function defineCatalogSuite(name: string, setup: () => Promise<World>) {
  describe(`search through the catalog service on the ${name}`, () => {
    let world: World;
    let storage: StorageService;
    const legacy = createInMemoryObjectStoreProvider();
    const caches = new Map<string, Map<string, string>>();
    let objects: ObjectStore;

    function install(): void {
      objects = createInMemoryObjectStore();
      storage = createStorageService({
        catalog: (workspaceId) => world.catalogs.forWorkspace(workspaceId),
        objects,
        log: noLog,
      });
      const principals = new Map([
        ['a', world.a],
        ['b', world.b],
      ]);
      installTestDomains({
        files: {
          kind: 'serving',
          runtime: {
            store: createRepositoryObjectStoreProvider({ store: legacy, scopes: world.scopes }),
            catalog: world.catalogs,
            storage,
            texts: {
              forWorkspace: (workspaceId) => {
                const cache = caches.get(workspaceId) ?? new Map<string, string>();
                caches.set(workspaceId, cache);
                return Promise.resolve(catalogTexts(world, workspaceId, cache));
              },
            },
            resolveWorkspace: () =>
              Promise.resolve({ kind: 'workspace', workspaceId: world.a.workspaceId }),
          },
        },
        rbac: {
          directory: createMemoryDirectory({
            users: [world.a, world.b].map((member) => ({
              email: `owner-${member.workspaceId}@example.test`,
              name: 'Owner',
              workspaceId: member.workspaceId,
              role: 'owner' as const,
            })),
          }),
          identify: (request: Request) => {
            const member = principals.get(request.headers.get(ACTOR_HEADER) ?? 'a');
            return Promise.resolve(
              member === undefined
                ? null
                : Principal.fromApiKey({
                    principalId: member.principalId,
                    apiKeyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    workspaceId: member.workspaceId,
                    role: 'owner',
                    label: 'Search test key',
                  }),
            );
          },
        },
      });
    }

    beforeEach(async () => {
      world = await setup();
      caches.clear();
      install();
    });

    async function save(path: string, text: string, area: 'files' | 'skills' = 'files') {
      const saved = await storage.save(ctxOf(world.a), {
        area,
        path,
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(bytesOf(text)),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      return saved.row;
    }

    async function hitPaths(actor: 'a' | 'b', word: string): Promise<string[]> {
      const response = await searchRoute(
        new Request(`https://example.invalid/api/files/search?q=${word}`, {
          headers: { [ACTOR_HEADER]: actor },
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return FileSearchResponseSchema.parse(await response.json()).hits.map((hit) => hit.path);
    }

    const downloadStatus = async (actor: 'a' | 'b', path: string): Promise<number> =>
      (
        await downloadRoute(
          new Request(`https://example.invalid/api/files/${encodeFileId(path)}`, {
            headers: { [ACTOR_HEADER]: actor },
          }),
          { params: Promise.resolve({ id: encodeFileId(path) }) },
        )
      ).status;

    // @story US-STO-01
    it('[US-STO-01][api][sdk] search finds a file saved under the new naming', async () => {
      const row = await save('reports/q3.txt', 'quarter zebracorn');
      expect(row.objectId).not.toBeNull();

      expect(await hitPaths('a', 'zebracorn')).toEqual(['reports/q3.txt']);
      expect(await hitPaths('b', 'zebracorn')).toEqual([]);
      expect(await downloadStatus('b', 'reports/q3.txt')).toBe(404);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] search finds Japanese text by a word inside it, and a Japanese word it lacks finds nothing', async () => {
      await save('manuals/pump.txt', '保守手順書 第3章');

      expect(await hitPaths('a', encodeURIComponent('手順'))).toEqual(['manuals/pump.txt']);
      expect(await hitPaths('a', encodeURIComponent('第3章'))).toEqual(['manuals/pump.txt']);
      expect(await hitPaths('a', encodeURIComponent('点検ガイド'))).toEqual([]);
      expect(await hitPaths('b', encodeURIComponent('手順'))).toEqual([]);
    });

    // @story US-STO-08
    it('[US-STO-08][api][sdk] search skips a skill row but finds a user file under .skills/', async () => {
      await save('.skills/demo/SKILL.md', 'skill zebracorn', 'skills');
      await save('.skills/notes.txt', 'notes zebracorn');

      expect(await hitPaths('a', 'zebracorn')).toEqual(['.skills/notes.txt']);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] search does not find a pending upload', async () => {
      const catalog = await world.catalogs.forWorkspace(world.a.workspaceId);
      await catalog.reserve('docs/pending.txt', {
        ownerPrincipalId: world.a.principalId,
        sizeBytes: 12,
        contentType: 'text/plain',
        objectId: crypto.randomUUID(),
        area: 'files',
      });

      expect(await hitPaths('a', 'zebracorn')).toEqual([]);
      expect(await downloadStatus('a', 'docs/pending.txt')).toBe(404);
      expect(await downloadStatus('b', 'docs/pending.txt')).toBe(404);
    });

    // @story US-STO-01
    it('[US-STO-01][api][sdk] search reads no more than the extraction cap of an object', async () => {
      // The row claims a small size; the object is larger than the cap and holds the word at its start.
      const oversized = new Uint8Array(EXTRACT_MAX_FILE_BYTES + 1).fill(0x20);
      oversized.set(bytesOf('zebracorn'));
      await saveClaimedRow(world, objects, 'big/claimed-small.txt', oversized, 9);
      await save('big/honest.txt', 'zebracorn');

      expect(await hitPaths('a', 'zebracorn')).toEqual(['big/honest.txt']);
      expect(await hitPaths('b', 'zebracorn')).toEqual([]);
      expect(await downloadStatus('b', 'big/honest.txt')).toBe(404);
    });
  });
}

defineCatalogSuite('in-memory catalog', memoryWorld);
defineCatalogSuite('PostgreSQL catalog', postgresWorld);
