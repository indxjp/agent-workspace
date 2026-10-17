import { and, asc, desc, eq, inArray, isNotNull, lt, max, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../client.js';
import { sessionMessages } from '../schema/session-messages.js';
import { sessionTranscripts } from '../schema/session-transcripts.js';
import { requireWorkspaceScope, type WorkspaceScope } from './scope.js';

export interface TranscriptKeyRecord {
  readonly projectKey: string;
  readonly sessionId: string;
  readonly subpath?: string;
}

export type StoredTranscriptEntry = Readonly<Record<string, unknown>>;

export interface StoredTranscriptSession {
  readonly sessionId: string;
  readonly mtime: number;
}

export interface SessionTranscriptRepository {
  append(key: TranscriptKeyRecord, entries: readonly StoredTranscriptEntry[]): Promise<void>;
  load(key: TranscriptKeyRecord): Promise<readonly StoredTranscriptEntry[] | null>;
  listSessions(projectKey: string): Promise<readonly StoredTranscriptSession[]>;
  delete(key: TranscriptKeyRecord): Promise<void>;
  listSubkeys(key: Omit<TranscriptKeyRecord, 'subpath'>): Promise<readonly string[]>;
  /** Delete transcript heads older than the policy cutoff; message rows cascade. */
  purgeBefore(before: Date): Promise<number>;
}

export interface SessionTranscriptRepositoryProvider {
  forScope(scope: WorkspaceScope): SessionTranscriptRepository;
}

function every(...predicates: readonly SQL[]): SQL {
  const combined = and(...predicates);
  if (combined === undefined) throw new Error('the transcript predicate could not be built');
  return combined;
}

function jsonEntry(value: unknown): StoredTranscriptEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_messages.entry is not a JSON object');
  }
  return value as StoredTranscriptEntry;
}

function entryUuid(entry: StoredTranscriptEntry): string | null {
  return typeof entry['uuid'] === 'string' ? entry['uuid'] : null;
}

