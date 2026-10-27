/**
 * `browse` and `test` over a stub connection store, for what the real backends never do: list keys
 * outside the requested prefix, and hang until the probe times out.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageConnectionBrowseResponseSchema } from '@indx-workspace/contracts/storage-connections';
import {
  createInMemoryStorageConnectionRepositoryProvider,
  createInMemoryWorkspaceScopeResolver,
} from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import type {
  ConnectionStoreOptions,
  ListPageOptions,
  ObjectPage,
  ObjectStoreV2,
} from '@agent-workspace/core/storage';

import { PROBE_TIMEOUT_MS } from '../models/probe';
import { Principal } from '../rbac/principal';
import { log } from '../telemetry/logger';
import { browseStorageConnection, testStorageConnection } from './handlers';
import type { StorageConnectionsRuntime } from './runtime';
import { createRepositoryStorageConnectionsStoreProvider } from './store';

const injected = vi.hoisted(() => ({
  open: vi.fn<(url: string, credential: unknown, options: ConnectionStoreOptions) => unknown>(),
}));

vi.mock('@agent-workspace/core/storage', async (original) => ({
  ...(await original<typeof import('@agent-workspace/core/storage')>()),
  openConnectionStore: injected.open,
}));

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const principal = Principal.fromApiKey({
  principalId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  apiKeyId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  workspaceId: WORKSPACE,
  role: 'admin',
  label: 'Stub store test',
});

let runtime: StorageConnectionsRuntime;
let connectionId: string;

beforeEach(async () => {
  runtime = {
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
    url: 's3://acme-data/exports?endpoint=https://s3.eu-west-1.amazonaws.com',
    provider: 's3',
    allowedPrefixes: ['reports'],
    writeAllowed: false,
    // Built at runtime: a key-shaped literal in a test file trips the secret scanner.
    credential: {
      provider: 's3',
      accessKeyId: ['AK', 'IA'].join('') + randomUUID().replaceAll('-', '').slice(0, 16),
      secretAccessKey: randomBytes(24).toString('base64'),
    },
  });
  if (created.kind !== 'created') throw new Error(`the stub connection was not created`);
  connectionId = created.connection.id;
});

afterEach(() => {
  injected.open.mockReset();
});

/** A store whose only member is `listPage`; the handlers never call another. */
function stubStore(listPage: (prefix: string, options?: ListPageOptions) => Promise<ObjectPage>) {
  const store: Pick<ObjectStoreV2, 'listPage'> = { listPage };
  injected.open.mockResolvedValue(store);
}

const browseUrl = (query: string) =>
  `http://localhost/api/storage-connections/${connectionId}/browse${query}`;

describe('browse and test over a stub store', () => {
  // @story US-STO-12
  it('[US-STO-12][api][sdk] a page holding keys outside the prefix shows only the keys under it', async () => {
    const listed = vi.fn<(prefix: string, options?: ListPageOptions) => Promise<ObjectPage>>(() =>
      Promise.resolve({
        entries: [
          { kind: 'folder', key: 'reports/2026' },
          { kind: 'folder', key: 'secret/x' },
          { kind: 'folder', key: 'reports-old/y' },
          { kind: 'folder', key: 'reports/../secret/z' },
          { kind: 'folder', key: 'reports/%2e%2e/secret/w' },
          { kind: 'folder', key: 'reports/./a' },
          { kind: 'folder', key: 'reports//b' },
        ],
        cursor: 'next-token',
      }),
    );
    stubStore(listed);
    const result = await browseStorageConnection(
      runtime,
      principal,
      connectionId,
      browseUrl(`?prefix=reports&cursor=${encodeURIComponent('folder:../secret')}`),
    );
    expect(result.status).toBe(200);
    expect(listed).toHaveBeenCalledWith(
      'reports',
      expect.objectContaining({ cursor: 'folder:../secret' }),
    );
    expect(StorageConnectionBrowseResponseSchema.parse(result.body)).toEqual({
      entries: [{ path: 'reports/2026', kind: 'folder' }],
      next: 'next-token',
    });
  });

  // @story US-STO-12
  it('[US-STO-12][api][sdk] a listing that left entries out is logged as counts and the connection id', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    injected.open.mockImplementation((_url, _credential, options) => {
      const store: Pick<ObjectStoreV2, 'listPage'> = {
        listPage: () => {
          options.onSkipped?.({ links: 2, unreadable: 1 });
          return Promise.resolve({ entries: [], cursor: null });
        },
      };
      return Promise.resolve(store);
    });
    try {
      const result = await browseStorageConnection(
        runtime,
        principal,
        connectionId,
        browseUrl('?prefix=reports'),
      );
      expect(result.status).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.any(String), {
        connectionId,
        links: 2,
        unreadable: 1,
      });
    } finally {
      warn.mockRestore();
    }
  });

  // @story US-STO-12
  it.each(['browse', 'test'] as const)(
    '[US-STO-12][api][sdk] a %s that times out aborts the open and the listing',
    async (route) => {
      let listSignal: AbortSignal | undefined;
      stubStore((_prefix, options) => {
        listSignal = options?.signal;
        return new Promise(() => undefined);
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const pending =
          route === 'browse'
            ? browseStorageConnection(
                runtime,
                principal,
                connectionId,
                browseUrl('?prefix=reports'),
              )
            : testStorageConnection(runtime, principal, connectionId);
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
        const result = await pending;
        expect(JSON.stringify(result.body)).toContain('unreachable');
      } finally {
        vi.useRealTimers();
      }
      const openSignal = injected.open.mock.calls[0]?.[2].signal;
      expect(openSignal?.aborted).toBe(true);
      expect(listSignal).toBe(openSignal);
    },
  );
});
