/**
 * The `session-state` vectors, replayed against the **routes and the store** (ENG-06, #305).
 *
 * Decision D-012: a suite that imports application code lives with the application. This one drives
 * `apps/web/server/sessions/state-api.ts` and `apps/web/server/sessions/state.ts` — the handlers a
 * runner actually calls — and compares what they do to what
 * `formal/AgentWorkspace/Behaviour/SessionState.lean` says they must. A disagreement is a failing
 * test, and the fix is never to edit a vector (`docs/formal/00-orchestrator-prompt.md` §10).
 *
 * Five of the family's seven files are replayed here:
 *
 *   * `operations.json` — append, replace-all, delete-last and delete-stream over one stream;
 *   * `access.json` — which streams a run token reaches, and on which engine;
 *   * `blobs.json` — the size cap;
 *   * `migration.json` — the fold `0027`'s `SELECT` performs, against the store's own read;
 *   * `transcript-read.json` — the public `GET …/transcript`, served from the store with the legacy
 *     tables as the per-stream fallback (ADR-0071, the Owner's decision on #305).
 *
 * The other two (`durability.json`, `stream-keys.json`) are about the runner's client and are
 * replayed by `apps/runner/formal/session-store-client.test.ts`.
 *
 * ## Two backends, the same vectors
 *
 * Every vector is replayed twice: over `InMemorySessionStateStore`, which runs everywhere, and over
 * `DatabaseSessionStateStore` on `createDatabaseSessionStateRepositoryProvider` against PostgreSQL,
 * which #305 requires and which runs wherever `TEST_DATABASE_URL` is set (CI always sets it). The
 * PostgreSQL half of `migration.json` does what the in-memory half cannot: it writes each vector's
 * deliveries into the legacy `session_transcripts`/`session_messages` tables, reads them back
 * through the public `GET …/transcript` (the legacy fold), executes `0027`'s own SQL — the
 * `DISTINCT ON … ORDER BY sequence DESC` and the `dense_rank()` the T4 refinement is about — and reads
 * the result back through both the state route and `GET …/transcript`, so the model and the SQL are
 * compared directly.
 *
 * The session row itself comes from a fixture repository on both backends: the access vectors pin a
 * session to engines the closed `ENGINE_IDS` set (and so the `sessions.engine` CHECK) cannot carry,
 * which is exactly the state the engine check exists for.
 */
import { clearApplicationContext } from '../server/application-context';
import { installTestDomains } from '../server/application-context-fixtures';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  sessionMessages,
  sessionStateBlobs,
  sessionStateStreams,
  sessionTranscripts,
  sessions,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors.js';
import { createLocalFilesystemObjectStoreProvider } from '@agent-workspace/core/storage';
import { loadTranscript } from '../server/sessions/api';
import type { SessionApiPrincipal } from '../server/sessions/environment';
import { InMemoryTranscriptStore } from '../server/sessions/memory-store';
import type { SessionStateStore } from '../server/sessions/state';
import { InMemorySessionStateStore } from '../server/sessions/state-memory-store';
import {
  DatabaseSessionStateStore,
  DatabaseTranscriptStore,
  createRepositorySessionsStoreProvider,
} from '../server/sessions/store';
import {
  appendSessionState,
  deleteSessionState,
  listSessionStateEntries,
  putSessionStateBlob,
  replaceSessionState,
} from '../server/sessions/state-api';
import type { TranscriptStore } from '../server/sessions/transcript';

const FAMILY = 'session-state';
const WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000001';
const OTHER_WORKSPACE = 'c8b1f0de-6a2e-4a1f-9d3b-000000000002';
const USER = 'c8b1f0de-6a2e-4a1f-9d3b-000000000009';
const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION = '22222222-3333-4444-8555-666666666666';
const ENGINE = 'claude-agent-sdk';
const STREAM = `${WORKSPACE}/`;

/**
 * The model's symbolic ids, as this deployment spells them.
 *
 * The vectors talk about `w1`/`se1`, because the Lean model has no reason to know what a UUID is.
 * The replay is about the *decisions*, so the two vocabularies are joined here, once, rather than by
 * making the model carry identifiers it does not use.
 */
const WORKSPACES: Readonly<Record<string, string>> = { w1: WORKSPACE, w2: OTHER_WORKSPACE };
const SESSIONS: Readonly<Record<string, string>> = { se1: SESSION, se2: OTHER_SESSION };

function mapped(table: Readonly<Record<string, string>>, symbol: string, what: string): string {
  const found = table[symbol];
  if (found === undefined)
    throw new Error(`${what}: the vectors name ${symbol}, which this replay does not map`);
  return found;
}

