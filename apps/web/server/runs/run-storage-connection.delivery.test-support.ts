import { openConnectionStore } from '@agent-workspace/core/storage';
import { RUN_FILES_MAX_BYTES } from '@agent-workspace/runtime/transfer';
import { formatStorageUrl } from '@indx-workspace/contracts/storage-url';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSV, expectRefused, fixture, run } from './run-storage-connection.test-support';
import { registerVersionPinTests } from './run-storage-connection.version-pins.test-support';

describe('a run granted a connection folder', () => {
  it(
    '[US-STO-12][api][run] a file:// connection lists and reads the files already in the folder, read-only',
    usSTO12ApiRunFileConnectionLists,
  );

  it(
    '[US-STO-12][api][run] a local-disk runtime gets the folder extracted on this host, read-only, with no /files request',
    usSTO12ApiRunLocalDiskRuntime,
  );

  it(
    '[US-STO-12][api][run] a file:// file whose name holds a literal % is skipped, not a failed run',
    usSTO12ApiRunFileFileWhose,
  );

  it(
    '[US-STO-12][api][run] a read-write grant on a read-only connection is delivered read-only',
    usSTO12ApiRunReadWriteGrant,
  );

  it(
    '[US-STO-12][api][run] a read grant on a writable connection, to an agent that may write, is delivered 0444',
    usSTO12ApiRunReadGrantWritable,
  );

  it(
    '[US-STO-12][api][run] a read-write grant on a writable connection is delivered writable',
    usSTO12ApiRunReadWriteGrantCase,
  );

  it(
    '[US-STO-12][api][run] a folder over the run limit answers 422 run_files_too_large before the run is queued',
    usSTO12ApiRunFolderOverRun,
  );

  it(
    '[US-STO-12][api][run] a connection that is gone answers 422 run_storage_grant_unavailable before the run is queued',
    usSTO12ApiRunConnectionThatIs,
  );

  it(
    '[US-STO-12][api][run] a bucket that refuses the listing answers 422 run_storage_grant_unavailable before the run is queued',
    usSTO12ApiRunBucketThatRefuses,
  );

  registerVersionPinTests();
});

async function usSTO12ApiRunFileConnectionLists() {
  const { world, runs, started } = await run({ access: 'read', writeAllowed: false });
  const delivered = await runs.delivered(started.id);
  const cwd = `${world.workspaceId}/${started.sessionId}`;

  expect(delivered.files).toEqual([
    { kind: 'directory', path: 'storage/acme-data/reports', access: 'read' },
    {
      kind: 'file',
      path: 'storage/acme-data/reports/2026/q3.csv',
      access: 'read',
      size: Buffer.byteLength(CSV),
      sha256: createHash('sha256').update(CSV).digest('hex'),
    },
  ]);
  const member = delivered.archive.find(
    (entry) => entry.path === `${cwd}/storage/acme-data/reports/2026/q3.csv`,
  );
  expect(member).toMatchObject({ type: 'file', mode: 0o444, data: Buffer.from(CSV) });
  expect(delivered.archive.map((entry) => entry.path).join('\n')).not.toMatch(/other/u);
}