/** PostgreSQL transcript storage with per-key transactional sequencing and append-only delivery. */
export function createDatabaseSessionTranscriptRepositoryProvider(
  db: Database,
): SessionTranscriptRepositoryProvider {
  return {
    forScope(scope) {
      const checked = requireWorkspaceScope(scope, 'SessionTranscriptRepositoryProvider');
      const tenant = eq(sessionTranscripts.workspaceId, checked.workspaceId);

      const parts = (key: TranscriptKeyRecord) => {
        if (key.projectKey !== checked.workspaceId) {
          throw new Error(
            `transcript projectKey ${key.projectKey} does not match workspace scope ${checked.workspaceId}`,
          );
        }
        return {
          workspaceId: checked.workspaceId,
          projectKey: key.projectKey,
          sessionId: key.sessionId,
          subpath: key.subpath ?? '',
        };
      };

      const transcriptWhere = (key: TranscriptKeyRecord): SQL => {
        const one = parts(key);
        return every(
          tenant,
          eq(sessionTranscripts.projectKey, one.projectKey),
          eq(sessionTranscripts.sessionId, one.sessionId),
          eq(sessionTranscripts.subpath, one.subpath),
        );
      };

      const messageWhere = (key: TranscriptKeyRecord): SQL => {
        const one = parts(key);
        return every(
          eq(sessionMessages.workspaceId, one.workspaceId),
          eq(sessionMessages.projectKey, one.projectKey),
          eq(sessionMessages.sessionId, one.sessionId),
          eq(sessionMessages.subpath, one.subpath),
        );
      };

      return {
        async append(key, entries) {
          const one = parts(key);
          await db.transaction(async (tx) => {
            // PostgreSQL text values cannot contain NUL. JSON string escaping turns every such
            // byte into the printable sequence `\\u0000`, while array framing keeps the four
            // components unambiguous even when a value contains separators.
            const lockKey = JSON.stringify([
              one.workspaceId,
              one.projectKey,
              one.sessionId,
              one.subpath,
            ]);
            await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
            await tx
              .insert(sessionTranscripts)
              .values(one)
              .onConflictDoUpdate({
                target: [
                  sessionTranscripts.workspaceId,
                  sessionTranscripts.projectKey,
                  sessionTranscripts.sessionId,
                  sessionTranscripts.subpath,
                ],
                set: { updatedAt: sql`now()` },
              });

            if (entries.length === 0) return;
            const latestRows = await tx
              .select({ value: max(sessionMessages.sequence) })
              .from(sessionMessages)
              .where(messageWhere(key));
            let next = BigInt(latestRows[0]?.value ?? 0n);

            const incomingUuids = [
              ...new Set(entries.map(entryUuid).filter((value): value is string => value !== null)),
            ];
            const positions = new Map<string, bigint>();
            if (incomingUuids.length > 0) {
              const prior = await tx
                .select({ uuid: sessionMessages.entryUuid, position: sessionMessages.position })
                .from(sessionMessages)
                .where(
                  every(
                    messageWhere(key),
                    isNotNull(sessionMessages.entryUuid),
                    inArray(sessionMessages.entryUuid, incomingUuids),
                  ),
                )
                .orderBy(asc(sessionMessages.sequence));
              for (const row of prior) {
                if (row.uuid !== null && !positions.has(row.uuid))
                  positions.set(row.uuid, row.position);
              }
            }

            for (const entry of entries) {
              next += 1n;
              const uuid = entryUuid(entry);
              const position = uuid === null ? next : (positions.get(uuid) ?? next);
              if (uuid !== null && !positions.has(uuid)) positions.set(uuid, position);
              await tx.insert(sessionMessages).values({
                ...one,
                sequence: next,
                position,
                entryUuid: uuid,
                entry,
              });
            }
          });
        },

        async load(key) {
          const known = await db
            .select({ sessionId: sessionTranscripts.sessionId })
            .from(sessionTranscripts)
            .where(transcriptWhere(key))
            .limit(1);
          if (known.length === 0) return null;
          const deliveries = await db
            .select({ entry: sessionMessages.entry })
            .from(sessionMessages)
            .where(messageWhere(key))
            .orderBy(asc(sessionMessages.sequence));
          const result: StoredTranscriptEntry[] = [];
          const positions = new Map<string, number>();
          for (const row of deliveries) {
            const entry = jsonEntry(row.entry);
            const uuid = entryUuid(entry);
            if (uuid === null) {
              result.push(entry);
              continue;
            }
            const at = positions.get(uuid);
            if (at === undefined) {
              positions.set(uuid, result.length);
              result.push(entry);
            } else {
              result[at] = entry;
            }
          }
          return result;
        },

        async listSessions(projectKey) {
          if (projectKey !== checked.workspaceId) return [];
          const rows = await db
            .select({
              sessionId: sessionTranscripts.sessionId,
              updatedAt: sessionTranscripts.updatedAt,
            })
            .from(sessionTranscripts)
            .where(
              every(
                tenant,
                eq(sessionTranscripts.projectKey, projectKey),
                eq(sessionTranscripts.subpath, ''),
              ),
            )
            .orderBy(desc(sessionTranscripts.updatedAt), asc(sessionTranscripts.sessionId));
          return rows.map((row) => ({ sessionId: row.sessionId, mtime: row.updatedAt.getTime() }));
        },

        async delete(key) {
          const one = parts(key);
          const predicate =
            key.subpath === undefined
              ? every(
                  tenant,
                  eq(sessionTranscripts.projectKey, one.projectKey),
                  eq(sessionTranscripts.sessionId, one.sessionId),
                )
              : transcriptWhere(key);
          await db.delete(sessionTranscripts).where(predicate);
        },

        async listSubkeys(key) {
          const one = parts(key);
          const rows = await db
            .select({ subpath: sessionTranscripts.subpath })
            .from(sessionTranscripts)
            .where(
              every(
                tenant,
                eq(sessionTranscripts.projectKey, one.projectKey),
                eq(sessionTranscripts.sessionId, one.sessionId),
                sql`${sessionTranscripts.subpath} <> ''`,
              ),
            )
            .orderBy(asc(sessionTranscripts.subpath));
          return rows.map((row) => row.subpath);
        },

        async purgeBefore(before) {
          const removed = await db
            .delete(sessionTranscripts)
            .where(every(tenant, lt(sessionTranscripts.updatedAt, before)))
            .returning({ sessionId: sessionTranscripts.sessionId });
          return removed.length;
        },
      };
    },
  };
}
