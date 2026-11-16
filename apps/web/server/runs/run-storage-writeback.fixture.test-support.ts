import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadEgressPolicyFromEnv } from '@agent-workspace/core';
import {
  openConnectionStore,
  streamToBytes,
  type ObjectStore,
} from '@agent-workspace/core/storage';
import { encodeUstar, type TarEntry } from '@agent-workspace/runtime/transfer';

import { afterEach } from 'vitest';
import { clearApplicationContext } from '../application-context';
import { InMemoryRunStore } from './memory-store';
import {
  isTerminalRunStatus,
  SessionBusyError,
  type CreateRunInput,
  type RunRecord,
} from './store';

export const noLog = { info() {}, warn() {}, error() {}, child: () => noLog };

export const CSV = 'quarter,total\nq3,42\n';

export const localEgress = { production: false, allowHosts: [] } as const;

const BLOCK = 512;

export interface Backend {
  readonly open: (writable: boolean) => Promise<ObjectStore>;
  readonly teardown: () => Promise<void>;
}

export async function fileBackend(): Promise<Backend> {
  const root = await mkdtemp(join(tmpdir(), 'aw-sto12-wb-'));
  return {
    open: (writable) =>
      openConnectionStore(
        `file://${root}`,
        { provider: 'file' },
        {
          writable,
          fileRoots: [root],
          egress: loadEgressPolicyFromEnv(),
        },
      ),
    teardown: () => rm(root, { recursive: true, force: true }),
  };
}

export const text = async (store: ObjectStore, key: string): Promise<string | null> => {
  const object = await store.read(key);
  return object === null ? null : Buffer.from(await streamToBytes(object.body)).toString('utf8');
};

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

export const filesIn = (folder: string, files: Readonly<Record<string, string>>): TarEntry[] =>
  Object.entries(files).map(([name, content]) => ({
    path: `${folder}/${name}`,
    type: 'file' as const,
    mode: 0o644,
    data: Buffer.from(content),
  }));

interface ConnectionRow {
  name: string;
  readonly allowedPrefixes: readonly string[];
  writeAllowed: boolean;
}

export interface World {
  readonly rows: Map<string, ConnectionRow>;
  readonly backends: Map<string, Backend>;
  readonly makeBackend: () => Promise<Backend>;
  agentWrites: boolean;
  grantAccess: 'read' | 'read-write';
  /** The run is also granted `reports/2026` read only. */
  nestedReadOnly: boolean;
}

export class SessionBusyRunStore extends InMemoryRunStore {
  readonly #ids: string[] = [];

  override async create(input: CreateRunInput): Promise<RunRecord> {
    for (const id of this.#ids) {
      const held = await this.get(id);
      if (held?.sessionId === input.sessionId && !isTerminalRunStatus(held.status)) {
        throw new SessionBusyError(input.sessionId);
      }
    }
    const created = await super.create(input);
    this.#ids.push(created.id);
    return created;
  }
}

export const backends: Backend[] = [];

afterEach(async () => {
  clearApplicationContext();
  await Promise.all(backends.splice(0).map((backend) => backend.teardown()));
});

export const gates: readonly [string, (world: World) => void, string][] = [
  [
    'the connection stops allowing writes',
    (world) => {
      for (const row of world.rows.values()) row.writeAllowed = false;
    },
    'write_not_allowed',
  ],
  [
    'the grant becomes read only',
    (world) => {
      world.grantAccess = 'read';
    },
    'grant_missing',
  ],
  [
    'the agent may no longer write files',
    (world) => {
      world.agentWrites = false;
    },
    'agent_cannot_write',
  ],
];

export const escapes: readonly [string, (folder: string) => Uint8Array][] = [
  [
    'a parent segment',
    (folder) =>
      forged(filesIn(folder, { 'ok.md': 'ok', 'x.md': 'x' }), { name: `${folder}/../x.md` }),
  ],
  [
    "another folder's member",
    (folder) =>
      encodeUstar([
        ...filesIn(folder, { 'ok.md': 'ok' }),
        ...filesIn(folder.replace(/reports$/u, 'archive'), { 'x.md': 'x' }),
      ]),
  ],
  [
    'a link member',
    (folder) => forged(filesIn(folder, { 'ok.md': 'ok', 'x.md': 'x' }), { type: 0x32 }),
  ],
];
