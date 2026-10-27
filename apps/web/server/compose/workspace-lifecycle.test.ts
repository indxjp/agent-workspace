import {
  createDatabaseResourceCatalogRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createInMemoryCatalog,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { ResourceCatalogRepository } from '@agent-workspace/core/db';
import { createHash } from 'node:crypto';

import {
  createInMemoryObjectStore,
  storageObjectName,
  streamToBytes,
  type ObjectStoreV2,
} from '@agent-workspace/core/storage';
import {
  bytesToStream,
  decodeUstar,
  encodeUstar,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createInMemoryCatalogStore } from '../resources/catalog-store.memory';
import { createStorageService, type StorageContext } from '../storage/service';
import { log } from '../telemetry/logger';
import { createAgentRunResourceLoader, type RunFileSource } from './resource-loader';
import type { LaunchContext } from '../runs/environment';
import type { RuntimeLaunchTarget } from './runtime-profile';
import { createRuntimeWorkspaceLifecycle, runOutputKey } from './workspace-lifecycle';

const context = {
  run: { id: 'run-1' },
  agent: { id: 'agent-1', workspaceId: 'workspace-1' },
  session: { id: 'session-1', agentId: 'agent-1' },
  principal: { userId: 'user-1', workspaceId: 'workspace-1' },
  prompt: 'work',
} as LaunchContext;

const NOTHING_GRANTED = () => Promise.resolve({ files: [], skills: [] });

const sha256Of = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A file reference and the in-memory source of its bytes. */
function referenced(path: string, text: string, access: 'read' | 'read-write' = 'read') {
  const source: RunFileSource = {
    objectId: null,
    open: () => Promise.resolve(bytesToStream(Buffer.from(text))),
  };
  return {
    file: {
      kind: 'file' as const,
      path,
      access,
      size: Buffer.byteLength(text),
      sha256: sha256Of(text),
    },
    source: [path, source] as const,
  };
}

/** The archive's members, read whole: these archives are a few bytes. */
async function members(archive: ReadableStream<Uint8Array> | null) {
  return archive === null ? null : decodeUstar(await streamToBytes(archive));
}

const quietLog = { info() {}, warn() {}, error() {}, child: () => quietLog };

/** The catalog service over an in-memory catalog and object store, and a launch owned by `owner-1`. */
function memoryStorage() {
  // The object store names keys by workspace, and only a lowercase UUID is a valid workspace id.
  const workspaceId = '22222222-2222-4222-8222-222222222222';
  const catalog = createInMemoryCatalog().forWorkspace(workspaceId);
  const storage = createStorageService({
    catalog: () => Promise.resolve(catalog),
    objects: createInMemoryObjectStore(),
    log: quietLog,
  });
  const ctx: StorageContext = { workspaceId, principalId: 'owner-1', userId: 'user-1' };
  const launch = {
    ...context,
    principal: { ...context.principal, workspaceId, ownerPrincipalId: 'owner-1' },
  } as LaunchContext;
  return { catalog, storage, ctx, launch };
}

const target = {
  driver: 'docker',
  runnerUrl: 'http://runner',
  workspaceRoot: '/workspace',
  fileTransfer: 'push-archive',
} as RuntimeLaunchTarget;

describe('createRuntimeWorkspaceLifecycle', () => {
  it('hydrates the files the run references, under its cwd, read-only unless granted read-write', async () => {
    const notes = referenced('notes/input.txt', 'hello');
    const draft = referenced('drafts/plan.md', 'plan', 'read-write');
    const skill = referenced('.aw-inbox/skills/triage/SKILL.md', '# triage');
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage: memoryStorage().storage,
      granted: () =>
        Promise.resolve({
          files: [
            notes.file,
            draft.file,
            { kind: 'directory', path: 'output', access: 'read-write' },
          ],
          skills: [
            {
              name: 'triage',
              files: [{ path: 'SKILL.md', size: skill.file.size, sha256: skill.file.sha256 }],
            },
          ],
          sources: new Map([notes.source, draft.source, skill.source]),
        }),
      resources: { load: () => Promise.reject(new Error('no attachment was asked for')) },
    });

    expect(await members(await lifecycle.inputArchive(context))).toMatchObject([
      { path: 'workspace-1/session-1/notes/input.txt', type: 'file', mode: 0o444 },
      { path: 'workspace-1/session-1/drafts/plan.md', type: 'file', mode: 0o644 },
      { path: 'workspace-1/session-1/output', type: 'directory', mode: 0o755 },
      {
        path: 'workspace-1/session-1/.aw-inbox/skills/triage/SKILL.md',
        type: 'file',
        mode: 0o444,
        data: Buffer.from('# triage'),
      },
    ]);
  });

  it('hydrates only the files inside the run fileScope (issue #1539)', async () => {
    const alice = referenced('docs/alice/a.md', 'a');
    const bob = referenced('docs/bob/b.md', 'b');
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage: memoryStorage().storage,
      granted: () =>
        Promise.resolve({
          files: [alice.file, bob.file],
          skills: [],
          sources: new Map([alice.source, bob.source]),
        }),
      resources: { load: () => Promise.reject(new Error('no attachment was asked for')) },
    });

    const archive = await lifecycle.inputArchive({ ...context, fileScope: ['docs/alice'] });
    expect((await members(archive))?.map((entry) => entry.path)).toEqual([
      'workspace-1/session-1/docs/alice/a.md',
    ]);
    expect(await lifecycle.inputArchive({ ...context, fileScope: ['docs/carol'] })).toBeNull();
  });

  it('hydrates attachments read-only under the run cwd, loaded by file id (ADR-0146)', async () => {
    const loads: unknown[] = [];
    const brief = referenced('notes/brief.md', 'brief', 'read-write');
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage: memoryStorage().storage,
      granted: NOTHING_GRANTED,
      resources: {
        load: (_workspaceId, assignments) => {
          loads.push(assignments);
          return Promise.resolve({
            files: [brief.file],
            skills: [],
            sources: new Map([brief.source]),
            mcpServers: {},
          });
        },
      },
    });

    const archive = await lifecycle.inputArchive({
      ...context,
      attachments: [{ fileId: 'file-1', path: 'notes/brief.md', kind: 'file' }],
    });
    expect(await members(archive)).toMatchObject([
      { path: 'workspace-1/session-1/notes/brief.md', type: 'file', mode: 0o444 },
    ]);
    expect(loads).toEqual([
      { files: [{ fileId: 'file-1', access: 'read' }], skillIds: [], connectorIds: [] },
    ]);
  });

  it('refuses files over the run limit in total before reading any of them', async () => {
    const opened: string[] = [];
    const big = (path: string, size: number) => ({
      file: { kind: 'file' as const, path, access: 'read' as const, size, sha256: sha256Of(path) },
      source: [
        path,
        {
          objectId: null,
          open: () => {
            opened.push(path);
            return Promise.resolve(null);
          },
        },
      ] as const,
    });
    const granted = big('big/a.bin', 100 * 1024 * 1024);
    const attached = big('big/b.bin', 29 * 1024 * 1024);
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage: memoryStorage().storage,
      granted: () =>
        Promise.resolve({ files: [granted.file], skills: [], sources: new Map([granted.source]) }),
      resources: {
        load: () =>
          Promise.resolve({
            files: [attached.file],
            skills: [],
            sources: new Map([attached.source]),
            mcpServers: {},
          }),
      },
    });

    // Each alone fits; the grant and the attachment together do not.
    await expect(
      lifecycle.inputArchive({
        ...context,
        attachments: [{ fileId: 'file-1', path: 'big/b.bin', kind: 'file' }],
      }),
    ).rejects.toMatchObject({ code: 'run_files_too_large' });
    expect(opened).toEqual([]);
  });

  // @story US-STO-06
  it('[US-STO-06][unit][run] a fileScope that narrows a grant over the run limit still streams', async () => {
    const small = referenced('kb/small.txt', 'small');
    const huge = { ...referenced('kb/huge.bin', '').file, size: RUN_FILES_MAX_BYTES + 1 };
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage: memoryStorage().storage,
      granted: () =>
        Promise.resolve({
          files: [huge, small.file],
          skills: [],
          sources: new Map([small.source]),
        }),
      resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
    });

    const archive = await lifecycle.inputArchive({ ...context, fileScope: ['kb/small.txt'] });
    expect(await members(archive)).toMatchObject([
      { path: 'workspace-1/session-1/kb/small.txt', type: 'file' },
    ]);
    // Unscoped, the same grant is over the limit.
    await expect(lifecycle.inputArchive(context)).rejects.toMatchObject({
      code: 'run_files_too_large',
    });
  });
});

