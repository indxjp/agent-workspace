import { listCatalogFiles } from '@agent-workspace/core/db';
import { streamToBytes } from '@agent-workspace/core/storage';
import {
  ArchiveTooLargeError,
  bytesToStream,
  encodeUstar,
  RUN_FILES_MAX_BYTES,
} from '@agent-workspace/runtime/transfer';
import { describe, expect, it } from 'vitest';
import { createRuntimeWorkspaceLifecycle } from './workspace-lifecycle';
import { memoryStorage, NOTHING_GRANTED, target } from './workspace-lifecycle.test-support';

describe('promoting runtime outputs through the catalog service', () => {
  // @story US-STO-07
  it(
    '[US-STO-07][api][run] validates then promotes outputs into area artifacts and leaves no staging row',
    usSTO07ApiRunValidatesThenPromotes,
  );

  // F-05: `GET /api/files` only reads rows, so promotion records each output's row.
  // @story US-STO-07
  it(
    '[US-STO-07][api][run] records a catalog row for every promoted output, owned by the run principal',
    usSTO07ApiRunRecordsCatalogRow,
  );

  // Issue #1274: outputs were written at their bare path, so a run overwrote workspace files.
  // @story US-STO-07
  it(
    '[US-STO-07][api][run] never overwrites an existing workspace file and saves only under runs/<runId>/outputs/',
    usSTO07ApiRunNeverOverwritesExisting,
  );

  // @story US-STO-07
  it(
    '[US-STO-07][api][run] strips the requested base directory from every key',
    usSTO07ApiRunStripsRequestedBase,
  );

  // @story US-STO-07
  it(
    '[US-STO-07][api][run] saves nothing when an entry is outside the base',
    usSTO07ApiRunSavesNothingWhen,
  );

  // FX-4: `50%.txt` is a legal archive member but not a legal object key; refuse before any save.
  // @story US-STO-07
  it(
    '[US-STO-07][api][run] saves nothing when an output name is not a storable object key, naming only its index',
    usSTO07ApiRunSavesNothingWhenCase,
  );

  // #1991 D2: the payload budget is checked before truncation, so a header declaring more than
  // RUN_FILES_MAX_BYTES with no payload fails as too large only while promotion passes the budget.
  it(
    'refuses an archive whose declared payload exceeds the run budget before saving anything',
    refusesArchiveWhoseDeclaredPayloadExceedsRunBudget,
  );
});

function promoter() {
  const m = memoryStorage();
  const lifecycle = createRuntimeWorkspaceLifecycle({
    storage: m.storage,
    granted: NOTHING_GRANTED,
    resources: { load: () => Promise.resolve({ files: [], skills: [], mcpServers: {} }) },
  });
  /** Every file row the catalog holds, whatever its area. */
  const paths = async () =>
    (await listCatalogFiles(m.catalog)).filter((row) => row.kind === 'file').map((row) => row.path);
  const text = async (path: string) => {
    const row = await m.storage.get(m.ctx, 'files', path);
    const opened = row === null ? null : await m.storage.open(m.ctx, row);
    return opened === null ? null : new TextDecoder().decode(await streamToBytes(opened.body));
  };
  return { ...m, lifecycle, paths, text };
}

async function usSTO07ApiRunValidatesThenPromotes() {
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
}

async function usSTO07ApiRunRecordsCatalogRow() {
  const p = promoter();
  await p.lifecycle.promoteOutputs(
    p.launch,
    target,
    encodeUstar([
      { path: 'output', type: 'directory', mode: 0o755 },
      { path: 'output/result.txt', type: 'file', mode: 0o644, data: Buffer.from('done') },
    ]),
  );

  expect(await p.storage.get(p.ctx, 'files', 'runs/run-1/outputs/output/result.txt')).toMatchObject(
    { ownerPrincipalId: 'owner-1' },
  );
}

async function usSTO07ApiRunNeverOverwritesExisting() {
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
}

async function usSTO07ApiRunStripsRequestedBase() {
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
}

async function usSTO07ApiRunSavesNothingWhen() {
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
}

async function usSTO07ApiRunSavesNothingWhenCase() {
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
}

async function refusesArchiveWhoseDeclaredPayloadExceedsRunBudget() {
  const p = promoter();
  const header = Buffer.from(
    encodeUstar([{ path: 'big.bin', type: 'file', mode: 0o644 }]).subarray(0, 512),
  );
  header.write(`${(RUN_FILES_MAX_BYTES + 1).toString(8).padStart(11, '0')}\0`, 124);
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);

  await expect(p.lifecycle.promoteOutputs(p.launch, target, header)).rejects.toBeInstanceOf(
    ArchiveTooLargeError,
  );
  expect(await p.paths()).toEqual([]);
  expect((await p.objects.listPage('workspaces', { recursive: true })).entries).toEqual([]);
}
