/**
 * What a completed run saves back to a connected folder (US-STO-12, the storage design, §05):
 * only the new and changed files of a `read-write` grant, only inside the granted prefix, never a
 * delete, every gate read again at that moment, one file's failure leaving the others alone, a
 * deadline that stops between files, and an audit row that holds counts and a reason code only.
 */
// @story US-STO-12
import { createHash, randomBytes } from 'node:crypto';

import {
  ObjectConflictError,
  streamToBytes,
  type ObjectStore,
  type WriteOptions,
} from '@agent-workspace/core/storage';
import { encodeUstar, type TarEntry } from '@agent-workspace/runtime/transfer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureLog } from '../telemetry/capture-log';
import { log } from '../telemetry/logger';
import {
  STORAGE_WRITEBACK_AUDIT_DEADLINE_MS,
  STORAGE_WRITEBACK_STATUS_INTERVAL_MS,
  writeBackLabel,
  writeBackStorage,
  type StorageWriteBackAuditEvent,
} from './storage-writeback';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const CWD = `${WORKSPACE}/session-1`;
const FOLDER = `${CWD}/storage/acme-data/reports`;
const BLOCK = 512;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

interface Grant {
  readonly connectionId: string;
  readonly prefix: string;
  readonly access: 'read' | 'read-write';
}

/** One connection's row as the write-back reads it at the end of the run. */
interface Connection {
  readonly name: string;
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed: boolean;
}

interface BucketSeams {
  readonly failWrite?: (key: string) => Error | undefined;
  /** A read the store cannot answer, such as one into a bucket deleted during the run. */
  readonly failRead?: (key: string) => Error | undefined;
  /** Runs as a write starts: what another writer does between the hash check and the write. */
  readonly beforeWrite?: (key: string, objects: Map<string, string>) => void;
  /** Runs once the write has read its body's first chunk: another writer racing the upload. */
  readonly duringWrite?: (key: string, objects: Map<string, string>) => void;
  /** A write that never settles: a hung store. */
  readonly hangWrite?: boolean;
}

/** A bucket that keeps text by key, records every write it is asked for, and honours preconditions. */
function bucket(initial: Readonly<Record<string, string>>, seams: BucketSeams = {}) {
  const objects = new Map(Object.entries(initial));
  const attempts: string[] = [];
  const etag = (text: string) => `"${sha(text)}"`;
  const bodyBytes = async (key: string, body: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
    if (seams.duringWrite === undefined) return streamToBytes(body);
    const chunks: Uint8Array[] = [];
    const reader = body.getReader();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      if (chunks.length === 0) seams.duringWrite(key, objects);
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  };
  const store: Pick<ObjectStore, 'read' | 'write'> = {
    read: (key) => {
      const failure = seams.failRead?.(key);
      if (failure !== undefined) return Promise.reject(failure);
      const text = objects.get(key);
      return Promise.resolve(
        text === undefined
          ? null
          : {
              meta: {
                sizeBytes: text.length,
                contentType: null,
                etag: etag(text),
                lastModified: new Date(0),
              },
              body: new Blob([text]).stream(),
              range: null,
            },
      );
    },
    write: async (key, body, options: WriteOptions) => {
      attempts.push(key);
      seams.beforeWrite?.(key, objects);
      if (seams.hangWrite === true) return new Promise<never>(() => undefined);
      const failure = seams.failWrite?.(key);
      if (failure !== undefined) throw failure;
      // Buffered here only: the body is verified as it is read, so a mismatch rejects before the set.
      const text = Buffer.from(
        body instanceof Uint8Array ? body : await bodyBytes(key, body),
      ).toString();
      // The precondition is judged as the upload completes, as a provider judges it.
      const current = objects.get(key);
      if (options.ifNoneMatch === '*' && current !== undefined) throw new ObjectConflictError();
      if (
        options.ifMatch !== undefined &&
        (current === undefined || etag(current) !== options.ifMatch)
      ) {
        throw new ObjectConflictError();
      }
      objects.set(key, text);
      return {
        sizeBytes: text.length,
        contentType: null,
        etag: etag(text),
        lastModified: new Date(0),
      };
    },
  };
  return { store, objects, attempts };
}

function tarOf(files: Readonly<Record<string, string>>, folder = FOLDER): Uint8Array {
  return encodeUstar(entriesOf(files, folder));
}

const entriesOf = (files: Readonly<Record<string, string>>, folder: string): TarEntry[] =>
  Object.entries(files).map(([name, content]) => ({
    path: `${folder}/${name}`,
    type: 'file' as const,
    mode: 0o644,
    data: Buffer.from(content),
  }));

/** The archive with its last member's header rewritten the way a hostile runtime could write it. */
function forged(
  entries: readonly TarEntry[],
  edit: { readonly type?: number; readonly name?: string },
): Uint8Array {
  const tar = Buffer.from(encodeUstar(entries));
  const offset = entries
    .slice(0, -1)
    .reduce((sum, entry) => sum + BLOCK + Math.ceil((entry.data?.length ?? 0) / BLOCK) * BLOCK, 0);
  const header = tar.subarray(offset, offset + BLOCK);
  if (edit.type !== undefined) header[156] = edit.type;
  if (edit.name !== undefined) {
    header.fill(0, 0, 100);
    header.fill(0, 345, 500);
    header.write(edit.name, 0);
  }
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return tar;
}

const streamed = (bytes: Uint8Array) => new Blob([Buffer.from(bytes)]).stream();