describe('run delivery through the catalog service', () => {
  const owner = {
    workspaceId: '22222222-2222-4222-8222-222222222222',
    principalId: 'owner-1',
    userId: 'user-1',
  };
  const launch = {
    ...context,
    principal: {
      ...context.principal,
      workspaceId: owner.workspaceId,
      ownerPrincipalId: 'owner-1',
    },
  } as LaunchContext;

  // @story US-STO-06
  // Before the change a run without `storage` fell back to path reads, so no catalog row was needed.
  it('[US-STO-06][api][run] a granted file reaches the run and its promoted output lands as an artifacts row', async () => {
    const catalogs = createInMemoryCatalogStore();
    const storage = createStorageService({
      catalog: (workspaceId) => catalogs.forWorkspace(workspaceId),
      objects: createInMemoryObjectStore(),
      log: quietLog,
    });
    const saved = await storage.save(owner, {
      area: 'files',
      path: 'notes/input.txt',
      body: bytesToStream(Buffer.from('hello')),
      maxBytes: 1024,
      replace: false,
    });
    if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
    const loader = createAgentRunResourceLoader({ catalog: catalogs, storage });
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage,
      granted: () =>
        loader.load(owner.workspaceId, {
          files: [{ fileId: saved.row.id, access: 'read' }],
          skillIds: [],
          connectorIds: [],
        }),
      resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
    });

    expect(await members(await lifecycle.inputArchive(launch))).toMatchObject([
      {
        path: `${owner.workspaceId}/session-1/notes/input.txt`,
        type: 'file',
        mode: 0o444,
        data: Buffer.from('hello'),
      },
    ]);

    await lifecycle.promoteOutputs(
      launch,
      target,
      encodeUstar([
        { path: 'output', type: 'directory', mode: 0o755 },
        { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('done') },
      ]),
    );
    expect(await storage.get(owner, 'files', 'runs/run-1/outputs/output/result.txt')).toMatchObject(
      { area: 'artifacts', sizeBytes: 4 },
    );
  });

  // @story US-STO-06
  // Before the change a loader without `storage` read the granted file by path and never threw.
  it('[US-STO-06][unit][run] a run with assigned files and no catalog service fails loudly', async () => {
    const loader = createAgentRunResourceLoader({ catalog: createInMemoryCatalogStore() });
    await expect(
      loader.load(owner.workspaceId, {
        files: [{ fileId: 'file-1', access: 'read' }],
        skillIds: [],
        connectorIds: [],
      }),
    ).rejects.toThrow('this agent has assigned files, but file storage is not configured');
  });
});

