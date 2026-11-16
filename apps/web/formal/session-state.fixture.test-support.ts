import { clearApplicationContext } from '../server/application-context';
import { installTestDomains } from '../server/application-context-fixtures';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createInMemoryWorkspaceScopeResolver,
  type SessionRecord,
  type SessionRepositoryProvider,
} from '@agent-workspace/core/db';
import {
  agents,
  createDatabaseSessionStateRepositoryProvider,
  createDatabaseSessionTranscriptRepositoryProvider,
  createDatabaseWorkspaceScopeResolver,
  createIsolatedTestDatabase,
  memberships,
  sessionStateBlobs,
  sessionStateStreams,
  sessionTranscripts,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { afterEach } from 'vitest';
import { asRecord, asString } from '../../../tests/formal/vectors.js';
import { createInMemoryObjectStore } from '@agent-workspace/core/storage';
import type { Logger } from '@agent-workspace/core/telemetry';
import type { SessionApiPrincipal } from '../server/sessions/environment';
import { InMemoryTranscriptStore } from '../server/sessions/memory-store';
import type { SessionStateStore } from '../server/sessions/state';
import { InMemorySessionStateStore } from '../server/sessions/state-memory-store';
import {
  DatabaseSessionStateStore,
  DatabaseTranscriptStore,
  createRepositorySessionsStoreProvider,
} from '../server/sessions/store';
import type { TranscriptStore } from '../server/sessions/transcript';
import { createStorageService } from '../server/storage/service';

export const silentLog: Logger = {
  info() {},
  warn() {},
  error() {},
  child: () => silentLog,
};

export const FAMILY = 'session-state';

export const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';

export const OTHER_WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000002';

export const USER = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';

export const SESSION = '11111111-2222-4333-8444-555555555555';

export const OTHER_SESSION = '22222222-3333-4444-8555-666666666666';

export const ENGINE = 'claude-agent-sdk';

export const STREAM = `${WORKSPACE}/`;

export const WORKSPACES: Readonly<Record<string, string>> = { w1: WORKSPACE, w2: OTHER_WORKSPACE };

export const SESSIONS: Readonly<Record<string, string>> = { se1: SESSION, se2: OTHER_SESSION };

export function mapped(
  table: Readonly<Record<string, string>>,
  symbol: string,
  what: string,
): string {
  const found = table[symbol];
  if (found === undefined)
    throw new Error(`${what}: the vectors name ${symbol}, which this replay does not map`);
  return found;
}

export function mappedStreamKey(streamKey: string): string {
  const slash = streamKey.indexOf('/');
  if (slash < 0) return streamKey;
  const workspace = WORKSPACES[streamKey.slice(0, slash)];
  return workspace === undefined ? streamKey : `${workspace}${streamKey.slice(slash)}`;
}

export function row(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: SESSION,
    workspaceId: WORKSPACE,
    ownerPrincipalId: USER,
    userId: USER,
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    projectId: null,
    engineSessionId: SESSION,
    engine: ENGINE,
    agentVersionId: null,
    title: 'formal',
    status: 'active',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

export function repositoryOf(session: SessionRecord): SessionRepositoryProvider {
  return {
    forScope: () => ({
      ensure: () => Promise.resolve({ kind: 'existing', session }),
      get: (id) => Promise.resolve(id === session.id ? session : null),
      getByEngineSessionId: (id) =>
        Promise.resolve(id === session.engineSessionId ? session : null),
      list: () => Promise.resolve({ items: [session], nextCursor: null }),
      update: () => Promise.resolve({ kind: 'no-op', session }),
      archive: () => Promise.resolve({ kind: 'no-op', session }),
      restore: () => Promise.resolve({ kind: 'no-op', session }),
      discardIfUnused: () => Promise.resolve(false),
    }),
  };
}

export interface Backend {
  readonly name: string;
  fresh(): Promise<{
    readonly stateStore: SessionStateStore;
    readonly legacy: TranscriptStore;
    readonly database?: IsolatedTestDatabase;
  }>;
}

export const inMemory: Backend = {
  name: 'in memory',
  fresh: () =>
    Promise.resolve({
      stateStore: new InMemorySessionStateStore(),
      legacy: new InMemoryTranscriptStore(),
    }),
};

export const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATION_0027 = path.resolve(
  HERE,
  '../../../migrations/0027_backfill_claude_session_state.sql',
);

export const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

export function postgresBackend(): Backend & {
  open(): Promise<void>;
  close(): Promise<void>;
} {
  let isolated: IsolatedTestDatabase | undefined;
  const database = (): IsolatedTestDatabase => {
    if (isolated === undefined) throw new Error('the PostgreSQL backend was used before open()');
    return isolated;
  };
  return {
    name: 'on PostgreSQL',
    async open() {
      isolated = await createIsolatedTestDatabase('aw_formal_session_state');
      const db = isolated.db;
      const userId = crypto.randomUUID();
      const membershipId = crypto.randomUUID();
      const principalId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      await db.insert(workspaces).values([
        { id: WORKSPACE, slug: WORKSPACE, name: 'Formal one' },
        { id: OTHER_WORKSPACE, slug: OTHER_WORKSPACE, name: 'Formal two' },
      ]);
      await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: 'Owner' });
      await db.transaction(async (tx) => {
        await tx
          .insert(memberships)
          .values({ id: membershipId, workspaceId: WORKSPACE, userId, role: 'owner' });
        await tx.insert(workspacePrincipals).values({
          id: principalId,
          workspaceId: WORKSPACE,
          kind: 'membership',
          membershipId,
        });
      });
      await db.insert(agents).values({
        id: agentId,
        workspaceId: WORKSPACE,
        name: 'Formal',
        instructions: '',
        ownerPrincipalId: principalId,
        createdBy: userId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await db.insert(sessions).values({
        id: SESSION,
        workspaceId: WORKSPACE,
        userId,
        ownerPrincipalId: principalId,
        agentId,
        engineSessionId: SESSION,
        engine: ENGINE,
      });
    },
    async close() {
      await isolated?.close();
    },
    async fresh() {
      const found = database();
      // Entries cascade from their stream, and messages from their transcript.
      await found.db.delete(sessionStateStreams);
      await found.db.delete(sessionStateBlobs);
      await found.db.delete(sessionTranscripts);
      const scopes = createDatabaseWorkspaceScopeResolver(found.db);
      const repositories = createDatabaseSessionStateRepositoryProvider(found.db);
      const storage = createStorageService({
        catalog: () => Promise.reject(new Error('the files catalog is not used here')),
        objects: createInMemoryObjectStore(),
        sessionState: async (workspaceId) => {
          const scope = await scopes.forWorkspaceId(workspaceId);
          if (scope === null) throw new Error('the workspace did not resolve');
          return repositories.forScope(scope);
        },
        log: silentLog,
      });
      return {
        stateStore: new DatabaseSessionStateStore({ repositories, scopes, storage }),
        legacy: new DatabaseTranscriptStore(
          createDatabaseSessionTranscriptRepositoryProvider(found.db),
          scopes,
        ),
        database: found,
      };
    },
  };
}

export async function install(
  backend: Backend,
  options: {
    readonly principal: SessionApiPrincipal;
    readonly session: SessionRecord;
  },
): Promise<Awaited<ReturnType<Backend['fresh']>>> {
  const fresh = await backend.fresh();
  installTestDomains({
    sessions: {
      authenticate: () => Promise.resolve(options.principal),
      canAccessSession: (caller, id) =>
        Promise.resolve(
          caller.kind === 'runner'
            ? caller.sessionId === id && caller.workspaceId === options.session.workspaceId
            : caller.workspaceId === options.session.workspaceId,
        ),
      store: fresh.legacy,
      stateStore: fresh.stateStore,
      sessions: createRepositorySessionsStoreProvider({
        repositories: repositoryOf(options.session),
        scopes: createInMemoryWorkspaceScopeResolver([
          { id: WORKSPACE, slug: 'one' },
          { id: OTHER_WORKSPACE, slug: 'two' },
        ]),
      }),
    },
  });
  return fresh;
}

export const OWN_RUNNER: SessionApiPrincipal = {
  kind: 'runner',
  workspaceId: WORKSPACE,
  runId: USER,
  sessionId: SESSION,
};

export function installOwnSession(
  backend: Backend,
): Promise<Awaited<ReturnType<Backend['fresh']>>> {
  return install(backend, { principal: OWN_RUNNER, session: row() });
}

afterEach(() => {
  clearApplicationContext();
});

export function entriesUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ engine: ENGINE, streamKey: STREAM, ...query });
  return `https://control.example/api/sessions/${SESSION}/state-entries?${params.toString()}`;
}

