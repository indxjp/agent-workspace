import { replayMigration } from './session-state.migration.test-support';
import { type SessionRecord } from '@agent-workspace/core/db';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors.js';
import { loadTranscript } from '../server/sessions/api';
import {
  appendSessionState,
  deleteSessionState,
  listSessionStateEntries,
  putSessionStateBlob,
  replaceSessionState,
} from '../server/sessions/state-api';
import {
  FAMILY,
  USER,
  SESSION,
  ENGINE,
  STREAM,
  WORKSPACES,
  SESSIONS,
  mapped,
  mappedStreamKey,
  row,
  type Backend,
  inMemory,
  hasDatabase,
  postgresBackend,
  install,
  installOwnSession,
  entriesUrl,
  jsonRequest,
  wireEntry,
  modelEntries,
  transcriptUrl,
  transcriptEntries,
} from './session-state.fixture.test-support';
import { seedLegacy, appendLegacy } from './session-state.legacy.test-support';
function replayOperations(backend: Backend): void {
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
        const response = await applyStateOperation(operation, entries);
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
}
function replayAccess(backend: Backend): void {
  describe(`session-state: who may touch a stream, and on which engine, ${backend.name}`, () => {
    const vectors = loadVectors(FAMILY, 'access.json');

    it.each(vectors)('$id', async ({ id, input, expected }) => {
      const { stream, streamSession, installation } = accessIdentity(input, id);
      await install(backend, installation);

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

      await expectWriteOutcome(response, asRecord(expected, id));
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
}
function replayBlobCap(backend: Backend): void {
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
      await expectWriteOutcome(response, asRecord(expected, id));
    });

    it('replayed the boundary, not only a value well inside it', () => {
      const ids = vectors.map((vector) => vector.id);
      expect(ids).toContain('exactly-the-cap');
      expect(ids).toContain('one-byte-over');
    });
  });
}
function replayTranscript(backend: Backend): void {
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
function replay(backend: Backend): void {
  replayOperations(backend);
  replayAccess(backend);
  replayBlobCap(backend);
  replayMigration(backend);
  replayTranscript(backend);
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

function accessIdentity(
  input: unknown,
  id: string,
): {
  stream: Record<string, unknown>;
  streamSession: string;
  installation: Parameters<typeof install>[1];
} {
  const request = asRecord(input, id);
  const token = asRecord(request['token'], `${id}.token`);
  const stream = asRecord(request['stream'], `${id}.stream`);
  const pinned = request['pinnedEngine'];
  const streamWorkspace = mapped(WORKSPACES, asString(stream['workspace'], id), id);
  const streamSession = mapped(SESSIONS, asString(stream['session'], id), id);
  return {
    stream,
    streamSession,
    installation: {
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
    },
  };
}

async function applyStateOperation(
  operation: Record<string, unknown>,
  entries: ReturnType<typeof wireEntry>[],
): Promise<Response> {
  const body = { engine: ENGINE, streamKey: STREAM, entries };
  switch (operation['op']) {
    case 'append':
      return appendSessionState(jsonRequest('POST', body), SESSION);
    case 'replace-all':
      return replaceSessionState(jsonRequest('PUT', body), SESSION);
    case 'delete-last':
      return deleteSessionState(
        new Request(entriesUrl({ last: '1' }), { method: 'DELETE' }),
        SESSION,
      );
    default:
      return deleteSessionState(new Request(entriesUrl(), { method: 'DELETE' }), SESSION);
  }
}

async function expectWriteOutcome(
  response: Response,
  expected: Record<string, unknown>,
): Promise<void> {
  if (expected['outcome'] === 'stored') {
    expect(response.status).toBe(204);
    return;
  }
  expect(response.status).toBe(expected['status']);
  expect(await response.json()).toMatchObject({ error: { code: expected['code'] } });
}
