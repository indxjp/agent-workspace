/**
 * `test` over a real GCS connection store whose bucket refuses the listing. Opening a connection
 * sends no request, so the listing's status is the outcome: the store's safe error keeps the HTTP
 * status, and nothing else, where the handler reads it. The SDK is pointed at a local server
 * through the connection store's endpoint seam, so no request leaves the machine.
 */
// @story US-STO-12
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { StorageConnectionTestOutcomeSchema } from '@indx-workspace/contracts/storage-connections';
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import { openConnectionStore } from '@agent-workspace/core/storage';

import { Principal } from '../rbac/principal';
import { testStorageConnection } from './handlers';
import type { StorageConnectionsRuntime } from './runtime';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const principal = Principal.fromApiKey({
  principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workspaceId: WORKSPACE,
  role: 'admin',
  label: 'GCS status test',
});

// The handler opens the store itself; this adds the endpoint seam to its options and nothing else.
const gcs = vi.hoisted(() => ({ apiEndpoint: '' }));
vi.mock('@agent-workspace/core/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-workspace/core/storage')>();
  return {
    ...actual,
    openConnectionStore: vi.fn<typeof actual.openConnectionStore>((url, credential, options) =>
      actual.openConnectionStore(url, credential, { ...options, gcsApiEndpoint: gcs.apiEndpoint }),
    ),
  };
});

let server: Server | undefined;
afterEach(() => {
  gcs.apiEndpoint = '';
  vi.mocked(openConnectionStore).mockClear();
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

/** A GCS API that answers every request with `status`, as Google does for a refused key. */
async function gcsAnswering(status: number): Promise<string[]> {
  const requests: string[] = [];
  server = createServer((request, response) => {
    requests.push(`${request.method ?? ''} ${request.url ?? ''}`);
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { code: status, message: 'provider words' } }));
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  gcs.apiEndpoint = `http://127.0.0.1:${String(port)}`;
  return requests;
}

async function testedOutcome(): Promise<unknown> {
  const runtime: StorageConnectionsRuntime = {
    store: createRepositoryStorageConnectionsStoreProvider({
      repositories: createInMemoryStorageConnectionRepositoryProvider(),
      scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'a' }]),
      secrets: createInMemorySecretsService(),
    }),
    fileRoots: [],
    egress: { production: true, allowHosts: [] },
    isConnectionGranted: () => Promise.resolve(false),
    audit: () => Promise.resolve(),
  };
  const created = await runtime.store.forWorkspace(WORKSPACE).create({
    name: 'acme-data',
    url: 'gcs://acme-data?project=acme-prod',
    provider: 'gcs',
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    credential: { provider: 'gcs', accessToken: `ya29.${randomUUID()}` },
  });
  if (created.kind !== 'created') throw new Error('the connection was not created');
  const result = await testStorageConnection(runtime, principal, created.connection.id);
  expect(result.status).toBe(200);
  expect(openConnectionStore).toHaveBeenCalledOnce();
  return StorageConnectionTestOutcomeSchema.parse(result.body);
}

describe('a GCS connection test', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a bucket that refuses the key answers forbidden', async () => {
    const requests = await gcsAnswering(403);
    expect(await testedOutcome()).toEqual({ ok: false, code: 'forbidden' });
    // The listing was the only request: the open read nothing.
    expect(requests).toEqual([expect.stringMatching(/^GET \/storage\/v1\/b\/acme-data\/o\?/u)]);
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a bucket that is gone answers not_found', async () => {
    await gcsAnswering(404);
    expect(await testedOutcome()).toEqual({ ok: false, code: 'not_found' });
  });
});