/**
 * A vector's stream key with its project-key segment mapped the way the workspace is. The model's
 * project key is its workspace symbol (`w1/…`); a segment the table does not name — a `cwd`-derived
 * key, which is what the project-key guard refuses — is passed through unchanged.
 */
function mappedStreamKey(streamKey: string): string {
  const slash = streamKey.indexOf('/');
  if (slash < 0) return streamKey;
  const workspace = WORKSPACES[streamKey.slice(0, slash)];
  return workspace === undefined ? streamKey : `${workspace}${streamKey.slice(slash)}`;
}

function row(overrides: Partial<SessionRecord> = {}): SessionRecord {
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

function repositoryOf(session: SessionRecord): SessionRepositoryProvider {
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

/**
 * Where one replay keeps its state: a fresh, empty store pair for every scenario.
 *
 * `legacy` is the pre-ENG-06 `TranscriptStore` the public `GET …/transcript` falls back to.
 * `database` is present on the PostgreSQL backend only, for the migration replay's raw SQL.
 */
interface Backend {
  readonly name: string;
  fresh(): Promise<{
    readonly stateStore: SessionStateStore;
    readonly legacy: TranscriptStore;
    readonly database?: IsolatedTestDatabase;
  }>;
}

const inMemory: Backend = {
  name: 'in memory',
  fresh: () =>
    Promise.resolve({
      stateStore: new InMemorySessionStateStore(),
      legacy: new InMemoryTranscriptStore(),
    }),
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0027 = path.resolve(
  HERE,
  '../../../migrations/0027_backfill_claude_session_state.sql',
);
const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

/**
 * The PostgreSQL backend: one isolated, fully migrated database for the file, seeded with the two
 * workspaces and the one session row the vectors' `stored` outcomes land in, and emptied of every
 * session-state and legacy transcript row before each scenario.
 */
function postgresBackend(): Backend & {
  open(): Promise<void>;
  close(): Promise<void>;
} {
  let isolated: IsolatedTestDatabase | undefined;
  const blobRoot = mkdtempSync(path.join(tmpdir(), 'aw-formal-session-state-'));
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
      rmSync(blobRoot, { recursive: true, force: true });
    },
    async fresh() {
      const found = database();
      // Entries cascade from their stream, and messages from their transcript.
      await found.db.delete(sessionStateStreams);
      await found.db.delete(sessionStateBlobs);
      await found.db.delete(sessionTranscripts);
      const scopes = createDatabaseWorkspaceScopeResolver(found.db);
      return {
        stateStore: new DatabaseSessionStateStore({
          repositories: createDatabaseSessionStateRepositoryProvider(found.db),
          scopes,
          blobs: createLocalFilesystemObjectStoreProvider(blobRoot),
        }),
        legacy: new DatabaseTranscriptStore(
          createDatabaseSessionTranscriptRepositoryProvider(found.db),
          scopes,
        ),
        database: found,
      };
    },
  };
}

/**
 * Install the API for one scenario.
 *
 * `canAccessSession` is the production rule, restated: a runner reaches the exact session named in
 * its signed claim and no other. Substituting a permissive one here would make every `access.json`
 * vector pass without the check the vectors are about.
 */
async function install(
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

const OWN_RUNNER: SessionApiPrincipal = {
  kind: 'runner',
  workspaceId: WORKSPACE,
  runId: USER,
  sessionId: SESSION,
};

function installOwnSession(backend: Backend): Promise<Awaited<ReturnType<Backend['fresh']>>> {
  return install(backend, { principal: OWN_RUNNER, session: row() });
}

afterEach(() => {
  clearApplicationContext();
});

function entriesUrl(query: Record<string, string> = {}): string {
  const params = new URLSearchParams({ engine: ENGINE, streamKey: STREAM, ...query });
  return `https://control.example/api/sessions/${SESSION}/state-entries?${params.toString()}`;
}

function jsonRequest(method: string, body: unknown): Request {
  return new Request(`https://control.example/api/sessions/${SESSION}/state-entries`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** One entry of the model, as the wire spells it. `payload` becomes the opaque entry document. */
function wireEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const entryKey = entry['entryKey'];
  const payload = asString(entry['payload'], 'entry payload');
  if (entryKey === null || entryKey === undefined) return { entry: { type: 'user', payload } };
  // Shaped the way the runner's Claude client sends it: the key is the entry's own `uuid`.
  const key = asString(entryKey, 'entryKey');
  return { entryKey: key, entry: { type: 'user', uuid: key, payload } };
}

/** What the store holds, rendered back into the model's own vocabulary. */
function modelEntries(body: unknown): { entryKey: string | null; payload: string }[] {
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

function transcriptUrl(): string {
  return `https://control.example/api/sessions/${SESSION}/transcript`;
}

/** The public transcript read, rendered back into the model's vocabulary. */
function transcriptEntries(body: unknown): { entryKey: string | null; payload: string }[] {
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

/**
 * Write one vector's deliveries into the legacy pair exactly as the pre-ENG-06 repository stored
 * them: one `session_transcripts` row, and one `session_messages` row per delivery carrying its own
 * `sequence` and the `position` of the entry's first delivery.
 */
function parseDelivery(raw: unknown, index: number) {
  const delivery = asRecord(raw, `deliveries[${String(index)}]`);
  const sequence = delivery['sequence'];
  const position = delivery['position'];
  if (typeof sequence !== 'number' || typeof position !== 'number') {
    throw new Error(`deliveries[${String(index)}]: sequence and position must be numbers`);
  }
  const uuid = delivery['entryUuid'];
  const entryUuid = uuid === null || uuid === undefined ? null : asString(uuid, 'entryUuid');
  const payload = asString(delivery['payload'], 'payload');
  // The entry an Agent SDK mirror would have sent: `uuid` when the entry has one.
  const entry =
    entryUuid === null ? { type: 'user', payload } : { type: 'user', uuid: entryUuid, payload };
  return { sequence, position, entryUuid, entry };
}

async function seedLegacy(database: IsolatedTestDatabase, deliveries: unknown[]): Promise<void> {
  await database.db
    .insert(sessionTranscripts)
    .values({ workspaceId: WORKSPACE, projectKey: WORKSPACE, sessionId: SESSION, subpath: '' });
  if (deliveries.length === 0) return;
  await database.db.insert(sessionMessages).values(
    deliveries.map((raw, index) => {
      const delivery = parseDelivery(raw, index);
      return {
        workspaceId: WORKSPACE,
        projectKey: WORKSPACE,
        sessionId: SESSION,
        subpath: '',
        // Both columns are `bigint`, as the pre-ENG-06 schema declares them.
        sequence: BigInt(delivery.sequence),
        position: BigInt(delivery.position),
        entryUuid: delivery.entryUuid,
        entry: delivery.entry,
      };
    }),
  );
}

/**
 * The same deliveries through the legacy `TranscriptStore` itself, in delivery order — what the
 * pre-ENG-06 mirror did, one batch per delivery. Used where there is no database to seed.
 */
async function appendLegacy(legacy: TranscriptStore, deliveries: unknown[]): Promise<void> {
  const key = { projectKey: WORKSPACE, sessionId: SESSION };
  const parsed = deliveries.map((raw, index) => parseDelivery(raw, index));
  parsed.sort((left, right) => left.sequence - right.sequence);
  await legacy.append(key, []);
  for (const one of parsed) await legacy.append(key, [one.entry]);
}

/** Execute `migrations/0027_*.sql` itself, statement by statement, as the migrator does. */
async function runMigration0027(database: IsolatedTestDatabase): Promise<void> {
  const statements = readFileSync(MIGRATION_0027, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  expect(statements.length).toBe(2);
  for (const statement of statements) await database.db.execute(sql.raw(statement));
}

function replay(backend: Backend): void {
  describe(`session-state: the operations, ${backend.name}`, () => {
    const vectors = loadVectors(FAMILY, 'operations.json');

    it.each(vectors)('$id', async ({ id, input, expected }) => {
      await installOwnSession(backend);
      const operations = asRecord(input, id)['operations'];
      if (!Array.isArray(operations)) throw new Error(`${id}: no operations`);
      for (const [index, raw] of operations.entries()) {
        const operation = asRecord(raw, `${id}.operations[${String(index)}]`);
        const entries = Array.isArray(operation['entries'])
          ? operation['entries'].map((entry, at) =>
              wireEntry(asRecord(entry, `${id}.entries[${String(at)}]`)),
            )
          : [];
        const body = { engine: ENGINE, streamKey: STREAM, entries };
        const response =
          operation['op'] === 'append'
            ? await appendSessionState(jsonRequest('POST', body), SESSION)
            : operation['op'] === 'replace-all'
              ? await replaceSessionState(jsonRequest('PUT', body), SESSION)
              : operation['op'] === 'delete-last'
                ? await deleteSessionState(
                    new Request(entriesUrl({ last: '1' }), { method: 'DELETE' }),
                    SESSION,
                  )
                : await deleteSessionState(
                    new Request(entriesUrl(), { method: 'DELETE' }),
                    SESSION,
                  );
        expect(response.status, `${id}: operation ${String(index)}`).toBe(204);
      }

      const read = await listSessionStateEntries(new Request(entriesUrl()), SESSION);
      const answer = asRecord(expected, id)['entries'];
      if (answer === null) {
        // `null` is the model saying the stream was never written, which the route answers as a 404.
        // A 200 with an empty list is a different fact, and the two must not collapse.
        expect(read.status).toBe(404);
        return;
      }
      expect(read.status).toBe(200);
      expect(modelEntries(await read.json())).toEqual(answer);
    });

    it('replayed the cases an upsert is actually got wrong on', () => {
      const ids = vectors.map((vector) => vector.id);
      expect(ids).toContain('redelivery-upserts-in-place');
      expect(ids).toContain('keyless-entries-are-never-deduped');
      expect(ids).toContain('delete-stream-is-not-an-empty-stream');
    });
  });

  describe(`session-state: who may touch a stream, and on which engine, ${backend.name}`, () => {
    const vectors = loadVectors(FAMILY, 'access.json');

    it.each(vectors)('$id', async ({ id, input, expected }) => {
      const request = asRecord(input, id);
      const token = asRecord(request['token'], `${id}.token`);
      const stream = asRecord(request['stream'], `${id}.stream`);
      const pinned = request['pinnedEngine'];
      const streamWorkspace = mapped(WORKSPACES, asString(stream['workspace'], id), id);
      const streamSession = mapped(SESSIONS, asString(stream['session'], id), id);

      await install(backend, {
        principal: {
          kind: 'runner',
          workspaceId: mapped(WORKSPACES, asString(token['workspace'], id), id),
          runId: USER,
          sessionId: mapped(SESSIONS, asString(token['session'], id), id),
        },
        session: row({
          id: streamSession,
          engineSessionId: streamSession,
          workspaceId: streamWorkspace,
          // The vectors name an engine the closed set may not carry; the cast is the narrowest way to
          // express "a row written by a release whose engine set was larger", which is the state the
          // engine check exists for.
          engine: pinned === null ? null : (asString(pinned, id) as SessionRecord['engine']),
        }),
      });

      const response = await appendSessionState(
        new Request(`https://control.example/api/sessions/${streamSession}/state-entries`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            engine: asString(stream['engine'], id),
            streamKey: mappedStreamKey(asString(stream['streamKey'], id)),
            entries: [{ entryKey: 'a', entry: { payload: 'first' } }],
          }),
        }),
        streamSession,
      );

      const answer = asRecord(expected, id);
      if (answer['outcome'] === 'stored') {
        expect(response.status).toBe(204);
        return;
      }
      expect(response.status).toBe(answer['status']);
      expect(await response.json()).toMatchObject({ error: { code: answer['code'] } });
    });

    it('replayed a refusal that must not become an oracle', () => {
      // A stream of another session AND another engine answers `notFound`, not `engineMismatch`:
      // otherwise the engine refusal tells a caller that a session it may not see exists.
      expect(vectors.map((vector) => vector.id)).toContain('another-session-of-another-engine');
    });

    it('replayed the Claude project-key guard, both ways', () => {
      const ids = vectors.map((vector) => vector.id);
      expect(ids).toContain('claude-key-outside-the-project-key');
      expect(ids).toContain('another-session-outside-the-project-key');
    });
  });

  describe(`session-state: the blob cap, ${backend.name}`, () => {
    const vectors = loadVectors(FAMILY, 'blobs.json');

    it.each(vectors)('$id', async ({ id, input, expected }) => {
      await installOwnSession(backend);
      const size = asRecord(input, id)['sizeBytes'];
      if (typeof size !== 'number') throw new Error(`${id}: sizeBytes is not a number`);
      const params = new URLSearchParams({ engine: ENGINE, blobKey: 'state.tar' });
      // The declared length is what a request over the cap is refused on without reading it; the
      // route's own suite drives the streaming half, which cannot be replayed at 32 MiB here.
      const response = await putSessionStateBlob(
        new Request(
          `https://control.example/api/sessions/${SESSION}/state-blobs?${params.toString()}`,
          {
            method: 'PUT',
            headers: { 'content-length': String(size) },
            body: new Uint8Array(Math.min(size, 8)),
          },
        ),
        SESSION,
      );
      const answer = asRecord(expected, id);
      if (answer['outcome'] === 'stored') {
        expect(response.status).toBe(204);
        return;
      }
      expect(response.status).toBe(answer['status']);
      expect(await response.json()).toMatchObject({ error: { code: answer['code'] } });
    });

    it('replayed the boundary, not only a value well inside it', () => {
      const ids = vectors.map((vector) => vector.id);
      expect(ids).toContain('exactly-the-cap');
      expect(ids).toContain('one-byte-over');
    });
  });

  describe(`session-state: the migration lands a transcript the store can read back, ${backend.name}`, () => {
    const vectors = loadVectors(FAMILY, 'migration.json');

    it.each(vectors)('$id', async ({ id, input, expected }) => {
      const answer = asRecord(expected, id);
      const migrated = answer['migrated'];
      const legacy = answer['legacyLoad'];
      // The model's own claim first: the two folds agree. `session-state-migration.test.ts` is what
      // replays it against real PostgreSQL; this is the same equality over the vector.
      expect(migrated).toEqual(legacy);
      if (!Array.isArray(migrated)) throw new Error(`${id}: migrated is not an array`);

      const { database } = await installOwnSession(backend);
      if (database === undefined) {
        // In memory there is no SQL to run, so the store is handed the model's migrated history and
        // must read it back unchanged through the route a resume uses.
        const replaced = await replaceSessionState(
          jsonRequest('PUT', {
            engine: ENGINE,
            streamKey: STREAM,
            entries: migrated.map((entry, index) =>
              wireEntry(asRecord(entry, `${id}[${String(index)}]`)),
            ),
          }),
          SESSION,
        );
        expect(replaced.status).toBe(204);
      } else {
        // On PostgreSQL the legacy tables are written the way the pre-ENG-06 release wrote them, the
        // public read is checked against the model's legacy fold, and then 0027 itself does the fold.
        const deliveries = asRecord(input, id)['deliveries'];
        if (!Array.isArray(deliveries)) throw new Error(`${id}: no deliveries`);
        await seedLegacy(database, deliveries);
        const before = await loadTranscript(new Request(transcriptUrl()), SESSION);
        expect(before.status, `${id}: the legacy read before 0027`).toBe(200);
        expect(transcriptEntries(await before.json())).toEqual(legacy);
        await runMigration0027(database);
      }
      const read = await listSessionStateEntries(new Request(entriesUrl()), SESSION);
      expect(read.status).toBe(200);
      expect(modelEntries(await read.json())).toEqual(migrated);
      // …and the public transcript read, which now serves the engine-scoped store, answers the same.
      const transcript = await loadTranscript(new Request(transcriptUrl()), SESSION);
      expect(transcript.status).toBe(200);
      expect(transcriptEntries(await transcript.json())).toEqual(migrated);
    });
  });

  describe(`session-state: the public transcript read, over both stores, ${backend.name}`, () => {
    const vectors = loadVectors(FAMILY, 'transcript-read.json');

    it.each(vectors)('$id', async ({ id, input, expected }) => {
      const fresh = await installOwnSession(backend);
      const args = asRecord(input, id);
      const stored = args['storeEntries'];
      if (Array.isArray(stored)) {
        // Written the way a post-ENG-06 runner writes it: through the state route.
        const replaced = await replaceSessionState(
          jsonRequest('PUT', {
            engine: ENGINE,
            streamKey: STREAM,
            entries: stored.map((entry, index) =>
              wireEntry(asRecord(entry, `${id}.storeEntries[${String(index)}]`)),
            ),
          }),
          SESSION,
        );
        expect(replaced.status).toBe(204);
      }
      const deliveries = args['legacyDeliveries'];
      if (Array.isArray(deliveries)) {
        if (fresh.database === undefined) await appendLegacy(fresh.legacy, deliveries);
        else await seedLegacy(fresh.database, deliveries);
      }

      const response = await loadTranscript(new Request(transcriptUrl()), SESSION);
      const answer = asRecord(expected, id)['entries'];
      if (answer === null) {
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'transcript_not_found' } });
        return;
      }
      expect(response.status).toBe(200);
      expect(transcriptEntries(await response.json())).toEqual(answer);
    });

    it('replayed both arms of the fallback and the answer neither store has', () => {
      const ids = vectors.map((vector) => vector.id);
      expect(ids).toContain('the-store-wins-over-the-legacy-tables');
      expect(ids).toContain('a-pre-eng06-session-falls-back');
      expect(ids).toContain('neither-store-has-it');
    });
  });
}

describe('session-state vectors, in memory', () => {
  replay(inMemory);
});

describe.skipIf(!hasDatabase)('session-state vectors, on PostgreSQL', () => {
  const backend = postgresBackend();
  beforeAll(() => backend.open(), 120_000);
  afterAll(() => backend.close());
  replay(backend);
});