interface Setup {
  readonly delivered?: Readonly<Record<string, string>>;
  readonly bucket?: Readonly<Record<string, string>>;
  /** What the run left in `storage/acme-data/reports`; the archive of each read can differ. */
  readonly files?: Readonly<Record<string, string>>;
  readonly tar?: (path: string, read: number) => Uint8Array | null;
  /** The run's grants as they are at the end of the run. */
  readonly grants?: readonly Grant[];
  /** The grants the launch body was composed from; `grants` by default. */
  readonly launchGrants?: readonly Grant[];
  /** Files under `reports/` the launch body delivered read-only, as an overlapping grant lists them. */
  readonly launchReadOnlyFiles?: readonly string[];
  /** More launch body entries, as they are sent: a runtime body need not name a kind. */
  readonly launchEntries?: readonly Readonly<Record<string, string>>[];
  /** The grants the run was delivered `read-write`, by folder; the `read-write` grants by default. */
  readonly deliveredFolders?: Readonly<Record<string, { connectionId: string; prefix: string }>>;
  /** The grant behind each folder the input archive was loaded with; not passed by default. */
  readonly hydratedFolders?: Readonly<Record<string, { connectionId: string; prefix: string }>>;
  readonly writeAllowed?: boolean;
  readonly allowedPrefixes?: readonly string[];
  /** Connection rows by id at the end of the run; `CONNECTION` is `acme-data` by default. */
  readonly connections?: Readonly<Record<string, Connection | null | Error>>;
  readonly agentWritesFiles?: boolean;
  readonly bodyWritesFiles?: boolean;
  readonly runAgentGone?: boolean;
  readonly seams?: BucketSeams;
  readonly signal?: AbortSignal;
  readonly audit?: (event: StorageWriteBackAuditEvent) => Promise<void>;
  /** Whether the stored run is still `running`, asked between files; always by default. */
  readonly stillRunning?: () => Promise<boolean>;
  /** Folder contents by connection prefix; streamed, for archives too large to build in memory. */
  readonly streams?: (path: string) => ReadableStream<Uint8Array> | null;
}

const DEFAULT_GRANTS: readonly Grant[] = [
  { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
];

async function writeBack(setup: Setup) {
  const buckets = new Map<string, ReturnType<typeof bucket>>();
  const bucketOf = (connectionId: string) => {
    const held = buckets.get(connectionId);
    if (held !== undefined) return held;
    const made = bucket(connectionId === CONNECTION ? (setup.bucket ?? {}) : {}, setup.seams);
    buckets.set(connectionId, made);
    return made;
  };
  const target = bucketOf(CONNECTION);
  const audit = vi.fn(setup.audit ?? (() => Promise.resolve()));
  const reads: string[] = [];
  const opened: string[] = [];
  const grants: readonly Grant[] = setup.grants ?? DEFAULT_GRANTS;
  const launchGrants: readonly Grant[] = setup.launchGrants ?? grants;
  const folders =
    setup.deliveredFolders ??
    Object.fromEntries(
      launchGrants
        .filter((grant) => grant.access === 'read-write')
        .map((grant) => [`storage/acme-data/${grant.prefix}`, grant]),
    );
  const rows: Readonly<Record<string, Connection | null | Error>> = setup.connections ?? {
    [CONNECTION]: {
      name: 'acme-data',
      allowedPrefixes: [...(setup.allowedPrefixes ?? ['reports', 'data'])],
      writeAllowed: setup.writeAllowed ?? true,
    },
  };
  const counts = await writeBackStorage(
    {
      context: {
        run: { id: 'run-1' },
        agent: { id: 'agent-1' },
        session: { agentVersionId: null },
        principal: { workspaceId: WORKSPACE, principalId: 'principal-1', userId: 'user-1' },
      } as never,
      body: {
        portable: { permissions: { writeFiles: setup.bodyWritesFiles ?? true } },
        resources: {
          files: [
            ...Object.keys(folders).map((path) => ({
              kind: 'directory',
              path,
              access: 'read-write',
            })),
            ...launchGrants
              .filter((grant) => grant.access === 'read')
              .map((grant) => ({
                kind: 'directory',
                path: `storage/acme-data/${grant.prefix}`,
                access: 'read',
              })),
            ...(setup.launchEntries ?? []),
            ...(setup.launchReadOnlyFiles ?? []).map((name) => ({
              kind: 'file',
              path: `storage/acme-data/reports/${name}`,
              access: 'read',
            })),
            ...Object.entries(setup.delivered ?? {}).map(([name, content]) => ({
              kind: 'file',
              path: `storage/acme-data/reports/${name}`,
              access: 'read-write',
              sha256: sha(content),
            })),
          ],
        },
      },
      cwd: CWD,
      collect: (path) => {
        reads.push(path);
        const stream = setup.streams?.(path);
        if (stream !== undefined) return Promise.resolve(stream);
        const tar =
          setup.tar?.(path, reads.filter((read) => read === path).length) ??
          (path === FOLDER ? tarOf(setup.files ?? {}) : null);
        return Promise.resolve(tar === null ? null : streamed(tar));
      },
      folders: new Map(Object.entries(folders)),
      ...(setup.hydratedFolders === undefined
        ? {}
        : { hydrated: new Map(Object.entries(setup.hydratedFolders)) }),
      signal: setup.signal ?? new AbortController().signal,
    },
    {
      readRunAgent: () =>
        setup.runAgentGone === true
          ? Promise.reject(new Error('the version is gone'))
          : Promise.resolve({
              agent: { permissions: { writeFiles: setup.agentWritesFiles ?? true } },
              assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: grants },
            } as never),
      connections: {
        get: (_workspaceId, connectionId) => {
          const row = rows[connectionId] ?? null;
          return row instanceof Error ? Promise.reject(row) : Promise.resolve(row);
        },
        openWritable: (_workspaceId, connectionId) => {
          opened.push(connectionId);
          return Promise.resolve(bucketOf(connectionId).store);
        },
      },
      audit,
      stillRunning: setup.stillRunning ?? (() => Promise.resolve(true)),
    },
  );
  return {
    ...target,
    buckets,
    audit,
    reads,
    opened,
    counts: counts.get(CONNECTION),
    all: counts,
    labels: () => audit.mock.calls.map(([event]) => event.subjectLabel),
  };
}

