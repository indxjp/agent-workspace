import { describe, expect, it } from 'vitest';
import { asRecord, loadVectors } from '../../../tests/formal/vectors.js';
import { loadTranscript } from '../server/sessions/api';
import { listSessionStateEntries, replaceSessionState } from '../server/sessions/state-api';
import {
  FAMILY,
  SESSION,
  ENGINE,
  STREAM,
  type Backend,
  installOwnSession,
  entriesUrl,
  jsonRequest,
  wireEntry,
  modelEntries,
  transcriptUrl,
  transcriptEntries,
} from './session-state.fixture.test-support';
import { seedLegacy, runMigration0027 } from './session-state.legacy.test-support';

export function replayMigration(backend: Backend): void {
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
        await writeMigratedEntries(migrated, id);
      } else {
        // On PostgreSQL the legacy tables are written the way the pre-ENG-06 release wrote them, the
        // public read is checked against the model's legacy fold, and then 0027 itself does the fold.
        await migrateLegacyEntries({ database, input, id, legacy });
      }
      await expectMigratedTranscript(migrated);
    });
  });
}

async function expectMigratedTranscript(migrated: unknown[]): Promise<void> {
  const read = await listSessionStateEntries(new Request(entriesUrl()), SESSION);
  expect(read.status).toBe(200);
  expect(modelEntries(await read.json())).toEqual(migrated);
  // Resume reads the same migrated history through the public transcript route.
  const transcript = await loadTranscript(new Request(transcriptUrl()), SESSION);
  expect(transcript.status).toBe(200);
  expect(transcriptEntries(await transcript.json())).toEqual(migrated);
}

async function writeMigratedEntries(migrated: unknown[], id: string): Promise<void> {
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
}

async function migrateLegacyEntries({
  database,
  input,
  id,
  legacy,
}: {
  database: Parameters<typeof seedLegacy>[0];
  input: unknown;
  id: string;
  legacy: unknown;
}): Promise<void> {
  const deliveries = asRecord(input, id)['deliveries'];
  if (!Array.isArray(deliveries)) throw new Error(`${id}: no deliveries`);
  await seedLegacy(database, deliveries);
  const before = await loadTranscript(new Request(transcriptUrl()), SESSION);
  expect(before.status, `${id}: the legacy read before 0027`).toBe(200);
  expect(transcriptEntries(await before.json())).toEqual(legacy);
  await runMigration0027(database);
}
