/**
 * The fakes behind the write-back tests (US-STO-12): a bucket that honours preconditions, tar
 * archives (well formed and forged), and `writeBack`, which runs `writeBackStorage` against them.
 */
import { createHash } from 'node:crypto';

import {
  ObjectConflictError,
  streamToBytes,
  type ObjectStore,
  type WriteOptions,
} from '@agent-workspace/core/storage';
import { encodeUstar, type TarEntry } from '@agent-workspace/runtime/transfer';
import { vi } from 'vitest';

import { type Clock } from '../clock';
import { writeBackStorage, type StorageWriteBackAuditEvent } from './storage-writeback';

export const WORKSPACE = '22222222-2222-4222-8222-222222222222';
export const CONNECTION = '33333333-3333-4333-8333-333333333333';
export const OTHER = '44444444-4444-4444-8444-444444444444';
export const CWD = `${WORKSPACE}/session-1`;
export const FOLDER = `${CWD}/storage/acme-data/reports`;
export const BLOCK = 512;

export const NOTHING = { written: 0, unchanged: 0, conflicted: 0, refused: 0, failed: 0, bytes: 0 };

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export interface Grant {
  readonly connectionId: string;
  readonly prefix: string;
  readonly access: 'read' | 'read-write';
}

/** One connection's row as the write-back reads it at the end of the run. */
export interface Connection {
  readonly name: string;
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed: boolean;
}

/** A `reports` grant for a connection, `read-write` unless told otherwise. */
export const reportsGrant = (
  connectionId: string,
  prefix = 'reports',
  access: Grant['access'] = 'read-write',
): Grant => ({ connectionId, prefix, access });

/** A connection row that allows writes under `reports` only. */
export const connectionRow = (name: string): Connection => ({
  name,
  allowedPrefixes: ['reports'],
  writeAllowed: true,
});

/** Read-write grants on `reports` for both connections, delivered under their own names. */
export const TWO_CONNECTION_GRANTS: readonly Grant[] = [
  reportsGrant(CONNECTION),
  reportsGrant(OTHER),
];

export const TWO_CONNECTION_FOLDERS = {
  'storage/acme-data/reports': { connectionId: CONNECTION, prefix: 'reports' },
  'storage/beta/reports': { connectionId: OTHER, prefix: 'reports' },
};