const NOTHING = { written: 0, unchanged: 0, conflicted: 0, refused: 0, failed: 0, bytes: 0 };

afterEach(() => vi.restoreAllMocks());

describe('a read-write grant is written back', () => {
  it('[US-STO-12][unit][run] saves only the files that are new or changed', async () => {
    const before = { '2026/q3.csv': 'q3,42\n', '2026/q2.csv': 'q2,40\n' };
    const result = await writeBack({
      delivered: before,
      bucket: Object.fromEntries(Object.entries(before).map(([n, c]) => [`reports/${n}`, c])),
      files: { '2026/q3.csv': 'q3,42\n', '2026/q2.csv': 'q2,41\n', 'summary.md': '# Q3\n' },
    });

    expect(result.attempts.sort()).toEqual(['reports/2026/q2.csv', 'reports/summary.md']);
    expect(result.objects.get('reports/2026/q2.csv')).toBe('q2,41\n');
    expect(result.objects.get('reports/summary.md')).toBe('# Q3\n');
    expect(result.counts).toEqual({ ...NOTHING, written: 2, unchanged: 1, bytes: 11 });
  });

  it('[US-STO-12][unit][run] deletes nothing a run removed', async () => {
    const before = { '2026/q3.csv': 'q3,42\n', '2026/q2.csv': 'q2,40\n' };
    const result = await writeBack({
      delivered: before,
      bucket: Object.fromEntries(Object.entries(before).map(([n, c]) => [`reports/${n}`, c])),
      files: { '2026/q3.csv': 'q3,43\n' },
    });

    expect(result.objects.get('reports/2026/q2.csv')).toBe('q2,40\n');
    expect(result.objects.get('reports/2026/q3.csv')).toBe('q3,43\n');
  });

  it('[US-STO-12][unit][run] writes a file created in a folder the grant covers, never above it', async () => {
    const result = await writeBack({ files: { 'new/deep/note.md': 'hi' } });
    expect([...result.objects.keys()]).toEqual(['reports/new/deep/note.md']);
  });

  it('[US-STO-12][unit][run] neither writes nor counts the directory entries of the archive', async () => {
    const result = await writeBack({
      tar: (path) =>
        path === FOLDER
          ? encodeUstar([
              { path: `${FOLDER}/2026`, type: 'directory', mode: 0o755 },
              { path: `${FOLDER}/2026/empty`, type: 'directory', mode: 0o755 },
              ...entriesOf({ '2026/q3.csv': 'q3,42\n' }, FOLDER),
            ])
          : null,
    });

    expect(result.attempts).toEqual(['reports/2026/q3.csv']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, bytes: 6 });
  });

  it('[US-STO-12][unit][run] writes nothing for a folder the run was not delivered writable', async () => {
    const result = await writeBack({ deliveredFolders: {}, files: { 'summary.md': '# Q3\n' } });

    expect(result.reads).toEqual([]);
    expect(result.objects.size).toBe(0);
    expect(result.audit).not.toHaveBeenCalled();
  });
});