export function jsonRequest(method: string, body: unknown): Request {
  return new Request(`https://control.example/api/sessions/${SESSION}/state-entries`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function wireEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const entryKey = entry['entryKey'];
  const payload = asString(entry['payload'], 'entry payload');
  if (entryKey === null || entryKey === undefined) return { entry: { type: 'user', payload } };
  // Shaped the way the runner's Claude client sends it: the key is the entry's own `uuid`.
  const key = asString(entryKey, 'entryKey');
  return { entryKey: key, entry: { type: 'user', uuid: key, payload } };
}

export function modelEntries(body: unknown): { entryKey: string | null; payload: string }[] {
  const record = asRecord(body, 'the listing');
  const rows = record['entries'];
  if (!Array.isArray(rows)) throw new Error('the listing carried no entries array');
  return rows.map((raw, index) => {
    const found = asRecord(raw, `entries[${String(index)}]`);
    const entry = asRecord(found['entry'], `entries[${String(index)}].entry`);
    const entryKey = found['entryKey'];
    return {
      entryKey: entryKey === null ? null : asString(entryKey, 'entryKey'),
      payload: asString(entry['payload'], 'payload'),
    };
  });
}

export function transcriptUrl(): string {
  return `https://control.example/api/sessions/${SESSION}/transcript`;
}

export function transcriptEntries(body: unknown): { entryKey: string | null; payload: string }[] {
  const rows = asRecord(body, 'the transcript')['entries'];
  if (!Array.isArray(rows)) throw new Error('the transcript carried no entries array');
  return rows.map((raw, index) => {
    const entry = asRecord(raw, `entries[${String(index)}]`);
    const uuid = entry['uuid'];
    return {
      entryKey: uuid === undefined ? null : asString(uuid, 'uuid'),
      payload: asString(entry['payload'], 'payload'),
    };
  });
}
