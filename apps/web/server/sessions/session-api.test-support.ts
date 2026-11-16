import type { SessionStatus } from '@indx-workspace/contracts/sessions';
import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import { afterEach } from 'vitest';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';
import { sessionPageOf } from '../pagination/testing';
import type { SessionApiPrincipal } from './environment';
import { InMemoryTranscriptStore } from './memory-store';
import { createRepositorySessionsStoreProvider } from './store';
import type { TranscriptStore } from './transcript';

export const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';

export const OTHER_WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000002';

export const USER = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';

export const SESSION = '11111111-2222-4333-8444-555555555555';

export const PRINCIPAL: SessionApiPrincipal = {
  kind: 'user',
  principalId: USER,
  ownerPrincipalId: USER,
  userId: USER,
  workspaceId: WORKSPACE,
  role: 'builder',
};

const API_KEY_PRINCIPAL: SessionApiPrincipal = { ...PRINCIPAL, userId: null };

export const DEFAULTING_PRINCIPALS = [
  ['a user', PRINCIPAL],
  ['an API-key principal', API_KEY_PRINCIPAL],
] as const;

export function install(
  options: {
    authenticated?: boolean;
    store?: TranscriptStore;
    principal?: SessionApiPrincipal;
  } = {},
): {
  store: TranscriptStore;
} {
  const store = options.store ?? new InMemoryTranscriptStore();
  const principal = options.principal ?? PRINCIPAL;
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve((options.authenticated ?? true) ? principal : null),
      canAccessSession: () => Promise.resolve(true),
      store,
    },
  });
  return { store };
}

export function get(path: string): Request {
  return new Request(`https://control.example${path}`);
}

export function post(path: string, body: unknown): Request {
  return new Request(`https://control.example${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function del(path: string): Request {
  return new Request(`https://control.example${path}`, { method: 'DELETE' });
}

export function patch(path: string, body: unknown): Request {
  return new Request(`https://control.example${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function installLifecycle(status: SessionStatus = 'active') {
  const initial: SessionRecord = {
    engine: null,
    agentVersionId: null,
    id: SESSION,
    workspaceId: WORKSPACE,
    ownerPrincipalId: USER,
    userId: USER,
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: null,
    engineSessionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    title: 'First session',
    status,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };
  let row = initial;
  const provider: SessionRepositoryProvider = {
    forScope: () => ({
      ensure: () => Promise.resolve({ kind: 'existing', session: row }),
      get: (id) => Promise.resolve(id === row.id ? row : null),
      getByEngineSessionId: (id) => Promise.resolve(id === row.engineSessionId ? row : null),
      list: (input) => Promise.resolve(sessionPageOf([row], input)),
      update: (id, input) => {
        if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
        if (Object.keys(input).length === 0)
          return Promise.resolve({ kind: 'no-op', session: row });
        row = { ...row, ...input, updatedAt: new Date('2026-09-02T00:00:00Z') };
        return Promise.resolve({ kind: 'updated', session: row });
      },
      archive: (id) => {
        if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
        if (row.status === 'archived') return Promise.resolve({ kind: 'no-op', session: row });
        row = { ...row, status: 'archived' };
        return Promise.resolve({ kind: 'updated', session: row });
      },
      restore: (id) => {
        if (id !== row.id) return Promise.resolve({ kind: 'not-found' });
        if (row.status === 'active') return Promise.resolve({ kind: 'no-op', session: row });
        row = { ...row, status: 'active' };
        return Promise.resolve({ kind: 'updated', session: row });
      },
      discardIfUnused: () => Promise.resolve(false),
    }),
  };
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(PRINCIPAL),
      canAccessSession: (_principal, id) =>
        Promise.resolve(id === row.id || id === row.engineSessionId),
      store: new InMemoryTranscriptStore(),
      sessions: createRepositorySessionsStoreProvider({
        repositories: provider,
        scopes: createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'workspace' }]),
      }),
    },
  });
  return () => row;
}

export const TRANSCRIPT = `/api/sessions/${SESSION}/transcript`;

export async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? '(no code)';
}

afterEach(() => {
  clearApplicationContext();
});