describe('the folder is the one that was delivered, whatever the connection is called now', () => {
  it('[US-STO-12][unit][run] still writes to a connection renamed during the run', async () => {
    const result = await writeBack({
      connections: {
        [CONNECTION]: { name: 'renamed', allowedPrefixes: ['reports'], writeAllowed: true },
      },
      files: { 'summary.md': '# Q3\n' },
    });

    expect(result.reads).toContain(FOLDER);
    expect(result.objects.get('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][unit][run] never crosses two connections whose names were swapped', async () => {
    const row = (name: string): Connection => ({
      name,
      allowedPrefixes: ['reports'],
      writeAllowed: true,
    });
    const grants: readonly Grant[] = [
      { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
      { connectionId: OTHER, prefix: 'reports', access: 'read-write' },
    ];
    const result = await writeBack({
      grants,
      deliveredFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
        'storage/beta/reports': { connectionId: OTHER, prefix: 'reports' },
      },
      // Swapped since delivery: each id now carries the other's name.
      connections: { [CONNECTION]: row('beta'), [OTHER]: row('acme-data') },
      tar: (path) =>
        path === FOLDER
          ? tarOf({ 'a.md': 'for acme' })
          : path === `${CWD}/storage/beta/reports`
            ? tarOf({ 'b.md': 'for beta' }, path)
            : null,
    });

    expect([...result.objects.entries()]).toEqual([['reports/a.md', 'for acme']]);
    expect([...(result.buckets.get(OTHER)?.objects.entries() ?? [])]).toEqual([
      ['reports/b.md', 'for beta'],
    ]);
  });
});

describe('the folder is written only when the archive and compose loads agree on its grant', () => {
  const row = (name: string): Connection => ({
    name,
    allowedPrefixes: ['reports'],
    writeAllowed: true,
  });
  const both: readonly Grant[] = [
    { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
    { connectionId: OTHER, prefix: 'reports', access: 'read-write' },
  ];

  it('[US-STO-12][unit][run] writes a folder both loads delivered for the same grant', async () => {
    const result = await writeBack({
      hydratedFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
      },
      files: { 'summary.md': '# Q3\n' },
    });

    expect(result.objects.get('reports/summary.md')).toBe('# Q3\n');
  });

  it('[US-STO-12][unit][run] refuses a folder whose name moved to another connection between the two loads', async () => {
    // The archive put OTHER's files at `storage/acme-data/reports`; by the compose load the name
    // `acme-data` was CONNECTION's, so what the agent left there is OTHER's, not CONNECTION's.
    const result = await writeBack({
      grants: both,
      hydratedFolders: { 'storage/acme-data/reports': { connectionId: OTHER, prefix: 'reports' } },
      deliveredFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
      },
      connections: { [CONNECTION]: row('acme-data'), [OTHER]: row('acme-old') },
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n', 'new.md': 'from the other connection' },
    });

    expect(result.reads).toEqual([]);
    expect(result.opened).toEqual([]);
    expect(result.objects.get('reports/q3.csv')).toBe('q3,42\n');
    expect(result.objects.has('reports/new.md')).toBe(false);
    expect(result.buckets.get(OTHER)).toBeUndefined();
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 0 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: folder_mismatch',
    ]);
  });

  it('[US-STO-12][unit][run] refuses a folder the archive load did not deliver', async () => {
    const result = await writeBack({ hydratedFolders: {}, files: { 'new.md': 'new' } });

    expect(result.objects.size).toBe(0);
    expect(result.labels()[0]).toContain('refused: folder_mismatch');
  });

  it('[US-STO-12][unit][run] refuses a folder the archive load delivered for another prefix', async () => {
    const result = await writeBack({
      hydratedFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'data' },
      },
      files: { 'new.md': 'new' },
    });

    expect(result.objects.size).toBe(0);
    expect(result.labels()[0]).toContain('refused: folder_mismatch');
  });
});

describe('every gate is read again when the run has finished', () => {
  const closed: readonly [string, Setup, string][] = [
    ['the connection stopped allowing writes', { writeAllowed: false }, 'write_not_allowed'],
    [
      'the grant is read only now',
      {
        grants: [{ connectionId: CONNECTION, prefix: 'reports', access: 'read' }],
        deliveredFolders: {
          'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
        },
      },
      'grant_missing',
    ],
    ['the agent may not write files', { agentWritesFiles: false }, 'agent_cannot_write'],
    ['the run was not allowed to write files', { bodyWritesFiles: false }, 'run_cannot_write'],
    ['the connection is gone', { connections: {} }, 'connection_missing'],
    ['the grant row or version is gone', { runAgentGone: true }, 'grant_missing'],
    [
      'the connection no longer allows the folder',
      { allowedPrefixes: ['raw'] },
      'prefix_not_allowed',
    ],
  ];

  it.each(closed)(
    '[US-STO-12][unit][run] writes nothing, and records why, when %s',
    async (_name, setup, reason) => {
      const result = await writeBack({ ...setup, files: { 'summary.md': '# Q3\n' } });

      expect(result.attempts).toEqual([]);
      expect(result.opened).toEqual([]);
      expect(result.objects.size).toBe(0);
      expect(result.labels()).toEqual([
        `run run-1 · 0 written · 0 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: ${reason}`,
      ]);
    },
  );

  it('[US-STO-12][unit][run] refuses a grant whose folder the connection allows only in part', async () => {
    // The connection allows `reports/2026` only: the grant gate, not the per-key check, refuses it.
    const result = await writeBack({
      allowedPrefixes: ['reports/2026'],
      files: { '2026/q3.csv': 'q3,43\n', 'top.md': 'top' },
    });

    expect(result.attempts).toEqual([]);
    expect(result.labels()[0]).toContain('refused: prefix_not_allowed');
  });
});

