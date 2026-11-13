import { workspaceFolder } from '@agent-workspace/core/storage';
import { listCatalogFiles } from '@agent-workspace/core/db';
import {
  createInMemoryObjectStore,
  streamToBytes,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { bytesToStream, encodeUstar } from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';
import type { LaunchContext } from '../runs/environment';
import { createStorageService, type StorageContext } from '../storage/service';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';
import {
  context,
  memoryFixture,
  NOTHING_GRANTED,
  postgresFixture,
  target,
  type Fixture,
} from './workspace-lifecycle.test-support';

async function harness(
  setup: () => Promise<Fixture>,
  failWriteNumber?: number,
  failRemove = false,
) {
  const f = await setup();
  const objects = createInMemoryObjectStore();
  let writes = 0;
  const flaky: ObjectStore = {
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
      search: (await listCatalogFiles(f.catalog))
        .filter((row) => row.kind === 'file')
        .map((row) => row.path),
    };
  };
  const objectNames = async () =>
    (await objects.listPage('workspaces', { recursive: true })).entries.map((e) => e.key);
  return { f, ctx, storage, lifecycle, launch, visiblePaths, objectNames };
}

const NOTHING = { folder: [], service: [], search: [] };

function defineSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`promoting outputs through the storage service on the ${name}`, () => {
    // @story US-STO-07
    it('[US-STO-07][api][run] a failed promotion leaves nothing visible in any listing', () =>
      usSTO07ApiRunFailedPromotionLeaves(setup));

    // @story US-STO-07
    it('[US-STO-07][api][run] a failed promotion keeps an output it replaced and removes only what it added', () =>
      usSTO07ApiRunFailedPromotionKeeps(setup));

    // @story US-STO-07
    it('[US-STO-07][api][run] a failed cleanup keeps the original error first', () =>
      usSTO07ApiRunFailedCleanupKeeps(setup));

    // @story US-STO-07
    it('[US-STO-07][api][run] a staged archive over its limit leaves no row or object', () =>
      usSTO07ApiRunStagedArchiveOver(setup));

    // @story US-STO-07
    it('[US-STO-07][api][run] a promoted output renames and removes through area files', () =>
      usSTO07ApiRunPromotedOutputRenames(setup));

    // @story US-STO-07
    it('[US-STO-07][api][run] staging is never listed', () => usSTO07ApiRunStagingIsNever(setup));

    // @story US-STO-07
    it('[US-STO-07][api][sdk] outputs save into artifacts with their type and list under the run', () =>
      usSTO07ApiSdkOutputsSaveInto(setup));
  });
}
export function registerOutputContracts(): void {
  defineSuite('in-memory catalog', memoryFixture);
  defineSuite('PostgreSQL catalog', postgresFixture);
}

async function usSTO07ApiRunFailedPromotionLeaves(setup: () => Promise<Fixture>) {
  // Write 1 is the staged archive, write 2 the first output, write 3 the second.
  const h = await harness(setup, 3);
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
}

async function usSTO07ApiRunFailedPromotionKeeps(setup: () => Promise<Fixture>) {
  // Writes 1-2 are the first promotion; 3 is its staged archive, 4 the new a.txt, 5 b.txt.
  const h = await harness(setup, 5);
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
  expect(opened === null ? null : new TextDecoder().decode(await streamToBytes(opened.body))).toBe(
    'new',
  );
  expect(await h.storage.get(h.ctx, 'files', 'runs/run-1/outputs/b.txt')).toBeNull();
  expect(await h.f.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
  expect(await h.objectNames()).toHaveLength(1);
}

async function usSTO07ApiRunFailedCleanupKeeps(setup: () => Promise<Fixture>) {
  const h = await harness(setup, 3, true);
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
}

async function usSTO07ApiRunStagedArchiveOver(setup: () => Promise<Fixture>) {
  const h = await harness(setup);

  await expect(h.storage.stage(h.ctx, bytesToStream(new Uint8Array(8)), 4)).resolves.toEqual({
    ok: false,
    code: 'too_large',
  });

  expect(await h.f.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
  expect(
    (await h.objectNames()).filter((n) =>
      n.startsWith(`${workspaceFolder(h.f.workspaceId)}staging/`),
    ),
  ).toEqual([]);
}

async function usSTO07ApiRunPromotedOutputRenames(setup: () => Promise<Fixture>) {
  const h = await harness(setup);
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
}

async function usSTO07ApiRunStagingIsNever(setup: () => Promise<Fixture>) {
  const h = await harness(setup);
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
}

async function usSTO07ApiSdkOutputsSaveInto(setup: () => Promise<Fixture>) {
  const h = await harness(setup);
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
  expect(names[0]).toContain(`${workspaceFolder(h.f.workspaceId)}artifacts/`);
  expect(await h.f.catalog.stalePending(new Date(Date.now() + 1e9))).toEqual([]);
}
