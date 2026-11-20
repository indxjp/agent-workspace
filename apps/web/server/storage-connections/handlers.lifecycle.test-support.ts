/**
 * What the storage-connection lifecycle tests share: the rotated credential, the folder seeds and
 * browse helpers, and the repository the suites run over (in memory or PostgreSQL).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeCdnUrl } from 'next/dist/server/server-utils';
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import { StorageConnectionBrowseResponseSchema } from '@indx-workspace/contracts/storage-connections';
import {
  createDatabaseStorageConnectionRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { GET as getOne } from '../../app/api/storage-connections/[id]/route';
import {
  accessKeyId,
  audits,
  connect,
  fileRoot,
  installRuntime,
  reach,
  read,
  secretAccessKey,
  WORKSPACE_A,
  WORKSPACE_B,
} from './handlers.test-support';

/** The repositories every lifecycle suite runs over. */
export const REPOSITORY_KINDS = ['memory', 'postgres'] as const;
export type RepositoryKind = (typeof REPOSITORY_KINDS)[number];

// Built at runtime, like the first credential.
const rotatedAccessKeyId = ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16);
const rotatedSecretAccessKey = randomBytes(24).toString('base64');
// A temporary (STS) credential: its session token is as secret as the key.
const rotatedSessionToken = randomBytes(32).toString('base64');
export const rotated = {
  provider: 's3',
  accessKeyId: rotatedAccessKeyId,
  secretAccessKey: rotatedSecretAccessKey,
  sessionToken: rotatedSessionToken,
};
const credentialValues = [
  accessKeyId,
  secretAccessKey,
  rotatedAccessKeyId,
  rotatedSecretAccessKey,
  rotatedSessionToken,
];

export function expectNoCredential(text: string): void {
  for (const value of credentialValues) expect(text).not.toContain(value);
}

export function readOne(id: string): Promise<Response> {
  return getOne(read(`/${id}`), { params: Promise.resolve({ id }) });
}

/** Plain files at `<dir>/<key>`, as a user's own folder holds them. */
export function seedFolder(dir: string, keys: readonly string[]): void {
  for (const key of keys) {
    mkdirSync(path.dirname(path.join(dir, key)), { recursive: true });
    writeFileSync(path.join(dir, key), key);
  }
}

/**
 * `query` as `next start` hands it to a route handler. Before the handler runs, Next rebuilds
 * `req.url`'s query from its parsed values (`normalizeCdnUrl`, called by the route module for
 * every request), so the handler never sees the bytes the client sent: `%20` arrives as `+`.
 */
function servedByNext(query: string): string {
  const message = new IncomingMessage(new Socket());
  message.url = `/browse${query}`;
  normalizeCdnUrl(message, []);
  return (message.url ?? '').slice('/browse'.length);
}

/** `browse` reached both as the bare handler is called and as `next start` serves it. */
export async function browseBothWays(id: string, query: string): Promise<Response[]> {
  return [await reach('browse', id, query), await reach('browse', id, servedByNext(query))];
}

/** A `file` connection over a folder holding `reports/`, `reports-old/` and `secret/`. */
export async function connectFolder(name: string): Promise<string> {
  const dir = path.join(fileRoot, name);
  mkdirSync(dir);
  seedFolder(dir, ['reports/a.txt', 'reports/2026/b.txt', 'reports-old/c.txt', 'secret/d.txt']);
  return connect({ name, url: pathToFileURL(dir).href, allowedPrefixes: ['reports'] });
}

export async function browsedPaths(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  const page = StorageConnectionBrowseResponseSchema.parse(await response.json());
  return page.entries.map((entry) => entry.path);
}

export const testedAudits = () =>
  audits.filter((event) => event['action'] === 'storage-connection-tested');

/** Runs the suite over `kind`: PostgreSQL gets an isolated database, memory the default runtime. */
export function useLifecycleRepository(kind: RepositoryKind): void {
  let isolated: IsolatedTestDatabase | undefined;

  // A missing TEST_DATABASE_URL makes this throw: the suite fails instead of skipping.
  beforeAll(async () => {
    if (kind !== 'postgres') return;
    isolated = await createIsolatedTestDatabase('aw_storage_lifecycle');
    await isolated.db.insert(workspaces).values([
      { id: WORKSPACE_A, slug: 'lifecycle-a', name: 'A' },
      { id: WORKSPACE_B, slug: 'lifecycle-b', name: 'B' },
    ]);
  }, 180_000);

  afterAll(async () => {
    await isolated?.close();
  });

  beforeEach(() => {
    if (isolated === undefined) return;
    installRuntime(
      createDatabaseStorageConnectionRepositoryProvider(isolated.db),
      createDatabaseWorkspaceScopeResolver(isolated.db),
    );
  });
}