describe('nothing is written outside the granted prefix', () => {
  it('[US-STO-12][unit][run] refuses, counts and skips members that are not plain descendants', async () => {
    const result = await writeBack({
      tar: () =>
        encodeUstar([
          ...entriesOf({ 'ok.md': 'ok' }, FOLDER),
          ...entriesOf({ 'x.md': 'sibling' }, `${CWD}/storage/acme-data/reports-evil`),
          ...entriesOf({ 'x.md': 'outputs' }, `${CWD}/outputs`),
          ...entriesOf({ 'a\\b.md': 'backslash' }, FOLDER),
        ]),
    });

    expect([...result.objects.keys()]).toEqual(['reports/ok.md']);
    expect(result.counts).toMatchObject({ written: 1, refused: 3 });
  });

  it('[US-STO-12][unit][run] refuses a member whose key the object-store guard refuses', async () => {
    // A plain path segment that only the key guard refuses: `%` could decode to a separator.
    const result = await writeBack({ files: { 'ok.md': 'ok', 'a%2e.md': 'escaped' } });

    expect([...result.objects.keys()]).toEqual(['reports/ok.md']);
    expect(result.counts).toMatchObject({ written: 1, refused: 1 });
  });

  it('[US-STO-12][unit][run] leaves a read-only overlapping folder alone', async () => {
    const result = await writeBack({
      grants: [
        { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
        { connectionId: CONNECTION, prefix: 'reports/2026', access: 'read' },
      ],
      files: { '2026/q3.csv': 'tampered', 'top.md': 'top' },
    });

    expect([...result.objects.keys()]).toEqual(['reports/top.md']);
    expect(result.counts).toMatchObject({ written: 1, refused: 1 });
  });

  it('[US-STO-12][unit][run] writes and counts a file once when two read-write grants overlap', async () => {
    const result = await writeBack({
      grants: [
        { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
        { connectionId: CONNECTION, prefix: 'reports/2026', access: 'read-write' },
      ],
      tar: (path) =>
        path === FOLDER
          ? tarOf({ '2026/q3.csv': 'q3,43\n', 'top.md': 'top' })
          : path === `${FOLDER}/2026`
            ? tarOf({ 'q3.csv': 'q3,43\n' }, path)
            : null,
    });

    expect(result.reads).toEqual([FOLDER, FOLDER, `${FOLDER}/2026`]);
    expect(result.attempts.sort()).toEqual(['reports/2026/q3.csv', 'reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 2, bytes: 9 });
  });

  const entries: readonly TarEntry[] = entriesOf({ 'ok.md': 'ok', 'evil.md': 'evil' }, FOLDER);
  const hostile: readonly [string, Uint8Array][] = [
    ['a symlink', forged(entries, { type: 0x32 })],
    ['a hard link', forged(entries, { type: 0x31 })],
    ['a parent segment', forged(entries, { name: `${FOLDER}/../../../etc/cron.d/x` })],
    ['an absolute path', forged(entries, { name: '/etc/cron.d/x' })],
  ];

  it.each(hostile)(
    '[US-STO-12][unit][run] refuses the whole grant for an archive with %s',
    async (_name, tar) => {
      const result = await writeBack({ tar: (path) => (path === FOLDER ? tar : null) });

      expect(result.attempts).toEqual([]);
      expect(result.objects.size).toBe(0);
      expect(result.counts).toEqual({ ...NOTHING, refused: 1 });
      expect(result.labels()[0]).toContain('refused: archive_refused');
    },
  );
});

describe('write-back needs the launch body and the grants as they are now to allow a file', () => {
  const broad: Grant = { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' };
  const nested: Grant = { connectionId: CONNECTION, prefix: 'reports/2026', access: 'read' };
  const files = { '2026/q3.csv': 'q3,43\n', 'top.md': '# Top\n' };

  it('[US-STO-12][unit][run] keeps a folder read-only whose read grant was removed during the run', async () => {
    const result = await writeBack({ launchGrants: [broad, nested], grants: [broad], files });

    expect(result.attempts).toEqual(['reports/top.md']);
    expect(result.objects.has('reports/2026/q3.csv')).toBe(false);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, refused: 1, bytes: 6 });
  });

  it('[US-STO-12][unit][run] keeps an exact file read-only that the launch body delivered read-only', async () => {
    const result = await writeBack({
      launchReadOnlyFiles: ['2026/q3.csv'],
      files: { ...files, '2026/q2.csv': 'q2,41\n' },
    });

    expect(result.attempts.sort()).toEqual(['reports/2026/q2.csv', 'reports/top.md']);
    expect(result.objects.has('reports/2026/q3.csv')).toBe(false);
    expect(result.counts).toEqual({ ...NOTHING, written: 2, refused: 1, bytes: 12 });
  });

  it('[US-STO-12][unit][run] writes a sibling folder that only shares the read-only folder name as a prefix', async () => {
    const result = await writeBack({
      launchGrants: [broad, nested],
      grants: [broad],
      files: { ...files, '20261/x.csv': 'x\n' },
    });

    expect(result.attempts.sort()).toEqual(['reports/20261/x.csv', 'reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 2, refused: 1, bytes: 8 });
  });

  it('[US-STO-12][unit][run] keeps everything under a read-only launch entry that names no kind', async () => {
    const result = await writeBack({
      launchEntries: [{ path: 'storage/acme-data/reports/2026', access: 'read' }],
      files,
    });

    expect(result.attempts).toEqual(['reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, refused: 1, bytes: 6 });
  });

  it('[US-STO-12][unit][run] writes nothing when the read-write grant was removed during the run', async () => {
    const result = await writeBack({ launchGrants: [broad, nested], grants: [nested], files });

    expect(result.attempts).toEqual([]);
    expect(result.labels()).toEqual([expect.stringContaining('refused: grant_missing')]);
  });

  it('[US-STO-12][unit][run] honours a read grant added during the run', async () => {
    const result = await writeBack({ launchGrants: [broad], grants: [broad, nested], files });

    expect(result.attempts).toEqual(['reports/top.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, refused: 1, bytes: 6 });
  });
});

describe('a file that moved on in the bucket is kept', () => {
  it('[US-STO-12][unit][run] keeps the bucket version of a file changed there during the run', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'edited elsewhere\n' },
      files: { 'q3.csv': 'q3,43\n', 'new.md': 'new' },
    });

    expect(result.objects.get('reports/q3.csv')).toBe('edited elsewhere\n');
    expect(result.objects.get('reports/new.md')).toBe('new');
    expect(result.counts).toMatchObject({ written: 1, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] keeps the bucket version of a file deleted there during the run', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
    });

    expect(result.objects.size).toBe(0);
    expect(result.counts).toMatchObject({ written: 0, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] counts a delivered file whose bucket is gone as failed, not conflicted', async () => {
    // The store raises for a missing bucket; only a missing object answers `null`.
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
      seams: { failRead: () => new Error('NoSuchBucket') },
    });

    expect(result.counts).toMatchObject({ written: 0, conflicted: 0, failed: 1 });
  });

  it('[US-STO-12][unit][run] keeps the bucket version of a file created there during the run', async () => {
    const result = await writeBack({
      bucket: { 'reports/new.md': 'theirs' },
      files: { 'new.md': 'ours' },
    });

    expect(result.objects.get('reports/new.md')).toBe('theirs');
    expect(result.counts).toMatchObject({ written: 0, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] counts a precondition the store refuses after the check as a conflict', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n', 'new.md': 'new' },
      seams: {
        failWrite: (key) => (key === 'reports/q3.csv' ? new ObjectConflictError() : undefined),
      },
    });

    expect(result.objects.get('reports/q3.csv')).toBe('q3,42\n');
    expect(result.counts).toMatchObject({ written: 1, conflicted: 1, failed: 0 });
  });

  it('[US-STO-12][unit][run] keeps a change made between the hash check and the write (ifMatch)', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
      seams: {
        beforeWrite: (key, objects) => {
          if (key === 'reports/q3.csv') objects.set(key, 'edited in between\n');
        },
      },
    });

    expect(result.objects.get('reports/q3.csv')).toBe('edited in between\n');
    expect(result.counts).toMatchObject({ written: 0, conflicted: 1 });
  });
});

