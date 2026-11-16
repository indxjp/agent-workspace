import {
  createInMemoryObjectStore,
  storageObjectName,
  streamToBytes,
} from '@agent-workspace/core/storage';
import { bytesToStream } from '@agent-workspace/runtime/transfer';
import { describe, expect, it, vi } from 'vitest';
import type { LaunchContext } from '../runs/environment';
import { createStorageService, type StorageContext } from '../storage/service';
import { log } from '../telemetry/logger';
import { createAgentRunResourceLoader } from './resource-loader';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';
import {
  context,
  type Fixture,
  members,
  memoryFixture,
  postgresFixture,
  sha256Of,
} from './workspace-lifecycle.test-support';

async function harness(setup: () => Promise<Fixture>, granted: 'reports/q3.txt' | 'nothing') {
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
  const grants = granted === 'nothing' ? [] : [{ fileId: saved.row.id, access: 'read' as const }];
  const load = () => loader.load(f.workspaceId, { files: grants, skillIds: [], connectorIds: [] });
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

function defineInputSuite(name: string, setup: () => Promise<Fixture>) {
  describe(`hydrating run inputs through the storage service on the ${name}`, () => {
    /** A saved file `reports/q3.txt`, and a lifecycle whose agent is granted `granted`. */

    // @story US-STO-06
    it('[US-STO-06][api][run] a granted file reaches the run read-only', () =>
      usSTO06ApiRunGrantedFileReaches(setup));

    // @story US-STO-11
    it('[US-STO-11][api][run] an attached file reaches the run read-only', () =>
      usSTO11ApiRunAttachedFileReaches(setup));

    // @story US-STO-06
    it('[US-STO-06][unit][run] a corrupt object aborts the archive', () =>
      usSTO06UnitRunCorruptObjectAborts(setup));

    // @story US-STO-06
    it('[US-STO-06][unit][run] an object gone before the archive reads it is not reported as corrupt', () =>
      usSTO06UnitRunObjectGoneBefore(setup));
  });
}
defineInputSuite('in-memory catalog', memoryFixture);
defineInputSuite('PostgreSQL catalog', postgresFixture);

async function usSTO06ApiRunGrantedFileReaches(setup: () => Promise<Fixture>) {
  const { f, load, lifecycle, launch } = await harness(setup, 'reports/q3.txt');
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
}

async function usSTO11ApiRunAttachedFileReaches(setup: () => Promise<Fixture>) {
  const { f, saved, lifecycle, launch } = await harness(setup, 'nothing');

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
}

async function usSTO06UnitRunCorruptObjectAborts(setup: () => Promise<Fixture>) {
  const { f, objects, saved, lifecycle, launch } = await harness(setup, 'reports/q3.txt');
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
}

async function usSTO06UnitRunObjectGoneBefore(setup: () => Promise<Fixture>) {
  const { f, objects, saved, lifecycle, launch } = await harness(setup, 'reports/q3.txt');
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
}