export interface BucketSeams {
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

const etagOf = (text: string) => `"${sha(text)}"`;

const metaOf = (text: string) => ({
  sizeBytes: text.length,
  contentType: null,
  etag: etagOf(text),
  lastModified: new Date(0),
});

/** Reads a write body, telling `duringWrite` once its first chunk has arrived. */
async function readBody(
  key: string,
  body: ReadableStream<Uint8Array>,
  objects: Map<string, string>,
  duringWrite: BucketSeams['duringWrite'],
): Promise<Uint8Array> {
  if (duringWrite === undefined) return streamToBytes(body);
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    if (chunks.length === 0) duringWrite(key, objects);
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** Throws the conflict a provider raises when the write's precondition no longer holds. */
function checkPrecondition(current: string | undefined, options: WriteOptions): void {
  if (options.ifNoneMatch === '*' && current !== undefined) throw new ObjectConflictError();
  const matchFailed =
    options.ifMatch !== undefined && (current === undefined || etagOf(current) !== options.ifMatch);
  if (matchFailed) throw new ObjectConflictError();
}

/** A bucket that keeps text by key, records every write it is asked for, and honours preconditions. */
export function bucket(initial: Readonly<Record<string, string>>, seams: BucketSeams = {}) {
  const objects = new Map(Object.entries(initial));
  const attempts: string[] = [];
  /** The signal each read and write was given, in call order. */
  const signals: (AbortSignal | undefined)[] = [];
  const store: Pick<ObjectStore, 'read' | 'write'> = {
    read: (key, readOptions) => {
      signals.push(readOptions?.signal);
      const failure = seams.failRead?.(key);
      if (failure !== undefined) return Promise.reject(failure);
      const text = objects.get(key);
      if (text === undefined) return Promise.resolve(null);
      return Promise.resolve({ meta: metaOf(text), body: new Blob([text]).stream(), range: null });
    },
    write: async (key, body, options: WriteOptions) => {
      signals.push(options.signal);
      attempts.push(key);
      seams.beforeWrite?.(key, objects);
      if (seams.hangWrite === true) return new Promise<never>(() => undefined);
      const failure = seams.failWrite?.(key);
      if (failure !== undefined) throw failure;
      // Buffered here only: the body is verified as it is read, so a mismatch rejects before the set.
      const bytes =
        body instanceof Uint8Array ? body : await readBody(key, body, objects, seams.duringWrite);
      const text = Buffer.from(bytes).toString();
      // The precondition is judged as the upload completes, as a provider judges it.
      checkPrecondition(objects.get(key), options);
      objects.set(key, text);
      return metaOf(text);
    },
  };
  return { store, objects, attempts, signals };
}

export const entriesOf = (files: Readonly<Record<string, string>>, folder: string): TarEntry[] =>
  Object.entries(files).map(([name, content]) => ({
    path: `${folder}/${name}`,
    type: 'file' as const,
    mode: 0o644,
    data: Buffer.from(content),
  }));

export function tarOf(files: Readonly<Record<string, string>>, folder = FOLDER): Uint8Array {
  return encodeUstar(entriesOf(files, folder));
}

/** Rewrites a tar header's checksum field so the edited header still verifies. */
export function sealChecksum(header: Buffer): void {
  header.fill(0x20, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
}

/** The archive with its last member's header rewritten the way a hostile runtime could write it. */
export function forged(
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
  sealChecksum(header);
  return tar;
}

const streamed = (bytes: Uint8Array) => new Blob([Buffer.from(bytes)]).stream();

type FolderGrants = Readonly<Record<string, { connectionId: string; prefix: string }>>;

export interface Setup {
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
  readonly deliveredFolders?: FolderGrants;
  /** The grant behind each folder the input archive was loaded with; not passed by default. */
  readonly hydratedFolders?: FolderGrants;
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
  readonly clock?: Clock;
  /** Folder contents by connection prefix; streamed, for archives too large to build in memory. */
  readonly streams?: (path: string) => ReadableStream<Uint8Array> | null;
}

const DEFAULT_GRANTS: readonly Grant[] = [reportsGrant(CONNECTION)];

const readWriteFolders = (launchGrants: readonly Grant[]): FolderGrants =>
  Object.fromEntries(
    launchGrants
      .filter((grant) => grant.access === 'read-write')
      .map((grant) => [`storage/acme-data/${grant.prefix}`, grant]),
  );

/** The `resources.files` of the launch body the run was composed from. */
function launchFiles(setup: Setup, launchGrants: readonly Grant[], folders: FolderGrants) {
  return [
    ...Object.keys(folders).map((path) => ({ kind: 'directory', path, access: 'read-write' })),
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
  ];
}

/** The folder archive a `collect` call answers with, recording each read. */
function collectFrom(setup: Setup, reads: string[]) {
  return (path: string) => {
    reads.push(path);
    const stream = setup.streams?.(path);
    if (stream !== undefined) return Promise.resolve(stream);
    const tar =
      setup.tar?.(path, reads.filter((read) => read === path).length) ??
      (path === FOLDER ? tarOf(setup.files ?? {}) : null);
    return Promise.resolve(tar === null ? null : streamed(tar));
  };
}

function connectionRows(setup: Setup): Readonly<Record<string, Connection | null | Error>> {
  return (
    setup.connections ?? {
      [CONNECTION]: {
        name: 'acme-data',
        allowedPrefixes: [...(setup.allowedPrefixes ?? ['reports', 'data'])],
        writeAllowed: setup.writeAllowed ?? true,
      },
    }
  );
}

type Bucket = ReturnType<typeof bucket>;

/** What the run's agent row says at the end of the run, or a failure when its version is gone. */
function readRunAgentOf(setup: Setup, grants: readonly Grant[]) {
  return () =>
    setup.runAgentGone === true
      ? Promise.reject(new Error('the version is gone'))
      : Promise.resolve({
          agent: { permissions: { writeFiles: setup.agentWritesFiles ?? true } },
          assignments: { files: [], skillIds: [], connectorIds: [], storageGrants: grants },
        } as never);
}

interface OpenLog {
  readonly opened: string[];
  readonly openSignals: (AbortSignal | undefined)[];
}

/** The connection reads: rows by id, and a writable bucket per connection that logs each open. */
function connectionsOf(
  rows: Readonly<Record<string, Connection | null | Error>>,
  bucketOf: (connectionId: string) => Bucket,
  log: OpenLog,
) {
  return {
    get: (_workspaceId: string, connectionId: string) => {
      const row = rows[connectionId] ?? null;
      return row instanceof Error ? Promise.reject(row) : Promise.resolve(row);
    },
    openWritable: (_workspaceId: string, connectionId: string, signal?: AbortSignal) => {
      log.opened.push(connectionId);
      log.openSignals.push(signal);
      return Promise.resolve(bucketOf(connectionId).store);
    },
  };
}

/** Runs `writeBackStorage` for one setup and returns the target bucket, the calls and the counts. */
export async function writeBack(setup: Setup) {
  const buckets = new Map<string, Bucket>();
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
  const openLog: OpenLog = { opened: [], openSignals: [] };
  const grants = setup.grants ?? DEFAULT_GRANTS;
  const launchGrants = setup.launchGrants ?? grants;
  const folders = setup.deliveredFolders ?? readWriteFolders(launchGrants);
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
        resources: { files: launchFiles(setup, launchGrants, folders) },
      },
      cwd: CWD,
      collect: collectFrom(setup, reads),
      folders: new Map(Object.entries(folders)),
      ...(setup.hydratedFolders === undefined
        ? {}
        : { hydrated: new Map(Object.entries(setup.hydratedFolders)) }),
      signal: setup.signal ?? new AbortController().signal,
    },
    {
      readRunAgent: readRunAgentOf(setup, grants),
      connections: connectionsOf(connectionRows(setup), bucketOf, openLog),
      audit,
      stillRunning: setup.stillRunning ?? (() => Promise.resolve(true)),
      ...(setup.clock === undefined ? {} : { clock: setup.clock }),
    },
  );
  return {
    ...target,
    buckets,
    audit,
    reads,
    ...openLog,
    counts: counts.get(CONNECTION),
    all: counts,
    labels: () => audit.mock.calls.map(([event]) => event.subjectLabel),
  };
}