describe('a store write racing another writer mid-upload', () => {
  it('[US-STO-12][unit][run] keeps a delivered file another writer changed while it was uploading', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n', 'q2.csv': 'q2,40\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n', 'reports/q2.csv': 'q2,40\n' },
      files: { 'q3.csv': 'q3,43\n', 'q2.csv': 'q2,41\n' },
      seams: {
        duringWrite: (key, objects) => {
          if (key === 'reports/q3.csv') objects.set(key, 'theirs, mid-upload\n');
        },
      },
    });

    expect(result.attempts.sort()).toEqual(['reports/q2.csv', 'reports/q3.csv']);
    expect(result.objects.get('reports/q3.csv')).toBe('theirs, mid-upload\n');
    expect(result.objects.get('reports/q2.csv')).toBe('q2,41\n');
    expect(result.counts).toEqual({ ...NOTHING, written: 1, conflicted: 1, bytes: 6 });
    expect(result.labels()).toEqual([
      'run run-1 · 1 written · 0 unchanged · 1 conflicted · 0 refused · 0 failed · 6 bytes',
    ]);
  });

  it('[US-STO-12][unit][run] keeps a file another writer created while a new one was uploading', async () => {
    const result = await writeBack({
      files: { 'new.md': 'ours' },
      seams: {
        duringWrite: (key, objects) => {
          objects.set(key, 'theirs');
        },
      },
    });

    expect(result.attempts).toEqual(['reports/new.md']);
    expect(result.objects.get('reports/new.md')).toBe('theirs');
    expect(result.counts).toEqual({ ...NOTHING, conflicted: 1 });
  });

  it('[US-STO-12][unit][run] keeps a file another writer deleted while it was uploading', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,43\n' },
      seams: {
        duringWrite: (key, objects) => {
          objects.delete(key);
        },
      },
    });

    // Write-back never deletes, and a delete it raced is not undone by a recreate either.
    expect(result.objects.has('reports/q3.csv')).toBe(false);
    expect(result.counts).toEqual({ ...NOTHING, conflicted: 1 });
  });
});

describe('one file failing does not stop the others', () => {
  it('[US-STO-12][unit][run] saves the rest and does not throw', async () => {
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
      seams: { failWrite: (key) => (key === 'reports/b.md' ? new Error('disk full') : undefined) },
    });

    expect([...result.objects.keys()].sort()).toEqual(['reports/a.md', 'reports/c.md']);
    expect(result.counts).toMatchObject({ written: 2, failed: 1 });
    expect(result.audit).toHaveBeenCalledOnce();
  });

  it('[US-STO-12][unit][run] writes no part of a file that changed between the two reads', async () => {
    const result = await writeBack({
      tar: (path, read) =>
        path === FOLDER ? tarOf({ 'a.md': read === 1 ? 'first' : 'second', 'b.md': 'b' }) : null,
    });

    expect(result.objects.has('reports/a.md')).toBe(false);
    expect(result.objects.get('reports/b.md')).toBe('b');
    expect(result.counts).toMatchObject({ written: 1, failed: 1 });
  });

  it('[US-STO-12][unit][run] counts a file the second read never reached as failed', async () => {
    const result = await writeBack({
      tar: (path, read) =>
        path === FOLDER ? tarOf(read === 1 ? { 'a.md': 'a', 'b.md': 'b' } : { 'a.md': 'a' }) : null,
    });

    expect([...result.objects.keys()]).toEqual(['reports/a.md']);
    expect(result.counts).toMatchObject({ written: 1, failed: 1 });
  });

  it('[US-STO-12][unit][run] survives an audit that cannot be recorded', async () => {
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const result = await writeBack({
      files: { 'a.md': 'a' },
      audit: () => Promise.reject(new Error('audit store down')),
    });

    expect(result.objects.get('reports/a.md')).toBe('a');
    expect(error).toHaveBeenCalledOnce();
  });
});

/** The reason `AbortSignal.timeout` aborts with: what the launcher's deadline signal carries. */
const timedOut = () => new DOMException('the write-back deadline passed', 'TimeoutError');