describe('promoting runtime outputs through the catalog service', () => {
  function promoter() {
    const m = memoryStorage();
    const lifecycle = createRuntimeWorkspaceLifecycle({
      storage: m.storage,
      granted: NOTHING_GRANTED,
      resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
    });
    /** Every file row the catalog holds, whatever its area. */
    const paths = async () =>
      (await m.catalog.listFiles()).filter((row) => row.kind === 'file').map((row) => row.path);
    const text = async (path: string) => {
      const row = await m.storage.get(m.ctx, 'files', path);
      const opened = row === null ? null : await m.storage.open(m.ctx, row);
      return opened === null ? null : new TextDecoder().decode(await streamToBytes(opened.body));
    };
    return { ...m, lifecycle, paths, text };
  }

  // @story US-STO-07
  it('[US-STO-07][api][run] validates then promotes outputs into area artifacts and leaves no staging row', async () => {
    const p = promoter();
    await p.lifecycle.promoteOutputs(
      p.launch,
      target,
      encodeUstar([
        { path: 'output', type: 'directory', mode: 0o755 },
        { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('done') },
      ]),
    );

    const path = 'runs/run-1/outputs/output/result.txt';
    expect(await p.storage.get(p.ctx, 'files', path)).toMatchObject({
      area: 'artifacts',
      contentType: 'text/plain',
      sizeBytes: 4,
    });
    expect(await p.text(path)).toBe('done');
    expect(await p.paths()).toEqual([path]);
    expect(await p.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
  });

  // F-05: `GET /api/files` only reads rows, so promotion records each output's row.
  // @story US-STO-07
  it('[US-STO-07][api][run] records a catalog row for every promoted output, owned by the run principal', async () => {
    const p = promoter();
    await p.lifecycle.promoteOutputs(
      p.launch,
      target,
      encodeUstar([
        { path: 'output', type: 'directory', mode: 0o755 },
        { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('done') },
      ]),
    );

    expect(
      await p.storage.get(p.ctx, 'files', 'runs/run-1/outputs/output/result.txt'),
    ).toMatchObject({ ownerPrincipalId: 'owner-1' });
  });

  // Issue #1274: outputs were written at their bare path, so a run overwrote workspace files.
  // @story US-STO-07
  it('[US-STO-07][api][run] never overwrites an existing workspace file and saves only under runs/<runId>/outputs/', async () => {
    const p = promoter();
    const saved = await p.storage.save(p.ctx, {
      area: 'files',
      path: 'output/result.txt',
      body: bytesToStream(Buffer.from('original')),
      maxBytes: 1024,
      replace: true,
    });
    expect(saved.ok).toBe(true);

    await p.lifecycle.promoteOutputs(
      p.launch,
      target,
      encodeUstar([
        { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('agent') },
      ]),
    );

    expect(await p.text('output/result.txt')).toBe('original');
    expect(await p.text('runs/run-1/outputs/output/result.txt')).toBe('agent');
    expect((await p.paths()).sort()).toEqual([
      'output/result.txt',
      'runs/run-1/outputs/output/result.txt',
    ]);
  });

  // @story US-STO-07
  it('[US-STO-07][api][run] strips the requested base directory from every key', async () => {
    const p = promoter();
    await p.lifecycle.promoteOutputs(
      p.launch,
      target,
      encodeUstar([
        { path: 'ws/s1/outputs/a/b.md', type: 'file', mode: 0o644, data: Buffer.from('b') },
      ]),
      { base: 'ws/s1/outputs' },
    );

    expect(await p.paths()).toEqual(['runs/run-1/outputs/a/b.md']);
  });

  // @story US-STO-07
  it('[US-STO-07][api][run] saves nothing when an entry is outside the base', async () => {
    const p = promoter();
    await expect(
      p.lifecycle.promoteOutputs(
        p.launch,
        target,
        encodeUstar([
          { path: 'ws/s1/outputs/ok.md', type: 'file', mode: 0o644, data: Buffer.from('ok') },
          { path: 'ws/s2/outputs/other.md', type: 'file', mode: 0o644, data: Buffer.from('x') },
        ]),
        { base: 'ws/s1/outputs' },
      ),
    ).rejects.toThrow(/outside/u);
    expect(await p.paths()).toEqual([]);
    expect(await p.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
  });

  // FX-4: `50%.txt` is a legal archive member but not a legal object key; refuse before any save.
  // @story US-STO-07
  it('[US-STO-07][api][run] saves nothing when an output name is not a storable object key, naming only its index', async () => {
    const p = promoter();
    const refusal = p.lifecycle.promoteOutputs(
      p.launch,
      target,
      encodeUstar([
        { path: 'ok.txt', type: 'file', mode: 0o644, data: Buffer.from('ok') },
        { path: '50%.txt', type: 'file', mode: 0o644, data: Buffer.from('x') },
      ]),
    );

    await expect(refusal).rejects.toThrow('output entry 1 has a name the object store refuses');
    await expect(refusal).rejects.not.toThrow(/50%/u);
    expect(await p.paths()).toEqual([]);
    expect(await p.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
  });
});

interface Fixture {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string | null;
  readonly catalog: ResourceCatalogRepository;
}

function memoryFixture(): Promise<Fixture> {
  const workspaceId = crypto.randomUUID();
  return Promise.resolve({
    workspaceId,
    principalId: crypto.randomUUID(),
    userId: null,
    catalog: createInMemoryCatalog().forWorkspace(workspaceId),
  });
}

let isolated: IsolatedTestDatabase | undefined;

beforeAll(async () => {
  // Fails loudly when TEST_DATABASE_URL is unset: the PostgreSQL suite below is never skipped.
  isolated = await createIsolatedTestDatabase('aw_workspace_lifecycle');
}, 180_000);

afterAll(async () => isolated?.close());

async function postgresFixture(): Promise<Fixture> {
  if (isolated === undefined) throw new Error('the test database did not start');
  const db = isolated.db;
  const workspaceId = crypto.randomUUID();
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: `s-${workspaceId}`, name: 'outputs' });
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
  await db.transaction(async (tx) => {
    await tx.insert(memberships).values({ id: membershipId, workspaceId, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId, kind: 'membership', membershipId });
  });
  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(workspaceId);
  if (scope === null) throw new Error('catalog scope did not resolve');
  return {
    workspaceId,
    principalId,
    userId,
    catalog: createDatabaseResourceCatalogRepositoryProvider(db).forScope(scope),
  };
}

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`promoting outputs through the storage service on the ${name}`, () => {
    async function harness(failWriteNumber?: number, failRemove = false) {
      const f = await setup();
      const objects = createInMemoryObjectStore();
      let writes = 0;
      const flaky: ObjectStoreV2 = {
        ...objects,
        write: (key, body, options) => {
          writes += 1;
          return writes === failWriteNumber
            ? Promise.reject(new Error('write interrupted'))
            : objects.write(key, body, options);
        },
      };
      const log = { info() {}, warn() {}, error() {}, child: () => log };
      const storage = createStorageService({
        catalog: () => Promise.resolve(f.catalog),
        objects: flaky,
        log,
      });
      const ctx: StorageContext = {
        workspaceId: f.workspaceId,
        principalId: f.principalId,
        userId: f.userId,
      };
      const lifecycle = createRuntimeWorkspaceLifecycle({
        storage: failRemove
          ? { ...storage, remove: () => Promise.reject(new Error('remove refused')) }
          : storage,
        granted: NOTHING_GRANTED,
        resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
      });
      const launch = {
        ...context,
        principal: {
          ...context.principal,
          workspaceId: f.workspaceId,
          userId: f.userId,
          ownerPrincipalId: f.principalId,
        },
      } as LaunchContext;
      /** Every path any listing a tenant or the run's own readers use would show. */
      const visiblePaths = async () => {
        const listed = await storage.list(ctx, 'files', '');
        return {
          folder: (await f.catalog.list('')).rows
            .filter((row) => row.kind === 'file')
            .map((r) => r.path),
          service: listed.rows.map((row) => row.path),
          search: (await f.catalog.listFiles())
            .filter((row) => row.kind === 'file')
            .map((row) => row.path),
        };
      };
      const objectNames = async () =>
        (await objects.listPage('workspaces', { recursive: true })).entries.map((e) => e.key);
      return { f, ctx, storage, lifecycle, launch, visiblePaths, objectNames };
    }
    const NOTHING = { folder: [], service: [], search: [] };

    // @story US-STO-07
    it('[US-STO-07][api][run] a failed promotion leaves nothing visible in any listing', async () => {
      // Write 1 is the staged archive, write 2 the first output, write 3 the second.
      const h = await harness(3);
      const archive = encodeUstar([
        { path: 'a.txt', type: 'file', mode: 0o644, data: Buffer.from('a') },
        { path: 'b.txt', type: 'file', mode: 0o644, data: Buffer.from('b') },
      ]);

      await expect(h.lifecycle.promoteOutputs(h.launch, target, archive)).rejects.toThrow(
        'write interrupted',
      );

      expect(await h.visiblePaths()).toEqual(NOTHING);
      expect(await h.storage.get(h.ctx, 'files', 'runs/run-1/outputs/a.txt')).toBeNull();
      expect(await h.storage.get(h.ctx, 'files', 'runs/run-1/outputs/b.txt')).toBeNull();
    });

    // @story US-STO-07
    it('[US-STO-07][api][run] a failed promotion keeps an output it replaced and removes only what it added', async () => {
      // Writes 1-2 are the first promotion; 3 is its staged archive, 4 the new a.txt, 5 b.txt.
      const h = await harness(5);
      const first = encodeUstar([
        { path: 'a.txt', type: 'file', mode: 0o644, data: Buffer.from('old') },
      ]);
      const second = encodeUstar([
        { path: 'a.txt', type: 'file', mode: 0o644, data: Buffer.from('new') },
        { path: 'b.txt', type: 'file', mode: 0o644, data: Buffer.from('b') },
      ]);
      await h.lifecycle.promoteOutputs(h.launch, target, first);

      await expect(h.lifecycle.promoteOutputs(h.launch, target, second)).rejects.toThrow(
        'write interrupted',
      );

      const row = await h.storage.get(h.ctx, 'files', 'runs/run-1/outputs/a.txt');
      if (row === null) throw new Error('a.txt was rolled back');
      const opened = await h.storage.open(h.ctx, row);
      expect(
        opened === null ? null : new TextDecoder().decode(await streamToBytes(opened.body)),
      ).toBe('new');
      expect(await h.storage.get(h.ctx, 'files', 'runs/run-1/outputs/b.txt')).toBeNull();
      expect(await h.f.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
      expect(await h.objectNames()).toHaveLength(1);
    });

    // @story US-STO-07
    it('[US-STO-07][api][run] a failed cleanup keeps the original error first', async () => {
      const h = await harness(3, true);
      const archive = encodeUstar([
        { path: 'a.txt', type: 'file', mode: 0o644, data: Buffer.from('a') },
        { path: 'b.txt', type: 'file', mode: 0o644, data: Buffer.from('b') },
      ]);

      const failure: unknown = await h.lifecycle.promoteOutputs(h.launch, target, archive).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) return;
      expect(failure.errors[0]).toMatchObject({ message: 'write interrupted' });
      expect(failure.errors[1]).toMatchObject({ message: 'remove refused' });
    });

    // @story US-STO-07
    it('[US-STO-07][api][run] a staged archive over its limit leaves no row or object', async () => {
      const h = await harness();

      await expect(h.storage.stage(h.ctx, bytesToStream(new Uint8Array(8)), 4)).resolves.toEqual({
        ok: false,
        code: 'too_large',
      });

      expect(await h.f.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
      expect(
        (await h.objectNames()).filter((n) =>
          n.startsWith(`workspaces/${h.f.workspaceId}/staging/`),
        ),
      ).toEqual([]);
    });

    // @story US-STO-07
    it('[US-STO-07][api][run] a promoted output renames and removes through area files', async () => {
      const h = await harness();
      const archive = encodeUstar([
        { path: 'report.pdf', type: 'file', mode: 0o644, data: Buffer.from('%PDF') },
      ]);
      await h.lifecycle.promoteOutputs(h.launch, target, archive);

      await expect(
        h.storage.rename(h.ctx, 'files', 'runs/run-1/outputs/report.pdf', 'moved.pdf'),
      ).resolves.toMatchObject({ ok: true });
      await expect(
        h.storage.remove(h.ctx, 'files', 'moved.pdf', { recursive: false }),
      ).resolves.toMatchObject({ ok: true });
      expect(await h.storage.get(h.ctx, 'files', 'moved.pdf')).toBeNull();
    });

    // @story US-STO-07
    it('[US-STO-07][api][run] staging is never listed', async () => {
      const h = await harness();
      const staged = await h.storage.stage(h.ctx, bytesToStream(Buffer.from('archive')), 1024);
      if (!staged.ok) throw new Error('stage refused');
      expect(await h.f.catalog.get(staged.row.path, { includePending: true })).not.toBeNull();

      expect(await h.visiblePaths()).toEqual(NOTHING);
      expect(await h.storage.get(h.ctx, 'files', staged.row.path)).toBeNull();

      // Even a staging row that became ready is ignored by the service, for every area asked.
      const done = await h.f.catalog.confirm(staged.row, { sizeBytes: 7, contentType: null });
      expect(done).not.toBeNull();
      expect((await h.storage.list(h.ctx, 'files', '')).rows).toEqual([]);
      expect((await h.storage.list(h.ctx, 'staging', '')).rows).toEqual([]);
      expect(await h.storage.get(h.ctx, 'staging', staged.row.path)).toBeNull();
      expect(await h.storage.get(h.ctx, 'files', staged.row.path)).toBeNull();
    });

    // @story US-STO-07
    it('[US-STO-07][api][sdk] outputs save into artifacts with their type and list under the run', async () => {
      const h = await harness();
      const archive = encodeUstar([
        { path: 'report.pdf', type: 'file', mode: 0o644, data: Buffer.from('%PDF') },
      ]);

      await h.lifecycle.promoteOutputs(h.launch, target, archive);
      await h.lifecycle.promoteOutputs(h.launch, target, archive);

      const path = 'runs/run-1/outputs/report.pdf';
      const row = await h.storage.get(h.ctx, 'files', path);
      expect(row).toMatchObject({
        area: 'artifacts',
        contentType: 'application/pdf',
        sizeBytes: 4,
      });
      expect(
        (await h.storage.list(h.ctx, 'files', 'runs/run-1/outputs')).rows.map((r) => r.path),
      ).toEqual([path]);
      // The second promotion replaced the file; no staging row or object is left from either.
      const names = await h.objectNames();
      expect(names).toHaveLength(1);
      expect(names[0]).toContain(`workspaces/${h.f.workspaceId}/artifacts/`);
      expect(await h.f.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
    });
  });
}

function defineInputSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`hydrating run inputs through the storage service on the ${name}`, () => {
    /** A saved file `reports/q3.txt`, and a lifecycle whose agent is granted `granted`. */
    async function harness(granted: 'reports/q3.txt' | 'nothing') {
      const f = await setup();
      const objects = createInMemoryObjectStore();
      const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };
      const storage = createStorageService({
        catalog: () => Promise.resolve(f.catalog),
        objects,
        log: noLog,
      });
      const ctx: StorageContext = {
        workspaceId: f.workspaceId,
        principalId: f.principalId,
        userId: f.userId,
      };
      const saved = await storage.save(ctx, {
        area: 'files',
        path: 'reports/q3.txt',
        maxBytes: 1024,
        replace: true,
        body: bytesToStream(Buffer.from('quarterly numbers')),
      });
      if (!saved.ok) throw new Error(`save refused: ${saved.code}`);
      const loader = createAgentRunResourceLoader({
        catalog: { forWorkspace: () => Promise.resolve(f.catalog) },
        storage,
      });
      const grants =
        granted === 'nothing' ? [] : [{ fileId: saved.row.id, access: 'read' as const }];
      const load = () =>
        loader.load(f.workspaceId, { files: grants, skillIds: [], connectorIds: [] });
      const lifecycle = createRuntimeWorkspaceLifecycle({
        storage,
        resources: loader,
        granted: load,
      });
      const launch = {
        ...context,
        principal: { ...context.principal, workspaceId: f.workspaceId },
      } as LaunchContext;
      return { f, objects, saved: saved.row, load, lifecycle, launch };
    }

    // @story US-STO-06
    it('[US-STO-06][api][run] a granted file reaches the run read-only', async () => {
      const { f, load, lifecycle, launch } = await harness('reports/q3.txt');
      // What compose puts into the `/run` body for this grant.
      const [reference] = (await load()).files;

      const archived = await members(await lifecycle.inputArchive(launch));
      // The member sits where the runner checks the `/run` reference: `<cwd>/<reference.path>`.
      expect(archived).toMatchObject([
        { path: `${f.workspaceId}/session-1/reports/q3.txt`, type: 'file', mode: 0o444 },
      ]);
      expect(reference).toEqual({
        kind: 'file',
        path: 'reports/q3.txt',
        access: 'read',
        size: 17,
        sha256: sha256Of(archived?.[0]?.data ?? new Uint8Array()),
      });
    });

    // @story US-STO-11
    it('[US-STO-11][api][run] an attached file reaches the run read-only', async () => {
      const { f, saved, lifecycle, launch } = await harness('nothing');

      const archived = await members(
        await lifecycle.inputArchive({
          ...launch,
          attachments: [{ fileId: saved.id, path: saved.path, kind: 'file' }],
        }),
      );
      expect(archived).toMatchObject([
        {
          path: `${f.workspaceId}/session-1/reports/q3.txt`,
          type: 'file',
          mode: 0o444,
          data: Buffer.from('quarterly numbers'),
        },
      ]);
    });

    // @story US-STO-06
    it('[US-STO-06][unit][run] a corrupt object aborts the archive', async () => {
      const { f, objects, saved, lifecycle, launch } = await harness('reports/q3.txt');
      if (saved.objectId === null || saved.objectId === undefined) {
        throw new Error('the saved row has no object id');
      }
      // Same size, different bytes: only the checksum can tell.
      await objects.write(
        storageObjectName(f.workspaceId, 'files', saved.objectId),
        Buffer.from('QUARTERLY NUMBERS'),
        {},
      );
      const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      try {
        const archive = await lifecycle.inputArchive(launch);
        if (archive === null) throw new Error('the run has no archive');
        await expect(streamToBytes(archive)).rejects.toMatchObject({
          code: 'run_file_corrupt',
          publicMessage: expect.stringMatching(/^run_file_corrupt: /u) as unknown,
        });
        expect(logged).toHaveBeenCalledWith('[runs] a run input does not match its catalog row', {
          runId: 'run-1',
          objectId: saved.objectId,
        });
        expect(JSON.stringify(logged.mock.calls)).not.toContain('QUARTERLY');
      } finally {
        logged.mockRestore();
      }
    });

    // @story US-STO-06
    it('[US-STO-06][unit][run] an object gone before the archive reads it is not reported as corrupt', async () => {
      const { f, objects, saved, lifecycle, launch } = await harness('reports/q3.txt');
      if (saved.objectId === null || saved.objectId === undefined) {
        throw new Error('the saved row has no object id');
      }
      const archive = await lifecycle.inputArchive(launch);
      if (archive === null) throw new Error('the run has no archive');
      // Deleted between loading the references and streaming them: a race, not corruption.
      await objects.delete(storageObjectName(f.workspaceId, 'files', saved.objectId));
      const failure: unknown = await streamToBytes(archive).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toMatchObject({ code: 'run_file_corrupt' });
      expect((failure as Error).message).toBe('a granted file disappeared before the run read it');
    });
  });
}

