/**
 * Helpers shared by the run store suites: the conformance suite (`store.conformance.ts`) and the
 * PostgreSQL-only suites (`store.postgres*.test.ts`).
 */
import { expect } from 'vitest';

import { listRuns as listRunsOverHttp } from './api';
import type { CreateRunInput, RunStore } from './store';
import type { SseEvent } from './sse';

/** A store, plus the ids a run in it may legally name. */
export interface RunStoreFixture {
  readonly store: RunStore;
  /** A model connection id valid in this fixture's workspace (issue #129's `snapshotModel`). */
  readonly modelConnectionId: string;
  /** A fresh, valid {@link CreateRunInput} for this store. Called once per run a test needs. */
  nextRun(): CreateRunInput;
}

/** Builds a fixture. Called once per test, so no test inherits another's state. */
export type MakeRunStoreFixture = (options: {
  readonly maxEventsPerRun?: number;
}) => Promise<RunStoreFixture>;

/** What each topic of the conformance suite is handed: the fixture factory and its shorthand. */
export interface ConformanceHarness {
  readonly make: MakeRunStoreFixture;
  readonly started: StartRun;
}

/** A fixture with one run already created, which is what most tests start from. */
interface StartedRun {
  readonly store: RunStore;
  readonly run: CreateRunInput;
  readonly fixture: RunStoreFixture;
}

/** Makes a {@link StartedRun}, optionally with a bound on the events a run retains. */
export type StartRun = (maxEventsPerRun?: number) => Promise<StartedRun>;

export function startRunWith(make: MakeRunStoreFixture): StartRun {
  return async (maxEventsPerRun) => {
    const fixture =
      maxEventsPerRun === undefined ? await make({}) : await make({ maxEventsPerRun });
    const run = fixture.nextRun();
    await fixture.store.create(run);
    return { store: fixture.store, run, fixture };
  };
}

/** Take `count` events from a handle, then close it. */
export async function take(events: AsyncIterable<SseEvent>, count: number): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  if (count === 0) return out;
  for await (const event of events) {
    out.push(event);
    if (out.length === count) break;
  }
  return out;
}

/** The most pages any list walk below may take before it is declared stuck. */
const MAX_PAGES = 100;

interface WalkedPage<Cursor> {
  readonly ids: readonly string[];
  readonly nextCursor: Cursor | null;
}

/**
 * Walk a run list to exhaustion and return every id seen, in the order it was seen. `fetchPage`
 * is handed the previous page's cursor (`null` first); `afterPage` runs once a page has been
 * read, for a walk that must stay stable against writes made mid-walk.
 *
 * Two things a bare `for (;;)` did not do (round 3 findings 6 and 8): every page but the last is
 * asserted to be exactly `limit` long, so a store that ignores `limit` fails by name; and the walk
 * is bounded at {@link MAX_PAGES}, so a regression that stops advancing the cursor fails by name
 * too, instead of re-serving page one until vitest's timeout — which `InMemoryRunStore`, answering
 * from an already-resolved promise, never even lets fire.
 */
export async function walkPages<Cursor>(
  limit: number,
  fetchPage: (cursor: Cursor | null) => Promise<WalkedPage<Cursor>>,
  afterPage?: (pageIndex: number) => Promise<void>,
): Promise<string[]> {
  const collected: string[] = [];
  let cursor: Cursor | null = null;
  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= MAX_PAGES) {
      throw new Error(
        `the list did not end within ${String(MAX_PAGES)} pages of ${String(limit)}: the cursor ` +
          'is not advancing',
      );
    }
    const page = await fetchPage(cursor);
    if (page.nextCursor !== null) expect(page.ids).toHaveLength(limit);
    collected.push(...page.ids);
    if (afterPage !== undefined) await afterPage(pageIndex);
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return collected;
}

/** One `GET /api/runs` page through the route handler itself, asserting it was served. */
export async function listOverHttp(
  query: string,
  cursor: string | null = null,
): Promise<{ readonly ids: string[]; readonly nextCursor: string | null }> {
  const url =
    `http://web/api/runs?${query}` +
    (cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`);
  const response = await listRunsOverHttp(new Request(url));
  expect(response.status).toBe(200);
  const payload = (await response.json()) as {
    runs: Array<{ id: string }>;
    nextCursor: string | null;
  };
  return { ids: payload.runs.map((run) => run.id), nextCursor: payload.nextCursor };
}

/** `GET /api/runs?…` through the route handler, returning the status and error code only. */
export async function listOverHttpStatus(
  query: string,
): Promise<{ readonly status: number; readonly code: string | null }> {
  const response = await listRunsOverHttp(new Request(`http://web/api/runs?${query}`));
  const payload = (await response.json()) as { error?: { code?: string } };
  return { status: response.status, code: payload.error?.code ?? null };
}