describe('the write-back deadline', () => {
  it('[US-STO-12][unit][run] stops at the deadline on a store that never answers, counting the rest failed', async () => {
    // The deadline passes inside the first, hung write: no assertion depends on the clock.
    const deadline = new AbortController();
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
      seams: { hangWrite: true, beforeWrite: () => deadline.abort(timedOut()) },
      signal: deadline.signal,
    });

    expect(result.attempts).toEqual(['reports/a.md']);
    expect(result.objects.size).toBe(0);
    expect(result.counts).toEqual({ ...NOTHING, failed: 3 });
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 0 unchanged · 0 conflicted · 0 refused · 3 failed · 0 bytes · refused: deadline',
    ]);
  });

  it('[US-STO-12][unit][run] starts no grant once the deadline has passed', async () => {
    const controller = new AbortController();
    controller.abort(timedOut());
    const result = await writeBack({ files: { 'a.md': 'a' }, signal: controller.signal });

    expect(result.reads).toEqual([]);
    expect(result.labels()[0]).toContain('1 refused · 0 failed · 0 bytes · refused: deadline');
  });
});

describe('the audit row', () => {
  it('[US-STO-12][unit][run] is one row per connection whose label is counts only', async () => {
    // Built at run time: a literal key-shaped string would trip the secret scanner.
    const secret = randomBytes(16).toString('hex');
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const result = await writeBack({
      grants: [
        { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
        { connectionId: CONNECTION, prefix: 'data', access: 'read-write' },
      ],
      connections: {
        [CONNECTION]: {
          name: `acme-${secret}`,
          allowedPrefixes: ['reports', 'data'],
          writeAllowed: true,
        },
      },
      tar: (path) =>
        path === FOLDER
          ? tarOf({ [`${secret}.md`]: `content ${secret}` })
          : path === `${CWD}/storage/acme-data/data`
            ? tarOf({ 'two.md': 'two' }, path)
            : null,
    });

    expect(result.audit).toHaveBeenCalledOnce();
    expect(result.audit.mock.calls[0]?.[0]).toEqual({
      workspaceId: WORKSPACE,
      actorPrincipalId: 'principal-1',
      actorUserId: 'user-1',
      actorLabel: 'run run-1',
      action: 'storage-connection-written',
      subjectId: CONNECTION,
      subjectLabel: `run run-1 · 2 written · 0 unchanged · 0 conflicted · 0 refused · 0 failed · ${String(`content ${secret}`.length + 3)} bytes`,
    });
    const logged = JSON.stringify([result.audit.mock.calls, info.mock.calls]);
    for (const leaked of [secret, 'two.md', CWD, '/storage/', 'reports/', 'acme-'])
      expect(logged).not.toContain(leaked);
    expect(info.mock.calls[0]?.[1]).toMatchObject({ connectionId: CONNECTION, written: 2 });
  });

  it('[US-STO-12][unit][run] names no key or error message when files conflict and fail', async () => {
    const result = await writeBack({
      bucket: { 'reports/taken.md': 'theirs' },
      files: { 'taken.md': 'ours', 'broken.md': 'x', 'ok.md': 'ok' },
      seams: {
        failWrite: (key) =>
          key === 'reports/broken.md' ? new Error('secret-bucket-path exploded') : undefined,
      },
    });

    expect(result.labels()).toEqual([
      'run run-1 · 1 written · 0 unchanged · 1 conflicted · 0 refused · 1 failed · 2 bytes',
    ]);
  });

  it('[US-STO-12][unit][run] writes the label from counts and the reason code alone', () => {
    const counts = { written: 1, unchanged: 2, conflicted: 3, refused: 4, failed: 5, bytes: 6 };
    expect(writeBackLabel('r', counts, null)).toBe(
      'run r · 1 written · 2 unchanged · 3 conflicted · 4 refused · 5 failed · 6 bytes',
    );
    expect(writeBackLabel('r', counts, 'deadline')).toBe(
      'run r · 1 written · 2 unchanged · 3 conflicted · 4 refused · 5 failed · 6 bytes · refused: deadline',
    );
  });

  it('[US-STO-12][unit][run] is left out when the run changed nothing', async () => {
    const result = await writeBack({
      delivered: { 'q3.csv': 'q3,42\n' },
      bucket: { 'reports/q3.csv': 'q3,42\n' },
      files: { 'q3.csv': 'q3,42\n' },
    });

    expect(result.counts).toEqual({ ...NOTHING, unchanged: 1 });
    expect(result.audit).not.toHaveBeenCalled();
  });

  it('[US-STO-12][unit][run] records a refusal even when nothing was written', async () => {
    const result = await writeBack({ writeAllowed: false, files: { 'a.md': 'a' } });

    expect(result.counts).toEqual({ ...NOTHING, refused: 1 });
    expect(result.audit).toHaveBeenCalledOnce();
  });

  it("[US-STO-12][unit][run] still records the first grant's row when the second grant throws", async () => {
    const result = await writeBack({
      grants: [
        { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
        { connectionId: OTHER, prefix: 'reports', access: 'read-write' },
      ],
      deliveredFolders: {
        'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
        'storage/beta/reports': { connectionId: OTHER, prefix: 'reports' },
      },
      connections: {
        [CONNECTION]: { name: 'acme-data', allowedPrefixes: ['reports'], writeAllowed: true },
        [OTHER]: new Error('the connection store is down'),
      },
      files: { 'a.md': 'a' },
    });

    expect(result.audit.mock.calls.map(([event]) => [event.subjectId, event.subjectLabel])).toEqual(
      [
        [
          CONNECTION,
          'run run-1 · 1 written · 0 unchanged · 0 conflicted · 0 refused · 0 failed · 1 bytes',
        ],
        [
          OTHER,
          'run run-1 · 0 written · 0 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: connection_unavailable',
        ],
      ],
    );
  });
});

describe('a run stopped while it is being saved', () => {
  it('[US-STO-12][unit][run] names an interrupt apart from the deadline', async () => {
    const interrupt = new AbortController();
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b' },
      seams: { hangWrite: true, beforeWrite: () => interrupt.abort() },
      signal: interrupt.signal,
    });

    expect(result.counts).toEqual({ ...NOTHING, failed: 2 });
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 0 unchanged · 0 conflicted · 0 refused · 2 failed · 0 bytes · refused: interrupted',
    ]);
  });

  it('[US-STO-12][unit][run] stops between files once the stored run is no longer running', async () => {
    // Another replica cancelled the run: only the stored status says so, not this signal. Each
    // file comes a status interval after the last, so each one asks the store again.
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += STORAGE_WRITEBACK_STATUS_INTERVAL_MS));
    let checks = 0;
    const result = await writeBack({
      files: { 'a.md': 'a', 'b.md': 'b', 'c.md': 'c' },
      stillRunning: () => Promise.resolve((checks += 1) === 1),
    });

    expect(result.attempts).toEqual(['reports/a.md']);
    expect(result.counts).toEqual({ ...NOTHING, written: 1, failed: 2, bytes: 1 });
    expect(result.labels()).toEqual([
      'run run-1 · 1 written · 0 unchanged · 0 conflicted · 0 refused · 2 failed · 1 bytes · refused: interrupted',
    ]);
  });

  it('[US-STO-12][unit][run] asks the stored status at most once per interval, first before any write', async () => {
    // A folder of many changed files must not cost one database read per file.
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    let checks = 0;
    const files = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`f${String(index)}.md`, 'x']),
    );
    const result = await writeBack({
      files,
      stillRunning: () => {
        checks += 1;
        return Promise.resolve(true);
      },
    });

    expect(result.counts).toMatchObject({ written: 20, failed: 0 });
    expect(checks).toBe(1);

    let stopped = 0;
    const cancelled = await writeBack({
      files,
      stillRunning: () => {
        stopped += 1;
        return Promise.resolve(false);
      },
    });
    expect(cancelled.attempts).toEqual([]);
    expect(stopped).toBe(1);
  });
});