defineSuite('in-memory catalog', memoryFixture);
defineSuite('PostgreSQL catalog', postgresFixture);
defineInputSuite('in-memory catalog', memoryFixture);
defineInputSuite('PostgreSQL catalog', postgresFixture);

describe('runOutputKey', () => {
  it.each([
    ['run-1', 'report.md', undefined, 'runs/run-1/outputs/report.md'],
    ['run-1', 'a/b/c.txt', undefined, 'runs/run-1/outputs/a/b/c.txt'],
    ['run-1', 'ws/s1/outputs/a.md', 'ws/s1/outputs', 'runs/run-1/outputs/a.md'],
    ['run-1', 'ws/s1/outputs/a.md', 'ws/s1/outputs/', 'runs/run-1/outputs/a.md'],
  ])('maps %s %s (base %s) to %s', (runId, path, base, expected) => {
    expect(runOutputKey(runId, path, base)).toBe(expected);
  });

  it.each([
    ['outside the base', 'ws/s2/outputs/a.md', 'ws/s1/outputs'],
    ['a sibling that only shares the base as a prefix', 'ws/s1/outputs2/a.md', 'ws/s1/outputs'],
    ['the base itself', 'ws/s1/outputs', 'ws/s1/outputs'],
    ['an empty remainder', 'ws/s1/outputs/', 'ws/s1/outputs'],
  ])('refuses %s', (_name, path, base) => {
    expect(() => runOutputKey('run-1', path, base)).toThrow();
  });
});