async function usSTO12ApiRunLocalDiskRuntime() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'aw-sto12-local-'));
  try {
    const { world, runs, started } = await run({
      access: 'read',
      writeAllowed: false,
      localDiskRoot: workspaceRoot,
    });
    const delivered = await runs.delivered(started.id);
    const cwd = join(workspaceRoot, world.workspaceId, started.sessionId);
    const onDisk = join(cwd, 'storage', 'acme-data', 'reports', '2026', 'q3.csv');

    // The `/run` body carries the digest the streamed archive reported, as push-archive's does.
    expect(delivered.files).toEqual([
      { kind: 'directory', path: 'storage/acme-data/reports', access: 'read' },
      {
        kind: 'file',
        path: 'storage/acme-data/reports/2026/q3.csv',
        access: 'read',
        size: Buffer.byteLength(CSV),
        sha256: createHash('sha256').update(CSV).digest('hex'),
      },
    ]);
    expect(delivered.archive).toEqual([]);
    expect(await readFile(onDisk, 'utf8')).toBe(CSV);
    if (process.platform !== 'win32') expect((await stat(onDisk)).mode & 0o777).toBe(0o444);
    await expect(stat(join(cwd, 'storage', 'acme-data', 'other'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

async function usSTO12ApiRunFileFileWhose() {
  // A `%` is never decoded in a key, so `50%.csv` cannot be delivered under its own name.
  await writeFile(join(fixture.root, 'reports', '50%.csv'), 'half\n');
  const { runs, started } = await run({ access: 'read', writeAllowed: false });
  const delivered = await runs.delivered(started.id);

  // An array matches only at its own length, so `50%.csv` is not among them.
  expect(delivered.files).toMatchObject([
    { path: 'storage/acme-data/reports' },
    { path: 'storage/acme-data/reports/2026/q3.csv' },
  ]);
}

async function usSTO12ApiRunReadWriteGrant() {
  const { runs, started } = await run({ access: 'read-write', writeAllowed: false });
  const delivered = await runs.delivered(started.id);
  expect(delivered.files).toMatchObject([{ access: 'read' }, { access: 'read' }]);
}

async function usSTO12ApiRunReadGrantWritable() {
  const { world, runs, started } = await run({ access: 'read', writeAllowed: true });
  const delivered = await runs.delivered(started.id);
  const member = delivered.archive.find(
    (entry) =>
      entry.path ===
      `${world.workspaceId}/${started.sessionId}/storage/acme-data/reports/2026/q3.csv`,
  );
  expect(delivered.files).toMatchObject([{ access: 'read' }, { access: 'read' }]);
  expect(member).toMatchObject({ type: 'file', mode: 0o444 });
}

async function usSTO12ApiRunReadWriteGrantCase() {
  const { world, runs, started } = await run({ access: 'read-write', writeAllowed: true });
  const delivered = await runs.delivered(started.id);
  const member = delivered.archive.find(
    (entry) =>
      entry.path ===
      `${world.workspaceId}/${started.sessionId}/storage/acme-data/reports/2026/q3.csv`,
  );
  expect(delivered.files).toMatchObject([{ access: 'read-write' }, { access: 'read-write' }]);
  expect(member).toMatchObject({ type: 'file', mode: 0o644 });
}

async function usSTO12ApiRunFolderOverRun() {
  // A sparse file: the listing reports its size and no byte is read before the refusal.
  await writeFile(join(fixture.root, 'reports', '2026', 'big.bin'), '');
  await truncate(join(fixture.root, 'reports', '2026', 'big.bin'), RUN_FILES_MAX_BYTES + 1);
  await expectRefused({ access: 'read', writeAllowed: false }, 'run_files_too_large');
}

async function usSTO12ApiRunConnectionThatIs() {
  await expectRefused(
    { access: 'read', writeAllowed: false, gone: true },
    'run_storage_grant_unavailable',
  );
}

async function usSTO12ApiRunBucketThatRefuses() {
  // A real S3 connection against a bucket that refuses every request with 403 AccessDenied.
  const server = createServer((_request, response) => {
    response.statusCode = 403;
    response.setHeader('content-type', 'application/xml');
    response.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const url = formatStorageUrl({
      kind: 's3',
      bucket: 'acme-data',
      prefix: '',
      endpoint: `http://bucket-host.invalid:${String(port)}`,
      forcePathStyle: true,
    });
    const credential = {
      provider: 's3',
      accessKeyId: randomBytes(10).toString('hex').toUpperCase(),
      secretAccessKey: randomBytes(20).toString('base64'),
    } as const;
    await expectRefused(
      {
        access: 'read',
        writeAllowed: false,
        open: () =>
          openConnectionStore(url, credential, {
            writable: false,
            fileRoots: [],
            egress: { production: false, allowHosts: [] },
            resolve: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
          }),
      },
      'run_storage_grant_unavailable',
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