describe('what the write-back logs', () => {
  it('[US-STO-12][unit][run] names no key a store error carries', async () => {
    // A customer's file name, not a credential: the redactor masks secrets, not names.
    const secret = 'board-minutes-acquisition-plan';
    const logged = captureLog();
    const result = await writeBack({
      files: { [`${secret}.md`]: 'x' },
      seams: {
        failWrite: (key) => new Error(`PutObject on ${key} failed: AccessDenied`),
      },
    });
    logged.restore();

    expect(result.counts).toMatchObject({ failed: 1 });
    expect(logged.text()).toContain('storage write-back could not write a file');
    expect(logged.text()).not.toContain(secret);
  });
});

describe('the audit write', () => {
  it('[US-STO-12][unit][run] cannot keep the session busy when it never answers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      const pending = writeBack({
        files: { 'a.md': 'a' },
        audit: () => new Promise<never>(() => undefined),
      });
      let settled = false;
      void pending.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(STORAGE_WRITEBACK_AUDIT_DEADLINE_MS);
      const result = await pending;

      expect(settled).toBe(true);
      expect(result.objects.get('reports/a.md')).toBe('a');
      expect(error).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the run-wide byte budget', () => {
  const MIB = 1024 * 1024;
  const SIZE = 80 * MIB;

  /** A one-file archive of `size` zero bytes under `folder`, streamed a MiB at a time. */
  function zeroArchive(folder: string, name: string, size: number): ReadableStream<Uint8Array> {
    const empty = encodeUstar([
      { path: `${folder}/${name}`, type: 'file', mode: 0o644, data: Buffer.alloc(0) },
    ]);
    const header = Buffer.from(empty.subarray(0, BLOCK));
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    const chunk = new Uint8Array(MIB);
    const parts: (() => Uint8Array)[] = [() => header];
    for (let left = size; left > 0; left -= MIB) {
      const length = Math.min(left, MIB);
      parts.push(() => chunk.subarray(0, length));
    }
    parts.push(() => new Uint8Array(BLOCK * 2));
    let next = 0;
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const part = parts[next];
        next += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(part());
      },
    });
  }

  function zeroSha(size: number): string {
    const hash = createHash('sha256');
    const chunk = new Uint8Array(MIB);
    for (let left = size; left > 0; left -= MIB)
      hash.update(chunk.subarray(0, Math.min(left, MIB)));
    return hash.digest('hex');
  }

  it('[US-STO-12][unit][run] refuses a later folder once the run has read its budget', async () => {
    // Two folders of 80 MiB each: the first is read in full, the second exceeds what is left of
    // the run's 128 MiB. The first file is unchanged, so no body of it is buffered by this fake.
    const data = `${CWD}/storage/acme-data/data`;
    const result = await writeBack({
      grants: [
        { connectionId: CONNECTION, prefix: 'reports', access: 'read-write' },
        { connectionId: CONNECTION, prefix: 'data', access: 'read-write' },
      ],
      launchEntries: [
        {
          kind: 'file',
          path: 'storage/acme-data/reports/big.bin',
          access: 'read-write',
          sha256: zeroSha(SIZE),
        },
      ],
      streams: (path) =>
        path === FOLDER
          ? zeroArchive(FOLDER, 'big.bin', SIZE)
          : path === data
            ? zeroArchive(data, 'big.bin', SIZE)
            : null,
    });

    expect(result.attempts).toEqual([]);
    expect(result.labels()).toEqual([
      'run run-1 · 0 written · 1 unchanged · 0 conflicted · 1 refused · 0 failed · 0 bytes · refused: archive_refused',
    ]);
  });
});
