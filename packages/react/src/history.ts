/**
 * The hosted surface page's per-browser history (ADR-0108 SD10, C18; issue #540): one entry per
 * (surface, agent) holding the session to resume, its resume key and the runs to replay, plus
 * which agent the visitor last talked to. It lives under one `localStorage` key per surface when
 * the surface sets `parts.history`, and in memory otherwise, so a switch back to an agent resumes
 * its session within the page either way while nothing is persisted without the opt-in.
 *
 * The stored value is browser-local and anyone with the page can edit it, so it is parsed on every
 * read and a malformed value counts as empty. Storage may be absent or refuse writes (a private
 * window, a full quota, a blocked iframe): every access is guarded, and the page works without it.
 * The shape is internal to this page, not a contract.
 */
import { UuidSchema } from '@indx-workspace/contracts';
import { SURFACE_RESUME_KEY_PATTERN } from '@indx-workspace/contracts/surfaces';
import { z } from 'zod';

/** The most runs an entry keeps, and so replays on a reload. */
// ponytail: replays the last 50 runs; upgrade: a paged replay
export const SURFACE_HISTORY_RUNS_MAX = 50;

const SurfaceHistoryEntrySchema = z
  .object({
    sessionId: UuidSchema,
    resumeKey: z.string().regex(SURFACE_RESUME_KEY_PATTERN),
    runIds: z.array(z.string().min(1)).max(SURFACE_HISTORY_RUNS_MAX).readonly(),
  })
  .strict()
  .readonly();
/** One (surface, agent) conversation the page can resume and replay. */
export type SurfaceHistoryEntry = z.infer<typeof SurfaceHistoryEntrySchema>;

const StoredHistorySchema = z
  .object({
    agent: z.string().nullable(),
    entries: z.record(z.string(), SurfaceHistoryEntrySchema).readonly(),
  })
  .strict()
  .readonly();
/** One surface's history: the agent last talked to, and each agent's entry. */
export type SurfaceHistory = z.infer<typeof StoredHistorySchema>;

/** The part of `Storage` the history uses. */
export type SurfaceHistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;

const EMPTY: SurfaceHistory = { agent: null, entries: {} };

/** The storage key of surface `name`'s history. */
export function surfaceHistoryKey(name: string): string {
  return `aw.surface.${name}`;
}

function memoryStorage(): SurfaceHistoryStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/**
 * Where the history lives: `local()` when `enabled` and it can be reached, else memory. `local`
 * is not called when the surface did not opt in.
 */
export function surfaceHistoryStorage(
  enabled: boolean,
  local: () => SurfaceHistoryStorage,
): SurfaceHistoryStorage {
  if (!enabled) return memoryStorage();
  try {
    return local();
  } catch {
    return memoryStorage();
  }
}

function readStored(storage: SurfaceHistoryStorage, name: string): SurfaceHistory {
  try {
    const raw = storage.getItem(surfaceHistoryKey(name));
    if (raw === null) return EMPTY;
    const parsed = StoredHistorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY;
  } catch {
    return EMPTY;
  }
}

function writeStored(storage: SurfaceHistoryStorage, name: string, history: SurfaceHistory): void {
  try {
    storage.setItem(surfaceHistoryKey(name), JSON.stringify(history));
  } catch {
    // Best effort: without storage the page still works, it only forgets on a reload.
  }
}

/** Surface `name`'s history, with only the `offered` agents' entries and pointer kept. */
export function readSurfaceHistory(
  storage: SurfaceHistoryStorage,
  name: string,
  offered: readonly string[],
): SurfaceHistory {
  const stored = readStored(storage, name);
  return {
    agent: stored.agent !== null && offered.includes(stored.agent) ? stored.agent : null,
    entries: Object.fromEntries(
      Object.entries(stored.entries).filter(([agent]) => offered.includes(agent)),
    ),
  };
}

/** `agent`'s entry, or `null`. */
export function surfaceEntryOf(history: SurfaceHistory, agent: string): SurfaceHistoryEntry | null {
  return Object.hasOwn(history.entries, agent) ? (history.entries[agent] ?? null) : null;
}

/** Store `entry` as `agent`'s, or remove `agent`'s entry when it is `null`. */
export function writeSurfaceEntry(
  storage: SurfaceHistoryStorage,
  name: string,
  agent: string,
  entry: SurfaceHistoryEntry | null,
): void {
  const stored = readStored(storage, name);
  const entries = Object.fromEntries(
    Object.entries(stored.entries).filter(([each]) => each !== agent),
  );
  writeStored(storage, name, {
    agent: stored.agent,
    entries: entry === null ? entries : { ...entries, [agent]: entry },
  });
}

/** Remember `agent` as the one the visitor talks to, so a reload opens it. */
export function selectSurfaceAgent(
  storage: SurfaceHistoryStorage,
  name: string,
  agent: string,
): void {
  writeStored(storage, name, { ...readStored(storage, name), agent });
}

/** Add `runId` to `agent`'s entry, keeping the last {@link SURFACE_HISTORY_RUNS_MAX}. */
export function appendSurfaceRun(
  storage: SurfaceHistoryStorage,
  name: string,
  agent: string,
  runId: string,
): void {
  const entry = surfaceEntryOf(readStored(storage, name), agent);
  if (entry === null) return;
  writeSurfaceEntry(storage, name, agent, {
    ...entry,
    runIds: [...entry.runIds, runId].slice(-SURFACE_HISTORY_RUNS_MAX),
  });
}
