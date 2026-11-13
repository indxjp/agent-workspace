import {
  sessionMessages,
  sessionTranscripts,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { asRecord, asString } from '../../../tests/formal/vectors.js';
import type { TranscriptStore } from '../server/sessions/transcript';
import { WORKSPACE, SESSION } from './session-state.fixture.test-support';
export function parseDelivery(raw: unknown, index: number) {
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

export async function seedLegacy(
  database: IsolatedTestDatabase,
  deliveries: unknown[],
): Promise<void> {
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

export async function appendLegacy(legacy: TranscriptStore, deliveries: unknown[]): Promise<void> {
  const key = { projectKey: WORKSPACE, sessionId: SESSION };
  const parsed = deliveries.map((raw, index) => parseDelivery(raw, index));
  parsed.sort((left, right) => left.sequence - right.sequence);
  await legacy.append(key, []);
  for (const one of parsed) await legacy.append(key, [one.entry]);
}

import { readFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
export async function runMigration0027(database: IsolatedTestDatabase): Promise<void> {
  const statements = readFileSync(MIGRATION_0027, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  expect(statements.length).toBe(2);
  for (const statement of statements) await database.db.execute(sql.raw(statement));
}

import { MIGRATION_0027 } from './session-state.fixture.test-support';
