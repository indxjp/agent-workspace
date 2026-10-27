/**
 * The run store conformance suite — **one suite, two implementations**.
 *
 * Written against {@link RunStore} rather than against either implementation, and exported as
 * {@link describeRunStoreConformance} so that both are held to the same assertions. It runs
 * against:
 *
 *   1. `new InMemoryRunStore()` — records in a `Map`, always;
 *   2. `createRepositoryRunStore()` over `packages/core/src/db/repositories/runs.ts` and a **real
 *      PostgreSQL**, whenever `TEST_DATABASE_URL` names one.
 *
 * ## Why the fixture mints the run input
 *
 * The in-memory store accepts any workspace, agent and session id. PostgreSQL does not: `runs`
 * references `sessions (id, workspace_id)`, `sessions` references `agents` and `memberships`, and
 * each of those references `workspaces`. So the database fixture creates that whole chain and
 * hands back a `CreateRunInput` whose ids really exist, and the same assertions then run against
 * both. Every fixture uses fresh ids, so nothing needs truncating and nothing collides with the
 * other suites sharing the server.
 *
 * The PostgreSQL-specific cases additionally construct a second store over the same database to
 * prove that events written by the first instance replay after a process-level composition reset.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import { RUN_STATUSES } from '@indx-workspace/contracts/runs';
import { RUN_STATUS_EVENT_NAME, RUN_STATUS_NAMES } from '@indx-workspace/react/run-model';
import { classifySdkEvent, toAgentFrames } from '@agent-workspace/run-protocol';

import { upgradeEventStream } from './agent-frames';
import { listRuns as listRunsOverHttp, readRun as readRunOverHttp } from './api';
import { InMemoryRunStore } from './memory-store';
import { createRepositoryRunStore } from './repository-store';
import {
  ApprovalDecisionError,
  IdempotencyKeyTakenError,
  isTerminalRunStatus,
  MAX_RUN_LIST_LIMIT,
  runStatuses,
  SessionBusyError,
  terminalRunStatuses,
  type ApprovalCall,
  type CreateRunInput,
  type ListRunsInput,
  type RunRecord,
  type RunListCursor,
  type RunListPage,
  type RunStore,
} from './store';
import { PLATFORM_EVENT_NAMES, RUN_STATUS_EVENT } from './sse';
import type { PlatformEventName, SseEvent, SseWireEvent } from './sse';
import { installTestRunApi, resetTestRunApi } from '../application-context-fixtures';

/** Take `count` events from a handle, then close it. */
async function take(events: AsyncIterable<SseEvent>, count: number): Promise<SseEvent[]> {
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
async function walkPages<Cursor>(
  limit: number,
  fetchPage: (
    cursor: Cursor | null,
  ) => Promise<{ readonly ids: readonly string[]; readonly nextCursor: Cursor | null }>,
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
async function listOverHttp(
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
async function listOverHttpStatus(
  query: string,
): Promise<{ readonly status: number; readonly code: string | null }> {
  const response = await listRunsOverHttp(new Request(`http://web/api/runs?${query}`));
  const payload = (await response.json()) as { error?: { code?: string } };
  return { status: response.status, code: payload.error?.code ?? null };
}

describe('the run status vocabulary', () => {
  it('is character-for-character the database schema this repository already has', () => {
    // The list is restated in `store.ts` rather than imported, because `apps/web` reaches
    // `@agent-workspace/core` through `import type` only — see that file's header. This test is
    // what keeps the restatement from becoming a second, drifting source of truth.
    // The path is joined with the imported `path` rather than constructed with `new URL`, because
    // the reachability gate refuses a layer path handed to a callee it cannot see this file bind
    // (ADR-0031 clause 1), and `URL` is a free global. Reading the schema as *text* is what this
    // test is for; routing the path through an imported binding is what makes the reference one a
    // reader — and that gate — can follow.
    const schema = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../../../packages/core/src/db/schema/runs.ts',
      ),
      'utf8',
    );
    const read = (name: string): string[] => {
      const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(schema);
      if (match === null)
        throw new Error(`${name} not found in packages/core/src/db/schema/runs.ts`);
      return [...(match[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
    };
    // Both lists are the contract's `RUN_STATUSES` itself: the schema imports it rather than
    // restating it (F-12), and `store.ts` re-exports it, so the check is that both do.
    expect(schema).toContain("import { RUN_STATUSES } from '@indx-workspace/contracts/runs';");
    expect(schema).toContain('export const runStatuses = RUN_STATUSES;');
    expect(runStatuses).toBe(RUN_STATUSES);
    expect([...terminalRunStatuses]).toEqual(read('terminalRunStatuses'));
  });

  it('agrees with isTerminalRunStatus on every member, with no default arm', () => {
    for (const status of runStatuses) {
      expect(isTerminalRunStatus(status)).toBe(
        (terminalRunStatuses as readonly string[]).includes(status),
      );
    }
  });

  // The browser's run model (`@indx-workspace/react/run-model`) restates these two, because a
  // client bundle cannot import a server module; this is the check that the restatement agrees.
  it('is the run model’s RUN_STATUS_NAMES, and its status event is RUN_STATUS_EVENT', () => {
    expect([...RUN_STATUS_NAMES]).toEqual([...runStatuses]);
    expect(RUN_STATUS_EVENT_NAME).toBe(RUN_STATUS_EVENT);
  });
});

describe('the run list page-size ceiling', () => {
  it('is one number written in three places, and they agree', () => {
    // `MAX_RUN_LIST_LIMIT` exists twice under that name: in the repository, which enforces it for
    // every direct caller, and in `store.ts`, so `InMemoryRunStore` refuses what the repository
    // refuses and `list-query.ts` turns a larger `limit` into `400 invalid_limit` before any store
    // is reached. `store.ts` restates the repository's rather than importing it for the reason the
    // run status vocabulary above is — `apps/web` reaches `@agent-workspace/core` through `import
    // type` only. This test is what stops them from drifting apart silently; the conformance
    // suite's `listRuns` block is what stops the *message* they refuse with from drifting.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const declaredIn = (relative: string): number => {
      const source = readFileSync(path.join(here, relative), 'utf8');
      const match = /const MAX_RUN_LIST_LIMIT\s*=\s*(\d+);/u.exec(source);
      if (match === null) throw new Error(`MAX_RUN_LIST_LIMIT is not declared in ${relative}`);
      return Number(match[1] ?? '');
    };
    expect(declaredIn('../../../../packages/core/src/db/repositories/runs.ts')).toBe(
      MAX_RUN_LIST_LIMIT,
    );
    // Declared once in this directory, in `store.ts`: `api.ts`, `service.ts` and `list-query.ts`
    // import it, so a second declaration there would be a fourth copy to drift.
    const declaring = readdirSync(here).filter(
      (file) =>
        /\.ts$/u.test(file) &&
        !/\.test\.ts$/u.test(file) &&
        /MAX_RUN_LIST_LIMIT\s*=/u.test(readFileSync(path.join(here, file), 'utf8')),
    );
    expect(declaring).toEqual(['store.ts']);
    // The third copy, spelled differently and so read separately: `project-detail.tsx` sends it
    // verbatim as `limit=` to this same route, so a lowered ceiling would answer the archive-impact
    // dialog `400 invalid_limit` rather than a page. Read as text, not imported — it is browser
    // code, and reading the declaration is the pattern the read above already uses.
    const archive = readFileSync(path.join(here, '../../components/projects/model.ts'), 'utf8');
    const archiveLimit = /const ARCHIVE_IMPACT_RUN_LIMIT = (\d+);/u.exec(archive);
    if (archiveLimit === null)
      throw new Error(
        'ARCHIVE_IMPACT_RUN_LIMIT is not declared in ../../components/projects/model.ts',
      );
    expect(Number(archiveLimit[1] ?? '')).toBe(MAX_RUN_LIST_LIMIT);
  });
});

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

/** Run the conformance suite against a fixture factory. */
export function describeRunStoreConformance(label: string, make: MakeRunStoreFixture): void {
  /** A fixture with one run already created, which is what most tests start from. */
  const started = async (
    maxEventsPerRun?: number,
  ): Promise<{
    store: RunStore;
    run: CreateRunInput;
    fixture: RunStoreFixture;
  }> => {
    const fixture =
      maxEventsPerRun === undefined ? await make({}) : await make({ maxEventsPerRun });
    const run = fixture.nextRun();
    await fixture.store.create(run);
    return { store: fixture.store, run, fixture };
  };

  describe(label, () => {
    describe('records', () => {
      it('creates a queued run with no timestamps and refuses a duplicate id', async () => {
        const { store, run } = await started();
        const record = await store.get(run.id);
        expect(record?.status).toBe('queued');
        expect(record?.startedAt).toBeNull();
        expect(record?.endedAt).toBeNull();
        await expect(store.create(run)).rejects.toThrow(/already exists/);
      });

      it('echoes the workspace, agent and session the run was created for', async () => {
        const { store, run } = await started();
        const record = await store.get(run.id);
        expect(record?.workspaceId).toBe(run.workspaceId);
        expect(record?.agentId).toBe(run.agentId);
        expect(record?.sessionId).toBe(run.sessionId);
      });

      // ADR-0151: a paused run takes exactly one continuation; a second decision is refused and
      // creates nothing.
      it('gives a paused run one continuation and refuses a second decision', async () => {
        const { store, run, fixture } = await started();
        await store.markRunning(run.id);
        await store.awaitApproval(run.id, { toolName: 'send_email', canonicalCall: '{}' });
        const continuation = { ...fixture.nextRun(), decides: run.id };
        await store.create(continuation);
        const second = { ...fixture.nextRun(), decides: run.id };

        await expect(store.create(second)).rejects.toMatchObject({
          constructor: ApprovalDecisionError,
          runId: run.id,
          reason: 'already-decided',
        });
        expect(await store.get(second.id)).toBeNull();
        expect((await store.get(run.id))?.status).toBe('completed');
        expect((await store.get(continuation.id))?.status).toBe('queued');
      });

      // ADR-0151, #250: one run per start key, per workspace and principal.
      it('finds a run by its start key, scoped to its principal, and never frees the key', async () => {
        const fixture = await make({});
        const principalId = crypto.randomUUID();
        const idempotency = { principalId, key: 'retry-1', requestHash: 'h1' };
        const first = { ...fixture.nextRun(), idempotency };
        await fixture.store.create(first);
        const { workspaceId } = first;

        const found = await fixture.store.findByIdempotencyKey(workspaceId, principalId, 'retry-1');
        expect({ id: found?.run.id, requestHash: found?.requestHash }).toEqual({
          id: first.id,
          requestHash: 'h1',
        });
        await expect(
          fixture.store.findByIdempotencyKey(workspaceId, crypto.randomUUID(), 'retry-1'),
        ).resolves.toBeNull();
        await expect(
          fixture.store.findByIdempotencyKey(workspaceId, principalId, 'retry-2'),
        ).resolves.toBeNull();

        // Not even a finished run frees its key.
        await fixture.store.finish(first.id, 'completed', null);
        await expect(fixture.store.create({ ...fixture.nextRun(), idempotency })).rejects.toThrow(
          IdempotencyKeyTakenError,
        );
        const other = { ...fixture.nextRun(), idempotency: { ...idempotency, principalId: 'p2' } };
        await expect(fixture.store.create(other)).resolves.toMatchObject({ id: other.id });
      });

      // #1440: both stores give one answer when a held key meets a `decides` that cannot be
      // decided. The decision is judged first, so the caller hears why the decision failed.
      it('answers already-decided, not key-taken, for a held key with a decided `decides`', async () => {
        const fixture = await make({});
        const idempotency = { principalId: crypto.randomUUID(), key: 'k', requestHash: 'h' };
        const first = { ...fixture.nextRun(), idempotency };
        await fixture.store.create(first);
        await fixture.store.finish(first.id, 'completed', null);

        const refused = await fixture.store
          .create({ ...fixture.nextRun(), idempotency, decides: first.id })
          .catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ApprovalDecisionError);
        expect((refused as ApprovalDecisionError).reason).toBe('already-decided');
      });

      it('leaves the paused run awaiting approval when the continuation’s key is taken', async () => {
        const fixture = await make({});
        const call: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
        const idempotency = { principalId: crypto.randomUUID(), key: 'k', requestHash: 'h' };
        const holder = { ...fixture.nextRun(), idempotency };
        await fixture.store.create(holder);
        await fixture.store.finish(holder.id, 'completed', null);
        const paused = fixture.nextRun();
        await fixture.store.create(paused);
        await fixture.store.markRunning(paused.id);
        await fixture.store.awaitApproval(paused.id, call);

        await expect(
          fixture.store.create({
            ...fixture.nextRun(),
            idempotency,
            decides: paused.id,
            approvedToolCalls: [call],
          }),
        ).rejects.toThrow(IdempotencyKeyTakenError);
        expect((await fixture.store.get(paused.id))?.status).toBe('awaiting_approval');
      });

      // ADR-0151: approved calls are consumed when the run leaves `queued`, once.
      it('stamps approvalsConsumedAt on markRunning only for a run with approved calls', async () => {
        const fixture = await make({});
        const call: ApprovalCall = { toolName: 'send_email', canonicalCall: '{"to":"a@b.c"}' };
        const plain = fixture.nextRun();
        await fixture.store.create(plain);
        await fixture.store.markRunning(plain.id);
        expect((await fixture.store.get(plain.id))?.approvalsConsumedAt).toBeNull();
        await fixture.store.finish(plain.id, 'completed', null);

        const approved = { ...fixture.nextRun(), approvedToolCalls: [call] };
        await fixture.store.create(approved);
        expect((await fixture.store.get(approved.id))?.approvalsConsumedAt).toBeNull();
        await fixture.store.markRunning(approved.id);
        const consumed = await fixture.store.get(approved.id);
        expect(consumed?.approvalsConsumedAt).toBeInstanceOf(Date);
        expect(consumed?.approvalsConsumedAt).toEqual(consumed?.startedAt);
      });

      // #1440: two starts with one key on one session race. The loser hears the key is taken, so
      // the route replays the winner, rather than `session_busy`.
      it('answers a concurrent start with the same key on one session with key-taken', async () => {
        const fixture = await make({});
        const idempotency = { principalId: crypto.randomUUID(), key: 'k', requestHash: 'h' };
        const results = await Promise.allSettled([
          fixture.store.create({ ...fixture.nextRun(), idempotency }),
          fixture.store.create({ ...fixture.nextRun(), idempotency }),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const [lost] = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason as unknown] : [],
        );
        expect(lost).toBeInstanceOf(IdempotencyKeyTakenError);
      });

      it('returns null for a run it has never seen', async () => {
        const fixture = await make({});
        expect(await fixture.store.get(fixture.nextRun().id)).toBeNull();
      });

      it('stamps startedAt once and endedAt once, and the first terminal status wins', async () => {
        const { store, run } = await started();
        // Only the call that actually moves the run out of `queued` reports `true` (issue #235:
        // the launcher starts a runtime on that answer alone).
        expect(await store.markRunning(run.id)).toBe(true);
        const startedAt = (await store.get(run.id))?.startedAt;
        expect(startedAt).toBeInstanceOf(Date);
        expect(await store.markRunning(run.id)).toBe(false);
        expect((await store.get(run.id))?.startedAt).toEqual(startedAt);

        await store.finish(run.id, 'completed', null);
        await store.finish(run.id, 'failed', 'too late');
        const record = await store.get(run.id);
        expect(record?.status).toBe('completed');
        expect(record?.error).toBeNull();
        expect(record?.endedAt).toBeInstanceOf(Date);
      });

      it('commits one matching terminal status event when finishes race', async () => {
        const { store, run } = await started();
        await store.markRunning(run.id);
        await Promise.all([
          store.finish(run.id, 'cancelled', 'interrupted', true),
          store.finish(run.id, 'completed', null, true),
        ]);
        const settled = await store.get(run.id);
        if (settled === null) throw new Error('run was lost');
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('run had no event stream');
        const terminal = [];
        for await (const event of handle.events) {
          if (event.type === 'run.status') terminal.push(event.data);
        }
        expect(terminal).toEqual([{ status: settled.status, error: settled.error }]);
      });

      it('never leaves a terminal run without an endedAt, which the database check forbids', async () => {
        const { store, run } = await started();
        await store.finish(run.id, 'failed', 'the runtime never answered');
        const record = await store.get(run.id);
        expect(record?.endedAt).toBeInstanceOf(Date);
        // `runs_ended_at_iff_terminal` also needs a coherent start; a run that failed before it
        // ever started still gets one rather than a NULL that renders as "NaN s".
        expect(record?.startedAt).toBeInstanceOf(Date);
        expect(record?.error).toBe('the runtime never answered');
      });

      it('keeps a completed run’s output, and refuses an output on any other ending (ADR-0143)', async () => {
        const { store, run } = await started();
        expect((await store.get(run.id))?.output).toBeNull();
        const output = { text: '{"a":1}', structured: { a: 1 } };
        await expect(store.finish(run.id, 'failed', 'boom', false, output)).rejects.toThrow(
          /cannot carry an output/,
        );
        expect((await store.get(run.id))?.output).toBeNull();
        await store.finish(run.id, 'completed', null, false, output);
        expect((await store.get(run.id))?.output).toEqual(output);
      });

      it('refuses to "finish" a run into a non-terminal status', async () => {
        const { store, run } = await started();
        await expect(store.finish(run.id, 'running', null)).rejects.toThrow(/not a terminal/);
      });

      it('treats a lifecycle transition on an unknown run as a no-op, not a failure', async () => {
        const fixture = await make({});
        const absent = fixture.nextRun().id;
        // …and it reports that it did not transition anything, which is how the launcher tells a
        // run it may start from one that is already gone or already terminal (issue #235).
        await expect(fixture.store.markRunning(absent)).resolves.toBe(false);
        await expect(fixture.store.finish(absent, 'completed', null)).resolves.toBeUndefined();
      });

      // issue #129: written once, before launch, so a queued or failed run still says what it
      // attempted. Distinct from usage settlement (`run-usage.test.ts`, `packages/core`), which
      // this method never touches.
      it('snapshotModel writes model, provider and connection id, and leaves counters untouched', async () => {
        const { store, run, fixture } = await started();
        await store.snapshotModel(run.id, {
          connectionId: fixture.modelConnectionId,
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
        });
        const record = await store.get(run.id);
        expect(record).toMatchObject({
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
          modelConnectionId: fixture.modelConnectionId,
          inputTokens: 0,
          outputTokens: 0,
        });
      });

      it('snapshotModel overwrites a previous snapshot rather than accumulating', async () => {
        const { store, run, fixture } = await started();
        await store.snapshotModel(run.id, {
          connectionId: fixture.modelConnectionId,
          model: 'claude-sonnet-4-5',
          provider: 'anthropic',
        });
        await store.snapshotModel(run.id, {
          connectionId: fixture.modelConnectionId,
          model: 'claude-opus-4-5',
          provider: 'anthropic',
        });
        expect((await store.get(run.id))?.model).toBe('claude-opus-4-5');
      });

      it('snapshotModel on an unknown run is a no-op, not a failure', async () => {
        const fixture = await make({});
        const absent = fixture.nextRun().id;
        await expect(
          fixture.store.snapshotModel(absent, {
            connectionId: fixture.modelConnectionId,
            model: 'claude-sonnet-4-5',
            provider: 'anthropic',
          }),
        ).resolves.toBeUndefined();
      });
    });

    describe('events', () => {
      it('assigns monotonic ids from 1', async () => {
        const { store, run } = await started();
        const a = await store.append(run.id, { type: 'assistant', data: 1 });
        const b = await store.append(run.id, { type: 'assistant', data: 2 });
        expect(a).toMatchObject({
          kind: 'appended',
          event: { id: 1n, type: 'assistant', data: 1 },
        });
        expect(a.kind === 'appended' && a.event.at).toBeInstanceOf(Date);
        expect(b.kind === 'appended' && b.event.id).toBe(2n);
      });

      it('stamps each event with the time it was recorded, on append and when streamed', async () => {
        const { store, run } = await started();
        const before = Date.now() - 60_000;
        await store.append(run.id, { type: 'assistant', data: 'a' });
        await store.append(run.id, { type: 'assistant', data: 'b' });
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        const streamed = await take(handle.events, 2);
        handle.close();
        const times = streamed.map((event) => event.at?.getTime() ?? Number.NaN);
        expect(times.every((time) => time >= before && time <= Date.now() + 60_000)).toBe(true);
        expect(times[1]).toBeGreaterThanOrEqual(times[0] ?? Number.POSITIVE_INFINITY);
      });

      it('rejects an unknown run by name rather than silently dropping the event', async () => {
        const fixture = await make({});
        const absent = fixture.nextRun().id;
        const result = await fixture.store.append(absent, { type: 'assistant', data: 1 });
        expect(result).toEqual({ kind: 'rejected', reason: `no run ${absent}` });
      });

      it('rejects an injectable event name and a reserved one at ingestion', async () => {
        const { store, run } = await started();
        const injected = await store.append(run.id, { type: 'x\ndata: forged', data: 1 });
        expect(injected.kind).toBe('rejected');
        const reserved = await store.append(run.id, { type: 'done', data: 1 });
        expect(reserved.kind).toBe('rejected');
      });

      it('refuses a relayed frame that names one of the platform lifecycle events', async () => {
        const { store, run } = await started();
        for (const name of PLATFORM_EVENT_NAMES) {
          const forged = await store.append(run.id, { type: name, data: { status: 'completed' } });
          expect(forged.kind).toBe('rejected');
        }
        // ...and the platform path, the only one that accepts them, still works.
        const written = await store.appendPlatformEvent(run.id, {
          type: RUN_STATUS_EVENT,
          data: { status: 'running', error: null },
        });
        expect(written.kind).toBe('appended');
      });

      it('accepts nothing but a platform event name on the platform path', async () => {
        const { store, run } = await started();
        // The cast is the point of the test: the compile-time narrowing is not the whole defence,
        // so the run-time check is exercised with values that got past it.
        for (const name of ['assistant', 'done', 'run.status ', '']) {
          const result = await store.appendPlatformEvent(run.id, {
            type: name as PlatformEventName,
            data: 1,
          });
          expect(result.kind).toBe('rejected');
        }
      });

      it('rejects an unserialisable payload at ingestion, not at render time', async () => {
        const { store, run } = await started();
        expect((await store.append(run.id, { type: 'assistant', data: 1n })).kind).toBe('rejected');
        expect((await store.append(run.id, { type: 'assistant', data: undefined })).kind).toBe(
          'rejected',
        );
      });

      it('closes the log once the run is terminal', async () => {
        const { store, run } = await started();
        await store.finish(run.id, 'completed', null);
        const result = await store.append(run.id, { type: 'assistant', data: 1 });
        expect(result.kind).toBe('rejected');
      });
    });

    describe('openStream', () => {
      it('returns null for a run that does not exist, so the route can answer 404', async () => {
        const fixture = await make({});
        expect(await fixture.store.openStream(fixture.nextRun().id, null)).toBeNull();
      });

      it('replays the backlog then follows live events, in one sequence', async () => {
        const { store, run } = await started();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        await store.append(run.id, { type: 'assistant', data: 'b' });

        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        const taken = take(handle.events, 3);
        await store.append(run.id, { type: 'assistant', data: 'c' });
        expect((await taken).map((e) => e.data)).toEqual(['a', 'b', 'c']);
        handle.close();
      });

      it('does not strand an event appended while the consumer was mid-yield', async () => {
        // Regression. The first version of openStream armed its waiter only *after* draining the
        // backlog, so an append that landed while the generator was suspended at a `yield` found
        // no resolver, its notification was dropped, and the event sat in the log until some
        // later append happened to wake the stream. On a run whose last event is its
        // `run.status`, "some later append" never comes and the client waits for a completion
        // frame that has already been written.
        const { store, run } = await started();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        const taken = take(handle.events, 2);
        // Appended after the generator has already computed its backlog and yielded from it.
        await store.append(run.id, { type: 'assistant', data: 'b' });
        const seen = await Promise.race([
          taken,
          new Promise<'stranded'>((resolve) => setTimeout(() => resolve('stranded'), 1000)),
        ]);
        expect(seen).not.toBe('stranded');
        handle.close();
      });

      it('replays only what comes after the cursor', async () => {
        const { store, run } = await started();
        for (const data of ['a', 'b', 'c']) await store.append(run.id, { type: 'assistant', data });
        await store.finish(run.id, 'completed', null);

        const handle = await store.openStream(run.id, 2n);
        if (handle === null) throw new Error('no handle');
        expect(handle.reset).toBeNull();
        const seen: bigint[] = [];
        for await (const event of handle.events) seen.push(event.id);
        expect(seen).toEqual([3n]);
      });

      it('ends the stream when the run is already terminal, rather than hanging', async () => {
        const { store, run } = await started();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        await store.finish(run.id, 'failed', 'boom');
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        const seen: bigint[] = [];
        for await (const event of handle.events) seen.push(event.id);
        // One event, and then the loop terminated of its own accord rather than waiting for more.
        expect(seen).toEqual([1n]);
      });

      it('ends a live stream the moment the run reaches a terminal status', async () => {
        const { store, run } = await started();
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        const drained = (async () => {
          const seen: bigint[] = [];
          for await (const event of handle.events) seen.push(event.id);
          return seen;
        })();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        await store.finish(run.id, 'completed', null);
        expect(await drained).toEqual([1n]);
      });

      it('announces a reset when the cursor names events that have been evicted', async () => {
        const { store, run } = await started(3);
        for (let i = 0; i < 6; i += 1) await store.append(run.id, { type: 'assistant', data: i });
        // Ids 1-3 are gone; 4, 5, 6 are retained.
        const handle = await store.openStream(run.id, 1n);
        if (handle === null) throw new Error('no handle');
        expect(handle.reset).not.toBeNull();
        expect(handle.reset?.resumedAfter).toBe('3');
        const seen = await take(handle.events, 3);
        expect(seen.map((e) => e.id)).toEqual([4n, 5n, 6n]);
        handle.close();
      });

      it('announces a reset on a first connection after the beginning was evicted', async () => {
        const { store, run } = await started(3);
        for (let i = 0; i < 6; i += 1) await store.append(run.id, { type: 'assistant', data: i });
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        expect(handle.reset?.resumedAfter).toBe('3');
        const seen = await take(handle.events, 3);
        expect(seen.map((event) => event.id)).toEqual([4n, 5n, 6n]);
        handle.close();
      });

      it('announces a reset for a cursor ahead of anything the run produced', async () => {
        const { store, run } = await started();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        const handle = await store.openStream(run.id, 99n);
        if (handle === null) throw new Error('no handle');
        // Not an empty stream that waits forever for event 100: the cursor is wrong and says so.
        expect(handle.reset?.reason).toContain('no event after 99');
        const seen = await take(handle.events, 1);
        expect(seen.map((e) => e.id)).toEqual([1n]);
        handle.close();
      });

      it('does not announce a reset when the cursor is simply the newest event', async () => {
        const { store, run } = await started();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        const handle = await store.openStream(run.id, 1n);
        if (handle === null) throw new Error('no handle');
        expect(handle.reset).toBeNull();
        handle.close();
      });

      it('close() ends the iteration and is idempotent', async () => {
        const { store, run } = await started();
        const handle = await store.openStream(run.id, null);
        if (handle === null) throw new Error('no handle');
        const drained = (async () => {
          const seen: bigint[] = [];
          for await (const event of handle.events) seen.push(event.id);
          return seen;
        })();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        // Give the generator a turn to deliver the event before closing.
        await new Promise((resolve) => setTimeout(resolve, 0));
        handle.close();
        handle.close();
        expect(await drained).toEqual([1n]);
      });

      it('serves two concurrent subscribers from different cursors', async () => {
        const { store, run } = await started();
        await store.append(run.id, { type: 'assistant', data: 'a' });
        const fromStart = await store.openStream(run.id, null);
        const fromOne = await store.openStream(run.id, 1n);
        if (fromStart === null || fromOne === null) throw new Error('no handle');
        const a = take(fromStart.events, 2);
        const b = take(fromOne.events, 1);
        await store.append(run.id, { type: 'assistant', data: 'b' });
        expect((await a).map((e) => e.id)).toEqual([1n, 2n]);
        expect((await b).map((e) => e.id)).toEqual([2n]);
        fromStart.close();
        fromOne.close();
      });
    });

    describe('listRuns', () => {
      /**
       * A `limit` neither implementation will serve is refused by both, with the same message,
       * before anything is read (round 4 finding 3). This assertion used to run against the
       * repository alone, which is how `InMemoryRunStore` came to resolve `limit: 201` as an
       * ordinary page — no HTTP caller could reach it, `api.ts` answering `400 invalid_limit`
       * first, but a direct port caller could, and "one suite, two implementations" is this
       * port's stated contract. The fixture's workspace holds no run of its own, so `200` is
       * answered with an empty page rather than refused.
       */
      it('refuses limit 0, 1.5 and 201 by name and serves exactly 200', async () => {
        const fixture = await make({});
        const { workspaceId } = fixture.nextRun();
        const listRuns = fixture.store.listRuns.bind(fixture.store);
        await expect(listRuns(workspaceId, { limit: 0 })).rejects.toThrow(
          'listRuns limit must be a safe positive integer',
        );
        await expect(listRuns(workspaceId, { limit: 1.5 })).rejects.toThrow(
          'listRuns limit must be a safe positive integer',
        );
        await expect(listRuns(workspaceId, { limit: 201 })).rejects.toThrow(
          'listRuns limit must not exceed 200',
        );
        await expect(listRuns(workspaceId, { limit: 200 })).resolves.toEqual({
          items: [],
          nextCursor: null,
        });
      });
    });

    /**
     * F-21 property 10: a model-based run of arbitrary `markRunning` / `finish` / `append`
     * sequences against this implementation. A terminal status is absorbing (status and `endedAt`
     * never change again, and appends are refused), every appended id is greater than the last,
     * and the retained stream is strictly increasing and never longer than `maxEventsPerRun`. The
     * one-run-per-idempotency-key clause (F-09, ADR-0151) is the property after this one. On a
     * failure fast-check prints the seed and the command sequence.
     */
    describe('model-based lifecycle (property)', () => {
      interface Model {
        status: RunRecord['status'];
        endedAt: Date | null;
        lastId: bigint;
      }
      interface Real {
        readonly store: RunStore;
        readonly runId: string;
      }

      const settle = async (model: Model, real: Real): Promise<void> => {
        const record = await real.store.get(real.runId);
        expect(record?.status).toBe(model.status);
        if (!isTerminalRunStatus(model.status)) return;
        expect(record?.endedAt).toBeInstanceOf(Date);
        if (model.endedAt === null) model.endedAt = record?.endedAt ?? null;
        else expect(record?.endedAt).toEqual(model.endedAt);
      };

      const markRunning: fc.AsyncCommand<Model, Real> = {
        check: () => true,
        async run(model, real) {
          expect(await real.store.markRunning(real.runId)).toBe(model.status === 'queued');
          if (model.status === 'queued') model.status = 'running';
          await settle(model, real);
        },
        toString: () => 'markRunning',
      };

      const finish = (
        status: (typeof terminalRunStatuses)[number],
        emit: boolean,
      ): fc.AsyncCommand<Model, Real> => ({
        check: () => true,
        async run(model, real) {
          await real.store.finish(
            real.runId,
            status,
            status === 'completed' ? null : 'stopped',
            emit,
          );
          if (!isTerminalRunStatus(model.status)) model.status = status;
          await settle(model, real);
        },
        toString: () => `finish(${status}, ${String(emit)})`,
      });

      const append = (data: number): fc.AsyncCommand<Model, Real> => ({
        check: () => true,
        async run(model, real) {
          const result = await real.store.append(real.runId, { type: 'assistant', data });
          if (isTerminalRunStatus(model.status)) {
            expect(result.kind).toBe('rejected');
          } else {
            if (result.kind !== 'appended') throw new Error(`append refused: ${result.reason}`);
            expect(result.event.id > model.lastId).toBe(true);
            model.lastId = result.event.id;
          }
          await settle(model, real);
        },
        toString: () => `append(${String(data)})`,
      });

      const commands = fc.commands(
        [
          fc.constant(markRunning),
          fc
            .tuple(fc.constantFrom(...terminalRunStatuses), fc.boolean())
            .map(([s, e]) => finish(s, e)),
          fc.integer({ min: 0, max: 99 }).map(append),
        ],
        { maxCommands: 12 },
      );

      it('keeps terminal absorbing, ids increasing and retention within its bound', async () => {
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 1, max: 4 }), commands, async (max, sequence) => {
            const { store, run } = await started(max);
            const real: Real = { store, runId: run.id };
            const model: Model = { status: 'queued', endedAt: null, lastId: 0n };
            await fc.asyncModelRun(() => ({ model, real }), sequence);
            if (!isTerminalRunStatus(model.status)) await store.finish(run.id, 'completed', null);
            const handle = await store.openStream(run.id, null);
            if (handle === null) throw new Error('run had no event stream');
            const ids: bigint[] = [];
            for await (const event of handle.events) ids.push(event.id);
            expect(ids.length).toBeLessThanOrEqual(max);
            ids.slice(1).forEach((id, index) => expect(id > (ids[index] ?? id)).toBe(true));
          }),
          { numRuns: 25 },
        );
      });
    });

    /**
     * F-09 / ADR-0151: whatever sequence of starts reuses a small pool of keys, each key names
     * exactly one run — the first start's, with the first start's request hash — and every later
     * start under it is refused. Each run is finished before the next start, so the session is free
     * and only the key decides.
     */
    describe('start keys (property)', () => {
      it('gives each key exactly one run, the first one', async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.constantFrom('h1', 'h2')), {
              maxLength: 8,
            }),
            async (starts) => {
              const fixture = await make({});
              const principalId = crypto.randomUUID();
              const model = new Map<string, { runId: string; requestHash: string }>();
              let workspaceId = '';
              for (const [index, requestHash] of starts) {
                const key = `key-${String(index)}`;
                const run = {
                  ...fixture.nextRun(),
                  idempotency: { principalId, key, requestHash },
                };
                workspaceId = run.workspaceId;
                const held = model.get(key);
                if (held === undefined) {
                  await fixture.store.create(run);
                  await fixture.store.finish(run.id, 'completed', null);
                  model.set(key, { runId: run.id, requestHash });
                } else {
                  await expect(fixture.store.create(run)).rejects.toThrow(IdempotencyKeyTakenError);
                }
              }
              for (const [key, held] of model) {
                const found = await fixture.store.findByIdempotencyKey(
                  workspaceId,
                  principalId,
                  key,
                );
                expect({ runId: found?.run.id, requestHash: found?.requestHash }).toEqual(held);
              }
            },
          ),
          { numRuns: 20 },
        );
      });
    });
  });
}

// ── Implementation 1: in memory ─────────────────────────────────────────────────────────────

describeRunStoreConformance('the in-memory run store', ({ maxEventsPerRun }) => {
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  return Promise.resolve({
    store:
      maxEventsPerRun === undefined
        ? new InMemoryRunStore()
        : new InMemoryRunStore({ maxEventsPerRun }),
    nextRun: (): CreateRunInput => ({
      engine: 'claude-agent-sdk',
      id: crypto.randomUUID(),
      workspaceId,
      agentId,
      sessionId,
    }),
    // No referential integrity in this implementation, so any id will do.
    modelConnectionId: crypto.randomUUID(),
  });
});

// ── Implementation 2: PostgreSQL ────────────────────────────────────────────────────────────

const rawUrl = process.env['TEST_DATABASE_URL'];
const hasDatabase = rawUrl !== undefined && rawUrl.trim() !== '';

if (!hasDatabase) {
  console.warn(
    '[runs/store.test.ts] SKIPPED — TEST_DATABASE_URL is not set, so the PostgreSQL half of this ' +
      'conformance suite did NOT run. A green result without it says nothing about whether run ' +
      'records reach the database at all.',
  );
}

/** `apps/web/server/runs/<this file>` → the repository root, five levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

/**
 * The **declared** escape, not the public surface.
 *
 * A conformance suite has to insert the rows the repository under test reads — workspaces, users,
 * memberships, a model connection — and it cannot do that through the layer it is testing without
 * asserting that a function agrees with itself. That needs the raw handle and the table objects,
 * and since verification round 1 those live behind `@agent-workspace/core/db/unscoped`, which
 * throws when it is loaded by a process that has not identified itself as a test runner. This file
 * is such a process; a route handler is not. `packages/core/src/db/index.ts` records why.
 */
type CoreDb = typeof import('@agent-workspace/core/db/unscoped');

describe.skipIf(!hasDatabase)('the PostgreSQL run store', () => {
  let core: CoreDb;
  let isolated: Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;
  const membershipPrincipals = new Map<string, string>();

  async function createMembershipPrincipal(
    workspaceId: string,
    userId: string,
    role: 'owner' | 'admin' | 'builder' | 'viewer' = 'owner',
  ): Promise<string> {
    const membershipId = crypto.randomUUID();
    await isolated.db
      .insert(core.memberships)
      .values({ id: membershipId, workspaceId, userId, role });
    const principal = (await isolated.db.select().from(core.workspacePrincipals)).find(
      (candidate) => candidate.membershipId === membershipId,
    );
    if (principal === undefined) {
      throw new Error('the membership compatibility trigger did not create an exact principal');
    }
    const principalId = principal.id;
    membershipPrincipals.set(`${workspaceId}:${userId}`, principalId);
    return principalId;
  }

  function requireMembershipPrincipalId(workspaceId: string, userId: string): string {
    const principalId = membershipPrincipals.get(`${workspaceId}:${userId}`);
    if (principalId === undefined) {
      throw new Error('the run fixture membership has no exact principal');
    }
    return principalId;
  }

  beforeAll(async () => {
    const dist = path.join(
      repoRoot,
      'packages',
      'core',
      'dist',
      'db',
      'repositories',
      'unscoped.js',
    );
    // A positive assertion before the import, so the failure names its own remedy. Deliberately
    // not a skip: TEST_DATABASE_URL is set, so this half of the suite was asked for and must
    // either run or fail (ADR-0015).
    if (!existsSync(dist)) {
      throw new Error(
        `${dist} does not exist. Run \`pnpm --filter @agent-workspace/core run build\` before ` +
          '`pnpm test`; CI does this in a step of its own.',
      );
    }
    core = await import('@agent-workspace/core/db/unscoped');
    isolated = await core.createIsolatedTestDatabase('aw_w2db02_runs');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('refuses by name when the workspace a run names does not exist', async () => {
    const store = createRepositoryRunStore({
      repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
      events: core.createDatabaseRunEventRepositoryProvider(isolated.db),
      scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
      findRunWorkspace: (runId: string): Promise<string | null> =>
        core.findRunWorkspace(isolated.db, runId),
    });
    // A create against a workspace with no row is a named failure, not a run that quietly exists
    // nowhere. `get` on an id nothing has ever used stays `null`, because that one really is
    // "not found" and the route turns it into a 404.
    await expect(
      store.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: crypto.randomUUID(),
        agentId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(/no workspace has id/u);
    expect(await store.get(crypto.randomUUID())).toBeNull();
  });

  it('replays durable events through a newly constructed store instance', async () => {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db
      .insert(core.workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Restart replay' });
    await isolated.db
      .insert(core.users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Runner' });
    const ownerPrincipalId = await createMembershipPrincipal(workspaceId, userId);
    await isolated.db.insert(core.agents).values({
      id: agentId,
      workspaceId,
      name: 'Restart agent',
      instructions: '',
      modelConnectionId: null,
      model: null,
      createdBy: userId,
      ownerPrincipalId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(core.sessions)
      .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId });

    const makeStore = (): RunStore =>
      createRepositoryRunStore({
        repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
        events: core.createDatabaseRunEventRepositoryProvider(isolated.db),
        scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
        findRunWorkspace: (id: string): Promise<string | null> =>
          core.findRunWorkspace(isolated.db, id),
      });
    const firstProcess = makeStore();
    await firstProcess.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId,
      agentId,
      sessionId,
    });
    await firstProcess.markRunning(runId);
    await firstProcess.append(runId, { type: 'assistant', data: { text: 'before restart' } });
    await firstProcess.finish(runId, 'completed', null);

    const afterRestart = makeStore();
    const stream = await afterRestart.openStream(runId, null);
    if (stream === null) throw new Error('durable run was not found after restart');
    const seen: SseEvent[] = [];
    for await (const event of stream.events) seen.push(event);
    expect(seen).toMatchObject([{ id: 1n, type: 'assistant', data: { text: 'before restart' } }]);
    expect(seen[0]?.at).toBeInstanceOf(Date);

    // `runs.engine` round-trips through PostgreSQL (ADR-0065): the store that created the run is
    // gone, so this value can only have come from the row.
    const reread = await afterRestart.get(runId);
    expect(reread?.engine).toBe('claude-agent-sdk');
    expect(reread?.engineVersion ?? null).toBeNull();
  });

  it('upgrades pre-ENG-03 run_events rows on read, out of a real PostgreSQL log', async () => {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db
      .insert(core.workspaces)
      .values({ id: workspaceId, slug: workspaceId, name: 'Legacy upgrade' });
    await isolated.db
      .insert(core.users)
      .values({ id: userId, email: `${userId}@example.com`, name: 'Runner' });
    const ownerPrincipalId = await createMembershipPrincipal(workspaceId, userId);
    await isolated.db.insert(core.agents).values({
      id: agentId,
      workspaceId,
      name: 'Legacy upgrade agent',
      instructions: '',
      modelConnectionId: null,
      model: null,
      createdBy: userId,
      ownerPrincipalId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db
      .insert(core.sessions)
      .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId });

    const store = createRepositoryRunStore({
      repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
      events: core.createDatabaseRunEventRepositoryProvider(isolated.db),
      scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
      findRunWorkspace: (id: string): Promise<string | null> =>
        core.findRunWorkspace(isolated.db, id),
    });
    await store.create({ engine: 'claude-agent-sdk', id: runId, workspaceId, agentId, sessionId });
    await store.markRunning(runId);

    // Exactly what `relay.ts` wrote before ENG-03: the runner's classification envelope, under the
    // relayed name. Written through the public `append`, so these are rows a real run left behind.
    const messages: readonly unknown[] = [
      { type: 'system', subtype: 'init', session_id: 'sess_legacy', model: 'claude-opus-5' },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Reading.' },
            { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/a' } },
          ],
        },
      },
      { type: 'result', subtype: 'success', total_cost_usd: 0.25 },
    ];
    for (const [index, message] of messages.entries()) {
      const classified = classifySdkEvent(message);
      const appended = await store.append(runId, {
        type: index === 0 ? 'system' : index === 1 ? 'sdk-event' : 'result',
        data: { ...classified, event: message },
      });
      expect(appended.kind).toBe('appended');
    }
    await store.finish(runId, 'completed', null);

    const handle = await store.openStream(runId, null);
    if (handle === null) throw new Error('the durable run was not found');
    const served: SseWireEvent[] = [];
    for await (const event of upgradeEventStream(handle.events, null)) served.push(event);

    // A legacy log serves only `agent.*` frames, and exactly the frames a fresh run of the same
    // messages produces — the replay refinement of `docs/formal/domains/d1-runs.md`, over rows that
    // really went through PostgreSQL rather than through an in-memory map.
    const fresh = messages.flatMap((message) => [...toAgentFrames(classifySdkEvent(message))]);
    expect(served.map((event) => event.type)).toEqual(fresh.map((frame) => frame.frame));
    expect(served.map((event) => event.data)).toEqual(fresh);
    expect(served.map((event) => String(event.id))).toEqual(['1.0', '2.0', '2.1', '3.0']);
    for (const event of served) {
      expect(AgentFrameSchema.safeParse(event.data).success, event.type).toBe(true);
    }

    // And a resume that lands inside row 2 loses neither of its frames and repeats neither.
    const resumed = await store.openStream(runId, 1n);
    if (resumed === null) throw new Error('the durable run was not found on resume');
    const tail: SseWireEvent[] = [];
    for await (const event of upgradeEventStream(resumed.events, { sequence: 2n, subIndex: 0 })) {
      tail.push(event);
    }
    expect(tail.map((event) => String(event.id))).toEqual(['2.1', '3.0']);
  });

  it('delivers the terminal tail committed between event listing and the status read', async () => {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db.insert(core.workspaces).values({
      id: workspaceId,
      slug: workspaceId,
      name: 'Terminal tail',
    });
    await isolated.db.insert(core.users).values({
      id: userId,
      email: `${userId}@example.com`,
      name: 'Runner',
    });
    const ownerPrincipalId = await createMembershipPrincipal(workspaceId, userId);
    await isolated.db.insert(core.agents).values({
      id: agentId,
      workspaceId,
      name: 'Terminal tail agent',
      instructions: '',
      modelConnectionId: null,
      model: null,
      createdBy: userId,
      ownerPrincipalId,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    });
    await isolated.db.insert(core.sessions).values({
      id: sessionId,
      workspaceId,
      userId,
      agentId,
      ownerPrincipalId,
    });

    const baseEvents = core.createDatabaseRunEventRepositoryProvider(isolated.db);
    const storeRef: { current?: RunStore } = {};
    let inject = true;
    const events = {
      forScope(scope: Parameters<typeof baseEvents.forScope>[0]) {
        const repository = baseEvents.forScope(scope);
        return {
          append: (id: string, type: string, data: unknown, maxEvents: number) =>
            repository.append(id, type, data, maxEvents),
          bounds: (id: string) => repository.bounds(id),
          async list(id: string, after: bigint | null) {
            const snapshot = await repository.list(id, after);
            if (inject) {
              inject = false;
              const store = storeRef.current;
              if (store === undefined) throw new Error('run store missing');
              await store.appendPlatformEvent(id, {
                type: 'run.status',
                data: { status: 'completed' },
              });
              await store.finish(id, 'completed', null);
            }
            return snapshot;
          },
        };
      },
    };
    const store = createRepositoryRunStore({
      repositories: core.createDatabaseRunRepositoryProvider(isolated.db),
      events,
      scopes: core.createDatabaseWorkspaceScopeResolver(isolated.db),
      findRunWorkspace: (id: string) => core.findRunWorkspace(isolated.db, id),
    });
    storeRef.current = store;
    await store.create({
      engine: 'claude-agent-sdk',
      id: runId,
      workspaceId,
      agentId,
      sessionId,
    });
    await store.markRunning(runId);

    const stream = await store.openStream(runId, null);
    if (stream === null) throw new Error('created run had no stream');
    const delivered: bigint[] = [];
    for await (const event of stream.events) delivered.push(event.id);
    expect(delivered).toEqual([1n]);
    expect((await store.get(runId))?.status).toBe('completed');
  });

  describeRunStoreConformance(
    'over a real PostgreSQL, against the same suite',
    async ({ maxEventsPerRun }) => {
      // The whole referential chain a `runs` row needs: workspace → user → membership → agent →
      // session. Fresh every time, so this fixture collides with nothing else on the server.
      const workspaceId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      await isolated.db
        .insert(core.workspaces)
        .values({ id: workspaceId, slug: workspaceId, name: 'Runs' });
      await isolated.db
        .insert(core.users)
        .values({ id: userId, email: `${userId}@example.com`, name: 'Runner' });
      const ownerPrincipalId = await createMembershipPrincipal(workspaceId, userId);
      await isolated.db.insert(core.agents).values({
        id: agentId,
        workspaceId,
        name: 'General',
        instructions: '',
        modelConnectionId: null,
        model: null,
        createdBy: userId,
        ownerPrincipalId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await isolated.db
        .insert(core.sessions)
        .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId });

      const modelConnectionId = crypto.randomUUID();
      await isolated.db.insert(core.modelConnections).values({
        id: modelConnectionId,
        workspaceId,
        name: 'Snapshot fixture connection',
        provider: 'anthropic',
        config: {},
      });

      const db = isolated.db;
      return {
        store: createRepositoryRunStore({
          repositories: core.createDatabaseRunRepositoryProvider(db),
          events: core.createDatabaseRunEventRepositoryProvider(db),
          scopes: core.createDatabaseWorkspaceScopeResolver(db),
          findRunWorkspace: (runId: string): Promise<string | null> =>
            core.findRunWorkspace(db, runId),
          ...(maxEventsPerRun === undefined ? {} : { maxEventsPerRun }),
        }),
        nextRun: (): CreateRunInput => ({
          engine: 'claude-agent-sdk',
          id: crypto.randomUUID(),
          workspaceId,
          agentId,
          sessionId,
        }),
        modelConnectionId,
      };
    },
  );

  describe('listRuns (issue #135)', () => {
    it('carries attribution through the session join, stays tenant-scoped, composes filters, and paginates stably against concurrent inserts', async () => {
      const db = isolated.db;
      const acmeId = crypto.randomUUID();
      const bravoId = crypto.randomUUID();
      const ownerId = crypto.randomUUID();
      const builderId = crypto.randomUUID();
      const bravoUserId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      const bravoAgentId = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const otherProjectId = crypto.randomUUID();
      const ownerSessionId = crypto.randomUUID();
      const builderSessionId = crypto.randomUUID();
      const bravoSessionId = crypto.randomUUID();
      const modelConnectionId = crypto.randomUUID();

      await db.insert(core.workspaces).values([
        { id: acmeId, slug: acmeId, name: 'Acme (list)' },
        { id: bravoId, slug: bravoId, name: 'Bravo (list)' },
      ]);
      await db.insert(core.users).values([
        { id: ownerId, email: `${ownerId}@example.com`, name: 'Owner' },
        { id: builderId, email: `${builderId}@example.com`, name: 'Builder' },
        { id: bravoUserId, email: `${bravoUserId}@example.com`, name: 'Bravo user' },
      ]);
      const ownerPrincipalId = await createMembershipPrincipal(acmeId, ownerId);
      const builderPrincipalId = await createMembershipPrincipal(acmeId, builderId, 'builder');
      const bravoPrincipalId = await createMembershipPrincipal(bravoId, bravoUserId);
      const permissions = {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      };
      await db.insert(core.agents).values([
        {
          id: agentId,
          workspaceId: acmeId,
          name: 'List agent',
          instructions: '',
          createdBy: ownerId,
          ownerPrincipalId,
          permissions,
        },
        {
          id: bravoAgentId,
          workspaceId: bravoId,
          name: 'Bravo agent',
          instructions: '',
          createdBy: bravoUserId,
          ownerPrincipalId: bravoPrincipalId,
          permissions,
        },
      ]);
      await db.insert(core.projects).values([
        {
          id: projectId,
          workspaceId: acmeId,
          name: 'List project',
          createdBy: ownerId,
          ownerPrincipalId,
        },
        {
          id: otherProjectId,
          workspaceId: acmeId,
          name: 'Other project',
          createdBy: ownerId,
          ownerPrincipalId,
        },
      ]);
      await db.insert(core.sessions).values([
        {
          id: ownerSessionId,
          workspaceId: acmeId,
          userId: ownerId,
          agentId,
          projectId,
          ownerPrincipalId,
        },
        {
          id: builderSessionId,
          workspaceId: acmeId,
          userId: builderId,
          agentId,
          projectId: otherProjectId,
          ownerPrincipalId: builderPrincipalId,
        },
        {
          id: bravoSessionId,
          workspaceId: bravoId,
          userId: bravoUserId,
          agentId: bravoAgentId,
          ownerPrincipalId: bravoPrincipalId,
        },
      ]);
      // A session takes one run at a time, so every run of the owner's below gets a session of
      // its own, attributed exactly as `ownerSessionId` is.
      const ownerSession = async (): Promise<string> => {
        const id = crypto.randomUUID();
        await db.insert(core.sessions).values({
          id,
          workspaceId: acmeId,
          userId: ownerId,
          agentId,
          projectId,
          ownerPrincipalId,
        });
        return id;
      };
      await db.insert(core.modelConnections).values({
        id: modelConnectionId,
        workspaceId: acmeId,
        name: 'List fixture connection',
        provider: 'openai',
        config: {},
      });

      const acmeStore = createRepositoryRunStore({
        repositories: core.createDatabaseRunRepositoryProvider(db),
        events: core.createDatabaseRunEventRepositoryProvider(db),
        scopes: core.createDatabaseWorkspaceScopeResolver(db),
        findRunWorkspace: (runId: string): Promise<string | null> =>
          core.findRunWorkspace(db, runId),
      });
      // Wrapped in an arrow function rather than referenced directly, to avoid detaching a method
      // from its receiver (`@typescript-eslint/unbound-method`).
      const listRuns = (workspaceId: string, input: ListRunsInput): Promise<RunListPage> => {
        return acmeStore.listRuns(workspaceId, input);
      };
      // The *repository* directly, scope-bound to Acme — unlike `RunStore.get()`, which this
      // file's own header documents as identifying a run by id alone across every workspace
      // (`apps/web/server/runs/api.ts`'s `findRunForPrincipal` is the caller that enforces the
      // tenant check on that port). `RunRepository.get()` is scope-bound by construction, so it
      // is the right layer to prove issue #135's "a cross-workspace run id answers like a
      // nonexistent one" directly, against the same join `listRuns` uses.
      const acmeScope = await core.createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(acmeId);
      if (acmeScope === null) throw new Error('the Acme workspace did not resolve');
      const acmeRepo = core.createDatabaseRunRepositoryProvider(db).forScope(acmeScope);

      // A run in the OTHER workspace, whose id every assertion below must never see.
      const bravoRun = await acmeStore.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: bravoId,
        agentId: bravoAgentId,
        sessionId: bravoSessionId,
      });

      // Attribution: agent, project and initiating user are reached through the session join.
      const attributed = await acmeStore.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: acmeId,
        agentId,
        sessionId: await ownerSession(),
      });
      const attributedPage = await listRuns(acmeId, { limit: 200 });
      expect(attributedPage.items.find((run) => run.id === attributed.id)).toMatchObject({
        agentId,
        projectId,
        initiatingUserId: ownerId,
      });

      // Tenant isolation: Bravo's run never appears in Acme's list, and Acme's own scoped
      // repository answers the same `null` for Bravo's real id as it does for one nobody used.
      expect(attributedPage.items.some((run) => run.id === bravoRun.id)).toBe(false);
      expect(await acmeRepo.get(bravoRun.id)).toBeNull();
      expect(await acmeRepo.get(crypto.randomUUID())).toBeNull();

      // Filters compose as an intersection, not a union: three near-misses, one real match.
      const matches = await acmeStore.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: acmeId,
        agentId,
        sessionId: await ownerSession(),
      });
      const wrongStatus = await acmeStore.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: acmeId,
        agentId,
        sessionId: await ownerSession(),
      });
      const wrongProject = await acmeStore.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: acmeId,
        agentId,
        sessionId: builderSessionId,
      });
      const wrongProvider = await acmeStore.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId: acmeId,
        agentId,
        sessionId: await ownerSession(),
      });
      for (const run of [matches, wrongProject, wrongProvider]) {
        await acmeStore.snapshotModel(run.id, {
          connectionId: modelConnectionId,
          model: 'gpt-5.1',
          provider: run.id === wrongProvider.id ? 'anthropic' : 'openai',
        });
        await acmeStore.finish(run.id, 'failed', 'boom');
      }
      // wrongStatus keeps the same provider/project but is never finished (`queued`).
      await acmeStore.snapshotModel(wrongStatus.id, {
        connectionId: modelConnectionId,
        model: 'gpt-5.1',
        provider: 'openai',
      });

      const composed = await listRuns(acmeId, {
        limit: 200,
        filter: { status: 'failed', projectId, provider: 'openai' },
      });
      const composedIds = composed.items.map((run) => run.id);
      expect(composedIds).toContain(matches.id);
      expect(composedIds).not.toContain(wrongStatus.id);
      expect(composedIds).not.toContain(wrongProject.id);
      expect(composedIds).not.toContain(wrongProvider.id);

      // Cursor pagination: five fresh runs, walked two at a time, with three MORE runs created
      // between page one and page two. None of the five is seen twice, none is skipped, and none
      // of the three concurrently-inserted runs — newer than every cursor already issued — leaks
      // into a page it was never on.
      const marker = crypto.randomUUID();
      const seeded: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const run = await acmeStore.create({
          engine: 'claude-agent-sdk',
          id: crypto.randomUUID(),
          workspaceId: acmeId,
          agentId,
          sessionId: await ownerSession(),
        });
        await acmeStore.snapshotModel(run.id, {
          connectionId: modelConnectionId,
          model: marker,
          provider: 'openai',
        });
        seeded.push(run.id);
      }
      const collected = await walkPages<RunListCursor>(
        2,
        async (cursor) => {
          const page = await listRuns(acmeId, { limit: 2, filter: { model: marker }, cursor });
          return { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor };
        },
        async (pageIndex) => {
          if (pageIndex !== 0) return;
          for (let i = 0; i < 3; i += 1) {
            const run = await acmeStore.create({
              engine: 'claude-agent-sdk',
              id: crypto.randomUUID(),
              workspaceId: acmeId,
              agentId,
              sessionId: await ownerSession(),
            });
            await acmeStore.snapshotModel(run.id, {
              connectionId: modelConnectionId,
              model: marker,
              provider: 'openai',
            });
          }
        },
      );
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected.sort()).toEqual([...seeded].sort());
    });

    /** The fixture every round-2-finding-1 regression below needs and nothing more. */
    async function seedWorkspace(): Promise<{
      workspaceId: string;
      userId: string;
      principalId: string;
      agentId: string;
      sessionId: string;
    }> {
      const db = isolated.db;
      const workspaceId = crypto.randomUUID();
      const userId = crypto.randomUUID();
      const agentId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      await db.insert(core.workspaces).values({ id: workspaceId, slug: workspaceId, name: 'Tie' });
      await db.insert(core.users).values({ id: userId, email: `${userId}@example.com`, name: 'o' });
      const principalId = await createMembershipPrincipal(workspaceId, userId);
      await db.insert(core.agents).values({
        id: agentId,
        workspaceId,
        name: 'A',
        instructions: '',
        createdBy: userId,
        ownerPrincipalId: principalId,
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
      });
      await db
        .insert(core.sessions)
        .values({ id: sessionId, workspaceId, userId, agentId, ownerPrincipalId: principalId });
      return { workspaceId, userId, principalId, agentId, sessionId };
    }

    function makeStore(): RunStore {
      const db = isolated.db;
      return createRepositoryRunStore({
        repositories: core.createDatabaseRunRepositoryProvider(db),
        events: core.createDatabaseRunEventRepositoryProvider(db),
        scopes: core.createDatabaseWorkspaceScopeResolver(db),
        findRunWorkspace: (runId: string): Promise<string | null> =>
          core.findRunWorkspace(db, runId),
      });
    }

    /**
     * Round 2 finding 1: a keyset cursor boundary held as a JS `Date` truncates
     * `runs.created_at`'s microsecond precision to milliseconds, so the predicate compares a
     * rounded boundary against full-precision rows and silently drops every row that shares the
     * boundary's millisecond without sharing its microseconds — including two rows that are the
     * *same* instant, which any multi-row `INSERT` produces (`now()` is fixed for one statement).
     * `RunRepository.listRuns` now mints and reads the boundary as the database's own text, never
     * a `Date` — reverting that (restoring `cursor.createdAt`/`last.createdAt` as `Date`, and the
     * plain `lt`/`eq` comparison against it) makes this test fail with fewer than 6 ids collected.
     */
    it('keyset pagination does not skip runs sharing one created_at instant (round 2 finding 1: same-statement insert)', async () => {
      const db = isolated.db;
      const { workspaceId, sessionId } = await seedWorkspace();
      const store = makeStore();

      const marker = crypto.randomUUID();
      const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
      // One multi-row INSERT: PostgreSQL's `now()` is fixed for the whole statement, so every row
      // gets the identical `created_at`, to the microsecond.
      await db
        .insert(core.runs)
        .values(ids.map((id) => ({ id, workspaceId, sessionId, model: marker })));
      const inserted = await db.query.runs.findMany({
        where: (row, { eq }) => eq(row.model, marker),
      });
      expect(new Set(inserted.map((row) => row.createdAt.getTime())).size).toBe(1);

      const listRuns = store.listRuns.bind(store);
      const collected = await walkPages<RunListCursor>(2, async (cursor) => {
        const page = await listRuns(workspaceId, { limit: 2, filter: { model: marker }, cursor });
        return { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor };
      });
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected.sort()).toEqual([...ids].sort());
    });

    /**
     * The same defect (round 2 finding 1), reached through the application's own concurrency
     * path rather than a hand-built multi-row `INSERT`: 40 separate `RunRepository.create()`
     * calls, each its own transaction, routinely collide two or more runs onto the same
     * millisecond — the verifier's evidence lost 14 of 40 runs at `limit=1` before this fix.
     */
    it('keyset pagination does not skip runs created by concurrent RunRepository.create() calls (round 2 finding 1: Promise.all)', async () => {
      const { workspaceId, userId, principalId, agentId } = await seedWorkspace();
      const store = makeStore();

      // One session per run: a session takes one run at a time.
      const ids = Array.from({ length: 40 }, () => crypto.randomUUID());
      await isolated.db
        .insert(core.sessions)
        .values(
          ids.map((id) => ({ id, workspaceId, userId, agentId, ownerPrincipalId: principalId })),
        );
      await Promise.all(
        ids.map((id) =>
          store.create({
            engine: 'claude-agent-sdk',
            id,
            workspaceId,
            agentId,
            sessionId: id,
          }),
        ),
      );

      const listRuns = store.listRuns.bind(store);
      const collected = await walkPages<RunListCursor>(1, async (cursor) => {
        const page = await listRuns(workspaceId, { limit: 1, cursor });
        return { ids: page.items.map((run) => run.id), nextCursor: page.nextCursor };
      });
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected.sort()).toEqual([...ids].sort());
    });

    it('refuses a second open run on one session, and admits one once the first has ended', async () => {
      const { workspaceId, agentId, sessionId } = await seedWorkspace();
      const store = makeStore();
      const start = (id: string): Promise<RunRecord> =>
        store.create({ engine: 'claude-agent-sdk', id, workspaceId, agentId, sessionId });
      const first = await start(crypto.randomUUID());
      await expect(start(crypto.randomUUID())).rejects.toBeInstanceOf(SessionBusyError);
      await store.finish(first.id, 'completed', null);
      await expect(start(crypto.randomUUID())).resolves.toMatchObject({ status: 'queued' });
    });

    it('serves a run core holds at awaiting_approval, with the call it waits on', async () => {
      const { workspaceId, agentId, sessionId } = await seedWorkspace();
      const store = makeStore();
      const run = await store.create({
        engine: 'claude-agent-sdk',
        id: crypto.randomUUID(),
        workspaceId,
        agentId,
        sessionId,
      });
      await store.markRunning(run.id);
      const scope = await core
        .createDatabaseWorkspaceScopeResolver(isolated.db)
        .forWorkspaceId(workspaceId);
      if (scope === null) throw new Error('fixture workspace did not resolve');
      const paused = await core
        .createDatabaseRunRepositoryProvider(isolated.db)
        .forScope(scope)
        .awaitApproval(run.id, { toolName: 'send_email', canonicalCall: '{}' });
      expect(paused.kind).toBe('moved');

      await expect(store.get(run.id)).resolves.toMatchObject({
        status: 'awaiting_approval',
        pendingApproval: { toolName: 'send_email', canonicalCall: '{}' },
      });
    });

    /**
     * The same defect again, this time through the HTTP route's base64url-encoded cursor
     * (`list-query.ts`'s `encodeRunListCursor`/`decodeRunListCursor`) rather than the repository's cursor
     * object directly — round 2 finding 1 named `api.ts:334`'s `toISOString()` as an independent
     * place the same truncation happened, on every cursor this route ever handed a client.
     */
    it('GET /api/runs does not skip runs sharing one created_at instant, through the encoded HTTP cursor (round 2 finding 1)', async () => {
      const db = isolated.db;
      const { workspaceId, userId, principalId, sessionId } = await seedWorkspace();
      const store = makeStore();

      const marker = crypto.randomUUID();
      const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
      await db
        .insert(core.runs)
        .values(ids.map((id) => ({ id, workspaceId, sessionId, model: marker })));

      installTestRunApi({
        authenticate: () =>
          Promise.resolve({
            principalId,
            ownerPrincipalId: principalId,
            userId,
            workspaceId,
            role: 'owner',
            scope: null,
          }),
        findAgent: () => Promise.resolve(null),
        openSession: () => Promise.resolve(null),
        ownsRun: () => Promise.resolve(true),
        store,
        launch: () => undefined,
      });
      try {
        const collected = await walkPages<string>(2, (cursor) =>
          listOverHttp(`limit=2&model=${marker}`, cursor),
        );
        expect(new Set(collected).size).toBe(collected.length);
        expect(collected.sort()).toEqual([...ids].sort());
      } finally {
        resetTestRunApi();
      }
    });

    /** Install `store` behind the HTTP routes as an Owner of `workspaceId`, run `body`, uninstall. */
    async function asOwnerOf(
      workspaceId: string,
      userId: string,
      store: RunStore,
      body: () => Promise<void>,
    ): Promise<void> {
      const principalId = requireMembershipPrincipalId(workspaceId, userId);
      installTestRunApi({
        authenticate: () =>
          Promise.resolve({
            principalId,
            ownerPrincipalId: principalId,
            userId,
            workspaceId,
            role: 'owner',
            scope: null,
          }),
        findAgent: () => Promise.resolve(null),
        openSession: () => Promise.resolve(null),
        ownsRun: () => Promise.resolve(true),
        store,
        launch: () => undefined,
      });
      try {
        await body();
      } finally {
        resetTestRunApi();
      }
    }

    /**
     * The task card's verifier attack 2, verbatim: "page with `limit=2`, and between page one and
     * page two insert three new runs and delete one from page two. Assert no item is returned
     * twice and no pre-existing item is skipped." The delete is a raw `delete from runs` through
     * `db.execute`, the same way the microsecond test below sets `created_at` — neither
     * `RunRepository` nor `RunStore` deletes runs, and the attack needs no API for it. Once with
     * seven distinct instants, once with seven rows sharing one instant (a single multi-row
     * INSERT), so the row deleted is chosen from the `(created_at desc, id desc)` order in both
     * shapes a keyset boundary can take.
     */
    it.each([
      ['distinct created_at instants', false],
      ['one shared created_at instant', true],
    ])(
      'GET /api/runs at limit=2 survives three inserts and one delete between page one and page two (%s)',
      async (_shape, sameInstant) => {
        const db = isolated.db;
        const { workspaceId, userId, sessionId } = await seedWorkspace();
        const store = makeStore();
        const marker = crypto.randomUUID();
        const ids = Array.from({ length: 7 }, () => crypto.randomUUID());
        const t0 = Date.parse('2026-04-01T00:00:00.000Z');
        if (sameInstant) {
          await db
            .insert(core.runs)
            .values(ids.map((id) => ({ id, workspaceId, sessionId, model: marker })));
        } else {
          await db.insert(core.runs).values(
            ids.map((id, index) => ({
              id,
              workspaceId,
              sessionId,
              model: marker,
              createdAt: new Date(t0 + index * 1_000),
            })),
          );
        }
        // The order the list serves: newest first, then id descending. Page one is the first two
        // rows of it; the row deleted mid-walk is the first row page two would have shown.
        const ordered = sameInstant ? [...ids].sort().reverse() : [...ids].reverse();
        const deleted = ordered[2];
        if (deleted === undefined) throw new Error('seven runs have a third');
        const inserted: string[] = [];

        await asOwnerOf(workspaceId, userId, store, async () => {
          const collected = await walkPages<string>(
            2,
            (cursor) => listOverHttp(`limit=2&model=${marker}`, cursor),
            async (pageIndex) => {
              if (pageIndex !== 0) return;
              for (let i = 0; i < 3; i += 1) {
                const id = crypto.randomUUID();
                await db.insert(core.runs).values({ id, workspaceId, sessionId, model: marker });
                inserted.push(id);
              }
              await db.execute(`delete from runs where id = '${deleted}'`);
            },
          );
          expect(collected.slice(0, 2)).toEqual(ordered.slice(0, 2));
          expect(new Set(collected).size).toBe(collected.length);
          expect(collected).not.toContain(deleted);
          for (const id of inserted) expect(collected).not.toContain(id);
          expect([...collected].sort()).toEqual(ids.filter((id) => id !== deleted).sort());
        });
      },
    );

    /**
     * Issue #135's "duration and total tokens are deterministic derived values" and #134's
     * `accounting_state`, on a row whose every counter is non-zero and distinct, read back
     * through the repository and rendered by the route (round 4 finding 1). The list item is the
     * detail body, byte for byte.
     */
    it('GET /api/runs and GET /api/runs/:id render the same exact derived duration, total tokens and accounting state from real columns', async () => {
      const db = isolated.db;
      const { workspaceId, userId, sessionId } = await seedWorkspace();
      const store = makeStore();
      const id = crypto.randomUUID();
      const model = crypto.randomUUID();
      const modelConnectionId = crypto.randomUUID();
      await db.insert(core.modelConnections).values({
        id: modelConnectionId,
        workspaceId,
        name: 'Derived fixture connection',
        provider: 'openai',
        config: {},
      });
      await db.insert(core.runs).values({
        id,
        workspaceId,
        sessionId,
        status: 'completed',
        provider: 'openai',
        model,
        modelConnectionId,
        createdAt: new Date('2026-09-12T05:00:00.000Z'),
        startedAt: new Date('2026-09-12T05:00:01.000Z'),
        endedAt: new Date('2026-09-12T05:00:24.456Z'),
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
        toolCalls: 5,
        costUsd: '0.123456',
        priceTableVersion: 'v1',
        accountingState: 'complete',
      });

      await asOwnerOf(workspaceId, userId, store, async () => {
        const list = await listRunsOverHttp(new Request(`http://web/api/runs?model=${model}`));
        expect(list.status).toBe(200);
        const { runs } = (await list.json()) as { runs: Array<Record<string, unknown>> };
        expect(runs.map((run) => run['id'])).toEqual([id]);
        const detail = await readRunOverHttp(new Request(`http://web/api/runs/${id}`), id);
        expect(detail.status).toBe(200);
        const { run } = (await detail.json()) as { run: Record<string, unknown> };
        expect(runs[0]).toEqual(run);
        expect(run).toMatchObject({
          id,
          workspaceId,
          initiatingUserId: userId,
          status: 'completed',
          startedAt: '2026-09-12T05:00:01.000Z',
          endedAt: '2026-09-12T05:00:24.456Z',
          durationMs: 23_456,
          provider: 'openai',
          model,
          modelConnectionId,
          usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            totalTokens: 37,
            toolCalls: 5,
          },
          cost: { amount: '0.123456', currency: 'USD', priceTableVersion: 'v1' },
          accountingState: 'complete',
          accountingError: null,
        });
      });
    });

    /**
     * Round 4 finding 2: `from`/`to` were gated by `new Date(text)`, so a value JavaScript reads
     * and PostgreSQL refuses — a signed six-digit year, year 0 — threw out of the query as a
     * `500`, and the round-3 `createdTo + 1 ms` shift, done in JS, pushed the legal
     * `to=9999-12-31T23:59:59.999Z` into year 10000 and the same `500`. The refusals are asserted
     * as the documented `400`, by name, and the year-0001/9999 edges as `200` from the real query
     * — never "anything but 500".
     *
     * The last two probes are the parsing edges `api.test.ts` pins in memory, repeated here
     * because this is where the thrown query would surface. `.0999Z` is a fourth fractional digit
     * that does *not* roll the second, so it is refused by the digit rule of `RUN_LIST_BOUND`
     * alone — unlike `.1234Z`, which the calendar read-back would refuse anyway.
     * `9999-12-31T23:59:00-00:01` lands, after its offset, on exactly `10000-01-01T00:00:00.000Z`:
     * one instant past `LATEST_RUN_LIST_BOUND`, and the value `toISOString` would bind as
     * `+010000-01-01T00:00:00.000Z` if the bound ever moved past it.
     */
    it.each([
      '+275760-09-13T00:00:00.000Z',
      '-271821-04-20T00:00:00.000Z',
      '-000001-01-01T00:00:00.000Z',
      '0000-01-01T00:00:00Z',
      '2026-09-13T00:00:00',
      '1',
      '2026',
      'Sep 12 2026',
      '2026-09-12T00:00:00.0999Z',
      '9999-12-31T23:59:00-00:01',
    ])(
      'from=%j, and to= the same, is 400 invalid_from / invalid_to, never a thrown query',
      async (value) => {
        const { workspaceId, userId } = await seedWorkspace();
        await asOwnerOf(workspaceId, userId, makeStore(), async () => {
          const encoded = encodeURIComponent(value);
          expect(await listOverHttpStatus(`limit=1&from=${encoded}`)).toEqual({
            status: 400,
            code: 'invalid_from',
          });
          expect(await listOverHttpStatus(`limit=1&to=${encoded}`)).toEqual({
            status: 400,
            code: 'invalid_to',
          });
        });
      },
    );

    it('from/to at the year-0001 and year-9999 edges reach the real query and answer 200', async () => {
      const db = isolated.db;
      const { workspaceId, userId, sessionId } = await seedWorkspace();
      const model = crypto.randomUUID();
      const lastMs = crypto.randomUUID();
      const firstMs = crypto.randomUUID();
      // A run in the last millisecond PostgreSQL's `toISOString` binding can name, and one in the
      // first: the `to` bound at `.999Z` must include the former even though the millisecond
      // after it is year 10000.
      await db.insert(core.runs).values([
        { id: lastMs, workspaceId, sessionId, model },
        { id: firstMs, workspaceId, sessionId, model },
      ]);
      await db.execute(
        `update runs set created_at = '9999-12-31T23:59:59.999999Z' where id = '${lastMs}'`,
      );
      await db.execute(
        `update runs set created_at = '0001-01-01T00:00:00.000000Z' where id = '${firstMs}'`,
      );
      await asOwnerOf(workspaceId, userId, makeStore(), async () => {
        const top = encodeURIComponent('9999-12-31T23:59:59.999Z');
        const bottom = encodeURIComponent('0001-01-01T00:00:00Z');
        expect((await listOverHttp(`model=${model}&to=${top}`)).ids).toEqual([lastMs, firstMs]);
        expect((await listOverHttp(`model=${model}&from=${top}`)).ids).toEqual([lastMs]);
        expect((await listOverHttp(`model=${model}&from=${bottom}`)).ids).toEqual([
          lastMs,
          firstMs,
        ]);
        expect((await listOverHttp(`model=${model}&to=${bottom}`)).ids).toEqual([firstMs]);
        expect((await listOverHttp(`model=${model}&from=${bottom}&to=${top}`)).ids).toEqual([
          lastMs,
          firstMs,
        ]);
      });
    });

    /**
     * `parseRunListBound` right-pads a short fractional part before reading it as milliseconds, so
     * `from=…00.5Z` and `from=…00.50Z` both mean 500 ms and not 5 ms or 50 ms. Asserted here at
     * the precision `runs.created_at` actually holds: the `.499999` row is *below* a 500 ms bound
     * by a microsecond and must be excluded by `from`, while `to` keeps all three, because the
     * repository turns an inclusive `to` into `created_at < to + interval '1 millisecond'`. The
     * `.005000` row is what separates 500 ms from 5 ms in the `to` direction — without it, both
     * readings of the bound keep the same rows.
     */
    it('reads a one- and a two-digit from/to fraction as tenths and hundredths of a second, against microsecond created_at', async () => {
      const db = isolated.db;
      const { workspaceId, userId, sessionId } = await seedWorkspace();
      const model = crypto.randomUUID();
      const micros = ['005000', '499999', '500000'] as const;
      const at: Record<(typeof micros)[number], string> = {
        '005000': crypto.randomUUID(),
        '499999': crypto.randomUUID(),
        '500000': crypto.randomUUID(),
      };
      await db
        .insert(core.runs)
        .values(micros.map((micro) => ({ id: at[micro], workspaceId, sessionId, model })));
      for (const micro of micros) {
        await db.execute(
          `update runs set created_at = '2026-05-01T08:00:00.${micro}Z' where id = '${at[micro]}'`,
        );
      }

      await asOwnerOf(workspaceId, userId, makeStore(), async () => {
        for (const spelling of ['2026-05-01T08:00:00.5Z', '2026-05-01T08:00:00.50Z']) {
          const bound = encodeURIComponent(spelling);
          expect((await listOverHttp(`model=${model}&from=${bound}`)).ids).toEqual([at['500000']]);
          expect((await listOverHttp(`model=${model}&to=${bound}`)).ids).toEqual([
            at['500000'],
            at['499999'],
            at['005000'],
          ]);
        }
      });
    });

    /**
     * Round 3 (findings 1, 2, 3): **one run per predicate, differing from `base` in exactly
     * that predicate's column**, so that each `RunRepository.listRuns` predicate and each
     * `parseRunListQuery` assignment has one named test that fails, on real PostgreSQL, when
     * that predicate or assignment is deleted. The rounds before this one proved the filters
     * *composed* (three near-misses, one match), which a mutant that drops one predicate can
     * survive whenever another predicate already excludes the same near-miss — the verifier's
     * `wrongStatus` was also wrong-provider. Here nothing is excluded twice.
     *
     * Everything is inserted directly, with an explicit `created_at`, rather than through
     * `RunStore.create()`: the fixture is the *data*, and the code under test is the query.
     */
    describe('every predicate and every query assignment, one at a time (round 3)', () => {
      /** Every run in the fixture workspace, keyed by the one thing that sets it apart. */
      type Difference =
        | 'base'
        | 'otherUser'
        | 'otherAgent'
        | 'otherProject'
        | 'otherStatus'
        | 'otherProvider'
        | 'otherModel'
        | 'earlier'
        | 'later';

      interface DifferentialFixture {
        readonly store: RunStore;
        readonly workspaceId: string;
        /** `base`'s initiating user; an Owner of the workspace (grant `any`). */
        readonly ownerId: string;
        /** `base`'s exact session-owning workspace principal. */
        readonly ownerPrincipalId: string;
        /** `otherUser`'s initiating user; a Builder of the workspace (grant `own`). */
        readonly builderId: string;
        readonly agentId: string;
        readonly projectId: string;
        readonly model: string;
        /** `base`'s `created_at`; `earlier` is an hour before it and `later` an hour after. */
        readonly t0: Date;
        readonly runs: Readonly<Record<Difference, string>>;
        /** A run in another workspace with every column equal to `base`'s. */
        readonly otherWorkspaceRun: string;
      }

      const everyDifference: readonly Difference[] = [
        'base',
        'otherUser',
        'otherAgent',
        'otherProject',
        'otherStatus',
        'otherProvider',
        'otherModel',
        'earlier',
        'later',
      ];

      const sorted = (ids: readonly string[]): string[] => [...ids].sort();

      /** Every fixture run except the ones named — what a correct single filter returns. */
      const allExcept = (
        fixture: DifferentialFixture,
        ...excluded: readonly Difference[]
      ): string[] =>
        sorted(
          everyDifference
            .filter((difference) => !excluded.includes(difference))
            .map((difference) => fixture.runs[difference]),
        );

      let fixture: DifferentialFixture;

      beforeAll(async () => {
        const db = isolated.db;
        const workspaceId = crypto.randomUUID();
        const otherWorkspaceId = crypto.randomUUID();
        const ownerId = crypto.randomUUID();
        const builderId = crypto.randomUUID();
        const otherWorkspaceUserId = crypto.randomUUID();
        const agentId = crypto.randomUUID();
        const otherAgentId = crypto.randomUUID();
        const otherWorkspaceAgentId = crypto.randomUUID();
        const projectId = crypto.randomUUID();
        const otherProjectId = crypto.randomUUID();
        const session = {
          base: crypto.randomUUID(),
          otherUser: crypto.randomUUID(),
          otherAgent: crypto.randomUUID(),
          otherProject: crypto.randomUUID(),
          otherWorkspace: crypto.randomUUID(),
        };
        const model = crypto.randomUUID();
        const t0 = new Date('2026-03-01T12:00:00.000Z');
        const permissions = {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        };

        await db.insert(core.workspaces).values([
          { id: workspaceId, slug: workspaceId, name: 'Differential' },
          { id: otherWorkspaceId, slug: otherWorkspaceId, name: 'Differential (other)' },
        ]);
        await db.insert(core.users).values([
          { id: ownerId, email: `${ownerId}@example.com`, name: 'Owner' },
          { id: builderId, email: `${builderId}@example.com`, name: 'Builder' },
          { id: otherWorkspaceUserId, email: `${otherWorkspaceUserId}@example.com`, name: 'X' },
        ]);
        const ownerPrincipalId = await createMembershipPrincipal(workspaceId, ownerId);
        const builderPrincipalId = await createMembershipPrincipal(
          workspaceId,
          builderId,
          'builder',
        );
        const otherWorkspacePrincipalId = await createMembershipPrincipal(
          otherWorkspaceId,
          otherWorkspaceUserId,
        );
        await db.insert(core.agents).values([
          {
            id: agentId,
            workspaceId,
            name: 'A',
            instructions: '',
            createdBy: ownerId,
            ownerPrincipalId,
            permissions,
          },
          {
            id: otherAgentId,
            workspaceId,
            name: 'B',
            instructions: '',
            createdBy: ownerId,
            ownerPrincipalId,
            permissions,
          },
          {
            id: otherWorkspaceAgentId,
            workspaceId: otherWorkspaceId,
            name: 'X',
            instructions: '',
            createdBy: otherWorkspaceUserId,
            ownerPrincipalId: otherWorkspacePrincipalId,
            permissions,
          },
        ]);
        await db.insert(core.projects).values([
          { id: projectId, workspaceId, name: 'P', createdBy: ownerId, ownerPrincipalId },
          {
            id: otherProjectId,
            workspaceId,
            name: 'Q',
            createdBy: ownerId,
            ownerPrincipalId,
          },
        ]);
        // Four sessions in the workspace, each differing from `base`'s in exactly one column
        // the join reaches: the initiating user, the agent, or the project.
        await db.insert(core.sessions).values([
          {
            id: session.base,
            workspaceId,
            userId: ownerId,
            agentId,
            projectId,
            ownerPrincipalId,
          },
          {
            id: session.otherUser,
            workspaceId,
            userId: builderId,
            agentId,
            projectId,
            ownerPrincipalId: builderPrincipalId,
          },
          {
            id: session.otherAgent,
            workspaceId,
            userId: ownerId,
            agentId: otherAgentId,
            projectId,
            ownerPrincipalId,
          },
          {
            id: session.otherProject,
            workspaceId,
            userId: ownerId,
            agentId,
            projectId: otherProjectId,
            ownerPrincipalId,
          },
          {
            id: session.otherWorkspace,
            workspaceId: otherWorkspaceId,
            userId: otherWorkspaceUserId,
            agentId: otherWorkspaceAgentId,
            ownerPrincipalId: otherWorkspacePrincipalId,
          },
        ]);

        const runs: Record<Difference, string> = {
          base: crypto.randomUUID(),
          otherUser: crypto.randomUUID(),
          otherAgent: crypto.randomUUID(),
          otherProject: crypto.randomUUID(),
          otherStatus: crypto.randomUUID(),
          otherProvider: crypto.randomUUID(),
          otherModel: crypto.randomUUID(),
          earlier: crypto.randomUUID(),
          later: crypto.randomUUID(),
        };
        const otherWorkspaceRun = crypto.randomUUID();
        // `base`, verbatim; every other row below restates it with one column changed.
        const base = {
          workspaceId,
          sessionId: session.base,
          status: 'failed' as const,
          error: 'boom',
          endedAt: t0,
          provider: 'openai' as const,
          model,
          createdAt: t0,
        };
        await db.insert(core.runs).values([
          { ...base, id: runs.base },
          { ...base, id: runs.otherUser, sessionId: session.otherUser },
          { ...base, id: runs.otherAgent, sessionId: session.otherAgent },
          { ...base, id: runs.otherProject, sessionId: session.otherProject },
          // `queued`: the one status change the `runs_ended_at_iff_terminal` check lets stand
          // without also moving `ended_at`, which it then requires to be null.
          { ...base, id: runs.otherStatus, status: 'queued', error: null, endedAt: null },
          { ...base, id: runs.otherProvider, provider: 'anthropic' },
          { ...base, id: runs.otherModel, model: crypto.randomUUID() },
          { ...base, id: runs.earlier, createdAt: new Date(t0.getTime() - 3_600_000) },
          { ...base, id: runs.later, createdAt: new Date(t0.getTime() + 3_600_000) },
          {
            ...base,
            id: otherWorkspaceRun,
            workspaceId: otherWorkspaceId,
            sessionId: session.otherWorkspace,
          },
        ]);

        fixture = {
          store: makeStore(),
          workspaceId,
          ownerId,
          ownerPrincipalId,
          builderId,
          agentId,
          projectId,
          model,
          t0,
          runs,
          otherWorkspaceRun,
        };
      });

      /** The fixture's `RunStore.listRuns` for its own workspace. */
      const list = (input: ListRunsInput): Promise<RunListPage> => {
        return fixture.store.listRuns(fixture.workspaceId, input);
      };
      const listIds = async (input: ListRunsInput): Promise<string[]> =>
        sorted((await list(input)).items.map((run) => run.id));

      describe('RunRepository.listRuns', () => {
        it('tenant: an unfiltered list is every run in the workspace and nothing from another', async () => {
          const ids = await listIds({ limit: 200 });
          expect(ids).toEqual(allExcept(fixture));
          expect(ids).not.toContain(fixture.otherWorkspaceRun);
        });

        /**
         * One row per repository predicate, in `listRuns`'s own order, named by the filter
         * field it reads. The filter names the value `base` has, so a correct predicate excludes
         * exactly the one run that differs in that column and nothing else; a deleted predicate
         * lets that run back in.
         */
        it.each<{
          readonly predicate: string;
          readonly filter: (fixture: DifferentialFixture) => NonNullable<ListRunsInput['filter']>;
          readonly excludes: Difference;
        }>([
          {
            predicate: 'status',
            filter: () => ({ status: 'failed' }),
            excludes: 'otherStatus',
          },
          {
            predicate: 'agentId',
            filter: ({ agentId }) => ({ agentId }),
            excludes: 'otherAgent',
          },
          {
            predicate: 'projectId',
            filter: ({ projectId }) => ({ projectId }),
            excludes: 'otherProject',
          },
          {
            predicate: 'provider',
            filter: () => ({ provider: 'openai' }),
            excludes: 'otherProvider',
          },
          {
            predicate: 'model',
            filter: ({ model }) => ({ model }),
            excludes: 'otherModel',
          },
          {
            predicate: 'createdFrom',
            filter: ({ t0 }) => ({ createdFrom: t0 }),
            excludes: 'earlier',
          },
          {
            predicate: 'createdTo',
            filter: ({ t0 }) => ({ createdTo: t0 }),
            excludes: 'later',
          },
          {
            predicate: 'initiatingUserId',
            filter: ({ ownerId }) => ({ initiatingUserId: ownerId }),
            excludes: 'otherUser',
          },
          {
            predicate: 'ownerPrincipalId',
            filter: ({ ownerPrincipalId }) => ({ ownerPrincipalId }),
            excludes: 'otherUser',
          },
        ])(
          'the $predicate predicate excludes exactly the run that differs in that column',
          async ({ filter, excludes }) => {
            const ids = await listIds({ limit: 200, filter: filter(fixture) });
            expect(ids).toEqual(allExcept(fixture, excludes));
            expect(ids).not.toContain(fixture.runs[excludes]);
          },
        );

        it('every predicate at once is the intersection: exactly `base`', async () => {
          const ids = await listIds({
            limit: 200,
            filter: {
              status: 'failed',
              agentId: fixture.agentId,
              projectId: fixture.projectId,
              provider: 'openai',
              model: fixture.model,
              createdFrom: fixture.t0,
              createdTo: fixture.t0,
              initiatingUserId: fixture.ownerId,
              ownerPrincipalId: fixture.ownerPrincipalId,
            },
          });
          expect(ids).toEqual([fixture.runs.base]);
        });

        it('limit: a page is exactly `limit` rows, and `hasMore` is answered by the extra row', async () => {
          const page = await list({ limit: 4 });
          expect(page.items).toHaveLength(4);
          expect(page.nextCursor).not.toBeNull();
          const whole = await list({ limit: everyDifference.length });
          expect(whole.items).toHaveLength(everyDifference.length);
          expect(whole.nextCursor).toBeNull();
        });

        it('cursor: pages at limit 4 are disjoint, exactly 4 long until the last, and cover the workspace', async () => {
          const pages: string[][] = [];
          const collected = await walkPages<RunListCursor>(4, async (cursor) => {
            const page = await list({ limit: 4, cursor });
            const ids = page.items.map((run) => run.id);
            pages.push(ids);
            return { ids, nextCursor: page.nextCursor };
          });
          expect(pages.map((page) => page.length)).toEqual([4, 4, 1]);
          expect(new Set(collected).size).toBe(collected.length);
          expect(sorted(collected)).toEqual(allExcept(fixture));
        });
      });

      describe('GET /api/runs over the repository store', () => {
        /** Install the fixture store behind the route as `principal`, run `body`, uninstall. */
        const asPrincipal = async (
          principal: { readonly userId: string; readonly role: 'owner' | 'builder' },
          body: () => Promise<void>,
        ): Promise<void> => {
          const principalId = requireMembershipPrincipalId(fixture.workspaceId, principal.userId);
          installTestRunApi({
            authenticate: () =>
              Promise.resolve({
                ...principal,
                principalId,
                ownerPrincipalId: principalId,
                workspaceId: fixture.workspaceId,
                scope: null,
              }),
            findAgent: () => Promise.resolve(null),
            openSession: () => Promise.resolve(null),
            ownsRun: () => Promise.resolve(true),
            store: fixture.store,
            launch: () => undefined,
          });
          try {
            await body();
          } finally {
            resetTestRunApi();
          }
        };
        const asOwner = (body: () => Promise<void>): Promise<void> =>
          asPrincipal({ userId: fixture.ownerId, role: 'owner' }, body);

        /**
         * One row per `parseRunListQuery` filter assignment, named by the query parameter it
         * copies onto `filter`. Each query names the value `base` has, so the assignment it
         * exercises excludes exactly one run; an assignment deleted from `api.ts` (the parameter
         * validated but never copied onto `filter`) lets it back in.
         */
        it.each<{
          readonly assignment: string;
          readonly query: (fixture: DifferentialFixture) => string;
          readonly excludes: Difference;
        }>([
          { assignment: 'status=', query: () => 'status=failed', excludes: 'otherStatus' },
          {
            assignment: 'agent=',
            query: ({ agentId }) => `agent=${agentId}`,
            excludes: 'otherAgent',
          },
          {
            assignment: 'project=',
            query: ({ projectId }) => `project=${projectId}`,
            excludes: 'otherProject',
          },
          {
            assignment: 'provider=',
            query: () => 'provider=openai',
            excludes: 'otherProvider',
          },
          {
            assignment: 'model=',
            query: ({ model }) => `model=${model}`,
            excludes: 'otherModel',
          },
          {
            assignment: 'from=',
            query: ({ t0 }) => `from=${t0.toISOString()}`,
            excludes: 'earlier',
          },
          {
            assignment: 'to=',
            query: ({ t0 }) => `to=${t0.toISOString()}`,
            excludes: 'later',
          },
          {
            assignment: 'user= (grant any)',
            query: ({ ownerId }) => `user=${ownerId}`,
            excludes: 'otherUser',
          },
        ])(
          '$assignment as an Owner excludes exactly the run that differs in that column',
          async ({ query, excludes }) => {
            await asOwner(async () => {
              const { ids } = await listOverHttp(`limit=200&${query(fixture)}`);
              expect(sorted(ids)).toEqual(allExcept(fixture, excludes));
              expect(ids).not.toContain(fixture.runs[excludes]);
            });
          },
        );

        it("filter.ownerPrincipalId = principal.principalId (grant own): a Builder's unfiltered list is only their exact principal's run, on real PostgreSQL", async () => {
          await asPrincipal({ userId: fixture.builderId, role: 'builder' }, async () => {
            const { ids } = await listOverHttp('limit=200');
            expect(ids).toEqual([fixture.runs.otherUser]);
          });
        });

        it('limit = Number(rawLimit): `limit=4` serves exactly 4 runs and a next cursor', async () => {
          await asOwner(async () => {
            const page = await listOverHttp('limit=4');
            expect(page.ids).toHaveLength(4);
            expect(page.nextCursor).not.toBeNull();
          });
        });

        it('cursor: the decoded cursor reaches the store, so pages at limit 4 are disjoint and cover the workspace', async () => {
          await asOwner(async () => {
            const pages: string[][] = [];
            const collected = await walkPages<string>(4, async (cursor) => {
              const page = await listOverHttp('limit=4', cursor);
              pages.push(page.ids);
              return page;
            });
            expect(pages.map((page) => page.length)).toEqual([4, 4, 1]);
            expect(new Set(collected).size).toBe(collected.length);
            expect(sorted(collected)).toEqual(allExcept(fixture));
          });
        });

        /**
         * Round 3 finding 4: a cursor whose `createdAt` JavaScript's `Date` accepts but
         * PostgreSQL does not used to pass `decodeRunListCursor` and throw out of the query as a
         * `500`. Every probe here is the verifier's, plus the shapes the two stores actually
         * mint as the positive control; the assertion is the documented `400 invalid_cursor`,
         * never "anything but 500".
         */
        it.each([
          '1',
          '2026',
          'Sep 12 2026',
          '12/31/2026',
          '2026-09-12',
          '2026-09-12T00:00:00Z',
          '2026-09-12T00:00:00.123456789Z',
          '+275760-09-13T00:00:00.000Z',
          '-000001-01-01T00:00:00.000Z',
          '2026-09-12T00:00:00.000+05:30',
          '2026-09-12 00:00:00 GMT+0900',
          'Thu, 01 Jan 1970 00:00:00 GMT',
          '2026-09-12T24:00:00.000000Z',
          '2026-02-30T00:00:00.000000Z',
          '2026-13-01T00:00:00.000000Z',
          '2026-09-12T23:59:60.000000Z',
          '0000-01-01T00:00:00.000000Z',
          '0000-01-01T00:00:00Z',
        ])(
          'a cursor whose createdAt is %j is 400 invalid_cursor, never a thrown query',
          async (createdAt) => {
            await asOwner(async () => {
              const cursor = Buffer.from(
                JSON.stringify({ createdAt, id: fixture.runs.base }),
                'utf8',
              ).toString('base64url');
              const outcome = await listOverHttpStatus(
                `limit=1&cursor=${encodeURIComponent(cursor)}`,
              );
              expect(outcome).toEqual({ status: 400, code: 'invalid_cursor' });
            });
          },
        );

        it.each([
          ['the repository (six fractional digits)', '2026-03-01T12:00:00.000000Z'],
          ['InMemoryRunStore (three fractional digits)', '2026-03-01T12:00:00.000Z'],
          ['PostgreSQL year 1', '0001-01-01T00:00:00.000000Z'],
        ])(
          'a cursor in the shape %s mints is accepted and applied by the real query',
          async (_shape, createdAt) => {
            await asOwner(async () => {
              // The boundary is `base`'s own `(created_at, id)`, so the page is every run strictly
              // before it in `(created_at desc, id desc)` order — no throw, no 500, a real answer.
              const cursor = Buffer.from(
                JSON.stringify({ createdAt, id: fixture.runs.base }),
                'utf8',
              ).toString('base64url');
              const { ids } = await listOverHttp('limit=200', cursor);
              expect(ids).not.toContain(fixture.runs.base);
              expect(ids).not.toContain(fixture.runs.later);
            });
          },
        );
      });

      /**
       * Round 3 finding 5: `to` is inclusive at the precision the API renders, and round 4
       * finding 4: exclusive of the very next millisecond. Four runs, at `.122999`, `.123000`,
       * `.123999` and `.124000` around a bound of `.123Z`: `to` keeps the first three and drops
       * the fourth — the row at exactly `createdTo + 1 ms`, which an `lte` in place of the `lt`
       * would leak in — and `from` keeps the last three. Through the repository directly and
       * through `GET /api/runs`, where the bound is the `.123999` run's own rendered `createdAt`.
       */
      it('a run is inside a date range built from its own rendered createdAt, at microsecond created_at, and the next millisecond is outside it', async () => {
        const db = isolated.db;
        const { workspaceId, userId, sessionId } = await seedWorkspace();
        const store = makeStore();
        const listRuns = store.listRuns.bind(store);
        const model = crypto.randomUUID();
        const micros = ['122999', '123000', '123999', '124000'] as const;
        const at: Record<(typeof micros)[number], string> = {
          '122999': crypto.randomUUID(),
          '123000': crypto.randomUUID(),
          '123999': crypto.randomUUID(),
          '124000': crypto.randomUUID(),
        };
        await db
          .insert(core.runs)
          .values(micros.map((micro) => ({ id: at[micro], workspaceId, sessionId, model })));
        for (const micro of micros) {
          await db.execute(
            `update runs set created_at = '2026-03-01T12:00:00.${micro}Z' where id = '${at[micro]}'`,
          );
        }
        const [record] = (await listRuns(workspaceId, { limit: 1, filter: { model } })).items;
        if (record === undefined) throw new Error('the runs were not listed');
        expect(record.id).toBe(at['124000']);
        const [inLastMicros] = (
          await listRuns(workspaceId, {
            limit: 1,
            filter: { model, createdTo: new Date(record.createdAt.getTime() - 1) },
          })
        ).items;
        if (inLastMicros === undefined) throw new Error('the .123999 run was not listed');
        expect(inLastMicros.id).toBe(at['123999']);
        const rendered = inLastMicros.createdAt.toISOString();
        expect(rendered).toBe('2026-03-01T12:00:00.123Z');

        const bound = new Date(rendered);
        const before = new Date(bound.getTime() - 1);
        const after = new Date(bound.getTime() + 1);
        const idsWith = async (filter: NonNullable<ListRunsInput['filter']>): Promise<string[]> =>
          (await listRuns(workspaceId, { limit: 10, filter: { model, ...filter } })).items
            .map((run) => run.id)
            .sort();
        const sortedIds = (...keys: readonly (typeof micros)[number][]): string[] =>
          keys.map((key) => at[key]).sort();
        expect(await idsWith({ createdTo: bound })).toEqual(
          sortedIds('122999', '123000', '123999'),
        );
        expect(await idsWith({ createdFrom: bound })).toEqual(
          sortedIds('123000', '123999', '124000'),
        );
        expect(await idsWith({ createdFrom: bound, createdTo: bound })).toEqual(
          sortedIds('123000', '123999'),
        );
        expect(await idsWith({ createdTo: before })).toEqual(sortedIds('122999'));
        expect(await idsWith({ createdFrom: after })).toEqual(sortedIds('124000'));

        await asOwnerOf(workspaceId, userId, store, async () => {
          const inside = await listOverHttp(`model=${model}&from=${rendered}&to=${rendered}`);
          expect([...inside.ids].sort()).toEqual(sortedIds('123000', '123999'));
          const upTo = await listOverHttp(`model=${model}&to=${rendered}`);
          expect(upTo.ids).not.toContain(at['124000']);
          expect([...upTo.ids].sort()).toEqual(sortedIds('122999', '123000', '123999'));
          const outside = await listOverHttp(`model=${model}&to=${before.toISOString()}`);
          expect(outside.ids).toEqual([at['122999']]);
        });
      });
    });
  });
});

/**
 * **Nothing that a deployment runs constructs {@link InMemoryRunStore}.**
 *
 * Round 1 of verification found `store.ts` (now split into `store.ts` and `memory-store.ts`) claiming that `apps/web/instrumentation.ts` "refuses to
 * install it unless an operator asked for it by name", of a mechanism that did not exist. Round 2
 * found its replacement — "its two real consumers are this file's own conformance suite and
 * `…/acceptance/instrumentation.ts`" — also false: there are more importers than that, and the
 * number had been written rather than measured (ADR-0016). A third sentence would be a third
 * guess, so this block measures it instead, and prints the derived set on every failure.
 *
 * ## How the set is derived (ADR-0027)
 *
 * `git ls-files` with no pathspec, then two classifiers, each ending in rejection:
 *
 *   1. every tracked path is a module this block parses or a file no `import` specifier can
 *      resolve to, decided by extension; an extension in neither set fails by name;
 *   2. every module that imports the name `InMemoryRunStore` from a specifier resolving to
 *      `memory-store.ts` is either a `*.test.ts`/`*.test.tsx` suite, or a harness — a module that names
 *      the `AW_ACCEPTANCE_HARNESS` environment variable it refuses to run without. Any other
 *      importer is a hard failure naming the file, because that is a module a deployment could
 *      load.
 *
 * The imported *name* is read from the import clause with the TypeScript parser, so
 * `import { InMemoryRunStore }`, `import { InMemoryRunStore as X }` and `import * as store` are
 * each seen for what they are, and the class name appearing in a comment or a string is not.
 *
 * ## Where a specifier points is the compiler's answer, not a comparison of its text (ADR-0030)
 *
 * This block used to expand a specifier through an alias table it built out of the tracked
 * configuration files. That table was a model of a resolver, and verification rounds walked past
 * it repeatedly — through a `paths` alias, then through a `paths` block reached by an `extends`
 * target whose extension is not `.json` and which TypeScript loads verbatim. So the table is gone:
 * `resolutionsOf` below asks `ts.resolveModuleName` and compares the resolved path — put through
 * `realpathSync`, as is this module's own path — against this module. `paths`, `baseUrl`,
 * `extends` of any filename, `exports` maps and workspace symlinks are all the compiler's job.
 *
 * ## Which options a specifier resolves through: project membership, also the compiler's answer
 *
 * Not the nearest `tsconfig.json` above the importing file. Walking up the directory tree is a
 * model of *project membership*, and round 5 walked past it: a tracked
 * `apps/web/server/leak/tsconfig.json` remapping `@/*` onto a stub redirected this gate while
 * `tsc -p apps/web/tsconfig.json` and `next build` went on resolving that file through
 * `apps/web/tsconfig.json`. A project's membership is its `files`/`include` globs, not the
 * directories above a file.
 *
 * So every tracked `tsconfig*.json` — found by shape, out of the same `git ls-files` listing this
 * block already reads — is parsed, and the set of files its **program** contains is that project's
 * membership. Not `parsed.fileNames`: those are the project's *root* names, and a `tsc -p` program
 * is that set plus everything the roots import, each of which resolves its own specifiers through
 * that project's options.
 *
 * A module's contexts are then the **union of three sets, never a choice between them**: every
 * project whose program contains it, the repository root `tsconfig.json`, and every tracked project
 * whose configuration file sits at or above it. The last two are this gate's choice rather than the
 * compiler's answer, and they are not decoration: this tree tracks `.mjs` and `.js` modules that no
 * project here compiles, so they are in no project's program and have no owner to ask. Taking the
 * union rather than preferring the owners
 * is the correction round 5 forced: the earlier version returned the owners exclusively whenever
 * there were any, so one `exclude` edit plus one nested `tsconfig.json` made the attacker's project
 * the only one consulted. A configuration file added to the tree adds contexts and removes none,
 * and `resolutionsOf` is monotone in its contexts, so an importer this gate already classifies
 * cannot be taken away by adding one. Measured: with `apps/web/server/leak/vattack-runstore.ts`
 * importing the class through `@/server/runs/store`, `"server/leak"` in `apps/web`'s `exclude` and
 * a nested `apps/web/server/leak/tsconfig.json` remapping `@/*` onto a stub, this gate is red and
 * reports `other: apps/web/server/leak/vattack-runstore.ts`. That sentence is about **importers**.
 * It is deliberately not a claim about the hard failures below: a context added to the set can give
 * a resolution to a specifier that previously resolved nowhere, and the throw that specifier used
 * to raise would then not be raised.
 *
 * A dynamic import expression or a CommonJS require whose argument is not a string literal is a
 * hard failure: its specifier is a run-time value, and a gate that read nothing out of it would
 * report the file as a non-importer. So is a *path* specifier the compiler cannot resolve that
 * names no file on disk either. (Said without the call syntax on purpose:
 * `tests/no-sdk-import.test.ts` scans comments too, and a bare call construct with no literal
 * argument reads as undecidable to it.)
 *
 * ## Every call site gets a verdict (ADR-0031 clause 1)
 *
 * A call, a construction or a tagged template that is neither of those two constructs does not fall
 * out of the walk unread. It is asked one question — *is this call handed a string that resolves to
 * `memory-store.ts`, by a callee this file cannot vouch for?* — and it leaves with one of two
 * verdicts: **refused**, naming the file, the callee as written and the module; or **decided**,
 * meaning no string this gate can read at that call site names `memory-store.ts`.
 *
 * "Vouched for" is not a list of callee names. It is: the callee is rooted at an identifier this
 * file declares and does not bind straight to another reference. So a property chain ending in
 * `require` — reached through `globalThis`, `require.main` or `process.mainModule` — a bare
 * `require` inside a parenthesised comma expression, whose root *is* `require` once the parentheses
 * and the comma are unwrapped, and a `require` bound to another name and called through it are all
 * refused, as is any **construction**, because a constructed `Worker` loads and runs a module.
 * (Written without the call syntax on purpose, for the reason the paragraph above gives.)
 *
 * ## Where that stops
 *
 * A string this gate cannot read at the call site is not examined: a specifier arriving through a
 * parameter, assembled by a computation, or inside the source text handed to `eval` or to the
 * `Function` constructor. Those last two are measured open and are in this PR's declared gaps.
 * The rule is deliberately not "refuse every call handed a string": a string at a call site is
 * resolved by `stringNamesTheStore`, which reaches no verdict of "unresolvable", because
 * `fetch('/api/agents')` in `apps/web/components/agents/agent-form.tsx` is a string and not a
 * reference this gate failed to decide — measured, routing it through `namesTheStore` instead
 * fails this gate on that component.
 */
describe('nothing a deployment loads constructs the in-memory run store', () => {
  /** `apps/web/server/runs/<this file>` → the repository root, five levels up. */
  const root = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
  const toPosix = (value: string): string => value.split(path.sep).join('/');

  /** The repository root as the filesystem spells it, so both sides of a comparison agree. */
  const realRoot = realpathSync(root);

  /** One absolute path, resolved through any symlinks, as a repository-relative posix path. */
  const relativeReal = (absolute: string): string => {
    let real = absolute;
    try {
      real = realpathSync(absolute);
    } catch {
      // Not on disk, so there are no links to follow; compared as written.
    }
    return toPosix(path.relative(realRoot, real));
  };

  /** The in-memory store module, repository-relative — derived from this file's own path. */
  const storeModule = relativeReal(
    fileURLToPath(import.meta.url).replace(/store\.test\.ts$/u, 'memory-store.ts'),
  );

  const MODULE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  const NON_MODULE_EXTENSIONS = new Set([
    '',
    '.avif',
    '.conf',
    '.css',
    '.csv',
    '.dockerfile',
    // A Word draft (tests/gallery/contract-review): a zip of XML parts a tool reads.
    '.docx',
    // A CAD drawing in ASCII DXF (tests/gallery/cad-drafting): group-code/value lines a tool reads.
    '.dxf',
    '.example',
    '.gif',
    '.gitkeep',
    '.html',
    '.hcl',
    '.ico',
    '.jpeg',
    '.jpg',
    '.json',
    '.jsonc',
    '.lean',
    '.lock',
    '.map',
    '.md',
    '.mdx',
    '.npmrc',
    // A manual a tool reads (tests/gallery/manual-search/data/manuals).
    '.pdf',
    '.png',
    '.ps1',
    '.sh',
    '.snap',
    '.sql',
    '.service',
    '.svg',
    '.tf',
    '.tftpl',
    // A Helm named-template partial (infra/helm/*/templates/_helpers.tpl).
    '.tpl',
    '.timer',
    '.toml',
    '.txt',
    // A WebVTT meeting transcript (tests/gallery/meeting-minutes).
    '.vtt',
    '.webp',
    '.woff',
    '.woff2',
    // An Excel workbook (tests/gallery/excel-consolidation): a zip of XML parts a tool reads.
    '.xlsx',
    '.yaml',
    '.yml',
  ]);

  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\0')
    .filter((file) => file !== '');

  const modules: string[] = [];
  for (const file of tracked) {
    const extension = path.posix.extname(file).toLowerCase();
    if (MODULE_EXTENSIONS.has(extension)) modules.push(file);
    else if (NON_MODULE_EXTENSIONS.has(extension)) {
      // Prose, data, configuration or an asset: no import specifier resolves to it.
    } else {
      throw new Error(
        `${file} has the extension "${extension}", which this gate neither parses as a module ` +
          'nor recognises as a file no import specifier can resolve to. Decide which it is; do ' +
          'not leave it unclassified.',
      );
    }
  }

  /** The host `ts.getParsedCommandLineOfConfigFile` reads a `tsconfig.json` through. */
  const parseConfigHost: ts.ParseConfigFileHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: (rootDir, extensions, excludes, includes, depth): readonly string[] =>
      ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
    fileExists: (fileName): boolean => ts.sys.fileExists(fileName),
    readFile: (fileName): string | undefined => ts.sys.readFile(fileName),
    getCurrentDirectory: (): string => ts.sys.getCurrentDirectory(),
    onUnRecoverableConfigFileDiagnostic: (diagnostic): never => {
      throw new Error(
        'a tsconfig this gate needs could not be read: ' +
          ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
      );
    },
  };

  /**
   * One parsed TypeScript project: the options a specifier inside it resolves through, and the set
   * of files the project compiles.
   */
  interface Project {
    readonly configPath: string;
    readonly options: ts.CompilerOptions;
    readonly cache: ts.ModuleResolutionCache;
    readonly files: ReadonlySet<string>;
  }

  /**
   * Parse one tracked configuration into a project, membership included, so that `extends` —
   * including a target whose extension is not `.json`, which TypeScript loads verbatim when the
   * file exists — `baseUrl`, `paths` and the `files`/`include`/`exclude` globs are the compiler's
   * answer and not this gate's.
   *
   * Membership is the **program**, not `parsed.fileNames`. Those are the project's *root* names;
   * the program `tsc -p` builds is that set plus everything the roots import, and an imported file
   * resolves its own specifiers through this project's options. Round 5 reached the store through
   * the difference: a file dropped out of `apps/web`'s `include` was still in the program
   * `tsc -p apps/web/tsconfig.json` builds, while a gate reading root names alone handed it to
   * whichever nested configuration claimed it.
   */
  const parseProject = (relative: string): Project => {
    const configPath = path.join(root, relative);
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, parseConfigHost);
    if (parsed === undefined) {
      throw new Error(`${relative} did not parse, so this gate cannot resolve anything under it.`);
    }
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    return {
      configPath: relative,
      options: parsed.options,
      cache: ts.createModuleResolutionCache(
        path.dirname(configPath),
        (fileName) => (ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase()),
        parsed.options,
      ),
      files: new Set(program.getSourceFiles().map((file) => relativeReal(file.fileName))),
    };
  };

  /** The repository's root configuration, whose options every other config in the tree extends. */
  const ROOT_CONFIG = 'tsconfig.json';
  const trackedConfigs = tracked.filter((file) => /(?:^|\/)tsconfig[^/]*\.json$/u.test(file));
  if (!trackedConfigs.includes(ROOT_CONFIG)) {
    throw new Error(
      `${ROOT_CONFIG} is not tracked. This gate resolves a module that no project compiles under ` +
        'the repository root options, and cannot do that while there are none.',
    );
  }
  const allProjects = trackedConfigs.map(parseProject);
  const compilingProjects = allProjects.filter((project) => project.files.size > 0);
  const declaredRootProject = allProjects.find((project) => project.configPath === ROOT_CONFIG);
  if (declaredRootProject === undefined) {
    throw new Error(`${ROOT_CONFIG} is tracked but produced no project, so this gate cannot run.`);
  }
  const rootProject: Project = declaredRootProject;

  /** Is `configPath`'s directory at or above `relative`? */
  const sitsAbove = (configPath: string, relative: string): boolean => {
    const directory = path.posix.dirname(configPath);
    return directory === '.' || relative.startsWith(`${directory}/`);
  };

  /**
   * The projects a module's specifiers are resolved under: **the union of three sets, never a
   * choice between them** — every project whose program contains the module, the repository root
   * `tsconfig.json`, and every tracked project whose configuration file sits at or above it. The
   * last two are this gate's choice rather than the compiler's answer.
   *
   * Taking the union rather than preferring the owners is the correction round 5 forced: the
   * earlier version returned the owning projects exclusively whenever there were any, so a nested
   * `tsconfig.json` claiming a file `apps/web`'s `exclude` had just dropped became the only project
   * consulted, and `apps/web`'s `paths` were discarded. Adding a configuration file adds projects
   * and removes none, so with the union no configuration file can subtract a context.
   */
  const contextsFor = (relative: string): readonly Project[] => {
    const owners = compilingProjects.filter((project) => project.files.has(relative));
    const above = allProjects.filter(
      (project) => project !== rootProject && sitsAbove(project.configPath, relative),
    );
    return [...new Set<Project>([...owners, rootProject, ...above])];
  };

  /**
   * Every file one specifier points at — one answer per project that compiles the importing file,
   * as repository-relative real paths.
   *
   * TypeScript is asked once per context, and the filesystem once more. A path naming a file the
   * compiler has no type for, such as a stylesheet, is loaded by a bundler at exactly the path the
   * specifier spells, so that path is **added** to the answer rather than used only when every
   * context declines — which keeps this function monotone in its contexts: one more context can
   * only add a resolution, never replace one. What is left over is a built-in module, which names
   * no file anywhere; and a path naming nothing, which is a hard failure — a reference this gate
   * cannot decide (ADR-0015). A bare specifier every context declines is a package none of them can
   * find from that file, and it reaches no module at all.
   */
  const resolutionsOf = (from: string, specifier: string): readonly string[] => {
    const absolute = path.join(root, from);
    const contexts = contextsFor(from);
    const files = new Set<string>();
    for (const context of contexts) {
      const resolved = ts.resolveModuleName(
        specifier,
        absolute,
        context.options,
        ts.sys,
        context.cache,
      );
      if (resolved.resolvedModule !== undefined) {
        files.add(relativeReal(resolved.resolvedModule.resolvedFileName));
      }
    }
    const onDisk = specifier.startsWith('.') || path.isAbsolute(specifier);
    if (onDisk) {
      const asWritten = path.resolve(path.dirname(absolute), specifier);
      if (existsSync(asWritten) && statSync(asWritten).isFile()) {
        files.add(relativeReal(asWritten));
      }
    }
    if (files.size > 0) return [...files];
    if (isBuiltin(specifier)) return [];
    if (onDisk) {
      throw new Error(
        `${from} imports "${specifier}", a path that TypeScript (through ` +
          `${contexts.map((context) => context.configPath).join(', ')}) cannot resolve and that ` +
          'names no file on disk. This gate decides where a reference points by resolving it, so ' +
          'a path it cannot resolve is a reference it cannot decide (ADR-0015).',
      );
    }
    return [];
  };

  /**
   * Does this specifier, written in `from`, name `memory-store.ts` under **any** project whose program
   * contains `from`, or under the widened set? The union is deliberate: adding a configuration file
   * to the tree adds contexts and removes none, and `resolutionsOf` is monotone in its contexts, so
   * an importer this gate already classifies cannot be taken away by adding one. That sentence is
   * about importers; the header says which arm of this file it is not a claim about.
   */
  const namesTheStore = (from: string, specifier: string): boolean =>
    resolutionsOf(from, specifier).includes(storeModule);

  /**
   * Does one string read at an arbitrary call site name `memory-store.ts`?
   *
   * The same two questions `resolutionsOf` asks — the compiler once per context, then the
   * filesystem — with neither of its two failures. A string handed to an arbitrary call is not
   * known to be a specifier, so one that resolves to nothing is a string rather than a reference
   * this gate could not decide. Measured: `fetch('/api/agents')` in
   * `apps/web/components/agents/agent-form.tsx` is why this exists beside `namesTheStore` rather
   * than calling it — through `namesTheStore` that string is a path naming no file, and the gate
   * fails on the form component.
   */
  const stringNamesTheStore = (from: string, candidate: string): boolean => {
    const absolute = path.join(root, from);
    for (const context of contextsFor(from)) {
      const resolved = ts.resolveModuleName(
        candidate,
        absolute,
        context.options,
        ts.sys,
        context.cache,
      );
      const file = resolved.resolvedModule?.resolvedFileName;
      if (file !== undefined && relativeReal(file) === storeModule) return true;
    }
    if (candidate.startsWith('.') || path.isAbsolute(candidate)) {
      const asWritten = path.resolve(path.dirname(absolute), candidate);
      if (
        existsSync(asWritten) &&
        statSync(asWritten).isFile() &&
        relativeReal(asWritten) === storeModule
      ) {
        return true;
      }
    }
    return false;
  };

  /** One expression with the wrappers that do not change what it denotes taken off. */
  const unwrapExpression = (node: ts.Expression | undefined): ts.Expression | undefined => {
    let current = node;
    for (;;) {
      if (current === undefined) return undefined;
      if (ts.isParenthesizedExpression(current)) current = current.expression;
      else if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.CommaToken
      ) {
        // `(0, require)` denotes its right operand: the callee IS `require`, spelled around a
        // comma. Unwrapping is why closing this shape needed no new callee name.
        current = current.right;
      } else if (
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current)
      ) {
        current = current.expression;
      } else return current;
    }
  };

  /** The identifier a callee is rooted at: `globalThis` in `globalThis.require`. */
  const calleeRootName = (callee: ts.Expression): string | null => {
    let current: ts.Expression = callee;
    for (;;) {
      const unwrapped = unwrapExpression(current);
      if (unwrapped === undefined) return null;
      if (ts.isPropertyAccessExpression(unwrapped) || ts.isElementAccessExpression(unwrapped)) {
        current = unwrapped.expression;
        continue;
      }
      return ts.isIdentifier(unwrapped) ? unwrapped.text : null;
    }
  };

  /**
   * Every identifier one file binds, which of them are bound straight to another reference, and
   * which to a string literal.
   *
   * Not a scope model, and not an answer to "what is in scope". It answers the one question the
   * call classifier asks: *can this gate see where the thing being called was made?* A callee
   * rooted at a name the file declares is a value this file produced; a callee rooted at a free
   * name — `require` in a CommonJS module, `globalThis`, `process`, `eval` — came from somewhere
   * the walk cannot look; and a name bound straight to another reference is not vouched for, which
   * is what `const load = require;` turns on. A name declared anywhere in the file vouches for
   * every use of it, which errs towards passing a call, and that is stated rather than discovered.
   */
  const bindingsIn = (
    source: ts.SourceFile,
  ): {
    declared: ReadonlySet<string>;
    aliased: ReadonlySet<string>;
    constants: ReadonlyMap<string, string>;
  } => {
    const declared = new Set<string>();
    const aliased = new Set<string>();
    const constants = new Map<string, string>();
    const declareName = (name: ts.Node | undefined): void => {
      if (name === undefined) return;
      if (ts.isIdentifier(name)) declared.add(name.text);
      else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
          if (ts.isBindingElement(element)) declareName(element.name);
        }
      }
    };
    const walk = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) {
        declareName(node.name);
        const initializer = unwrapExpression(node.initializer);
        if (initializer !== undefined && ts.isIdentifier(node.name)) {
          if (ts.isStringLiteralLike(initializer)) constants.set(node.name.text, initializer.text);
          else if (
            ts.isIdentifier(initializer) ||
            ts.isPropertyAccessExpression(initializer) ||
            ts.isElementAccessExpression(initializer)
          ) {
            aliased.add(node.name.text);
          }
        }
      } else if (ts.isParameter(node) || ts.isBindingElement(node)) declareName(node.name);
      else if (
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node) ||
        ts.isImportSpecifier(node)
      ) {
        declareName(node.name);
      } else if (
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isImportEqualsDeclaration(node)
      ) {
        declareName(node.name);
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    return { declared, aliased, constants };
  };

  /**
   * Every string this gate can read at one call site: literal arguments, names bound to a literal
   * in this file, and the elements of an array literal handed in — `Reflect.apply(fn, null, ['…'])`
   * and `fn(...['…'])` write the specifier out at the call site all the same.
   */
  const stringsHandedTo = (
    call: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
    constants: ReadonlyMap<string, string>,
  ): readonly string[] => {
    const found: string[] = [];
    const read = (node: ts.Expression | undefined): void => {
      const value = unwrapExpression(node);
      if (value === undefined) return;
      if (ts.isStringLiteralLike(value)) found.push(value.text);
      else if (ts.isIdentifier(value)) {
        const constant = constants.get(value.text);
        if (constant !== undefined) found.push(constant);
      } else if (ts.isArrayLiteralExpression(value)) {
        for (const element of value.elements) read(element);
      } else if (ts.isSpreadElement(value)) read(value.expression);
    };
    if (ts.isTaggedTemplateExpression(call)) {
      if (ts.isNoSubstitutionTemplateLiteral(call.template)) found.push(call.template.text);
      return found;
    }
    for (const argument of call.arguments ?? []) read(argument);
    return found;
  };

  /**
   * The one computed dynamic import the Owner decided, recorded in ADR-0115 and held identically
   * by `packages/core/src/db/repositories/database-reachability.test.ts`: the module it names is
   * chosen by the developer at run time and is never `memory-store.ts`. Exact repository paths only,
   * never a glob; the assertion below pins the list to exactly this entry.
   */
  const COMPUTED_IMPORT_DECISIONS: ReadonlyMap<string, string> = new Map([
    [
      'packages/aw/src/tools/host-child.ts',
      "imports the developer's own run files by path; decided in ADR-0115",
    ],
  ]);

  /** One call site as written, collapsed onto a line, for a failure message to name it by. */
  const snippet = (node: ts.Node): string => {
    const text = node.getText().replace(/\s+/gu, ' ').trim();
    return text.length > 72 ? `${text.slice(0, 69)}...` : text;
  };

  const importsTheClass = (source: ts.SourceFile, from: string): boolean => {
    let found = false;
    const fileBindings = bindingsIn(source);

    /**
     * A static `import` declaration is the only shape this gate can read a bound name out of, so
     * every other way of reaching `memory-store.ts` is a hard failure rather than a quiet `false`: a
     * `const { InMemoryRunStore } = await import('./memory-store')` in a route handler would otherwise be
     * invisible to a classifier that looked only at import declarations (ADR-0027 clause 3).
     */
    const walk = (node: ts.Node): void => {
      if (ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (
          specifier !== undefined &&
          ts.isStringLiteralLike(specifier) &&
          namesTheStore(from, specifier.text)
        ) {
          throw new Error(
            `${from} re-exports from ${storeModule}. This gate classifies direct importers, and a ` +
              're-export makes the class reachable from a module it does not name. Decide what ' +
              'that means before adding one.',
          );
        }
      } else if (
        ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node)
      ) {
        // Every call site leaves this branch with a verdict; nothing falls through it (ADR-0031
        // clause 1). The first arm reads a specifier out of the two constructs this gate names.
        // The `else` does not ask whether the callee is a resolver — no list of callee names ever
        // finishes answering that — it asks whether the call is handed a string that resolves to
        // `memory-store.ts` by a callee this file cannot vouch for, and refuses that.
        const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
        const dynamic = ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword;
        const required =
          ts.isCallExpression(node) && ts.isIdentifier(callee) && callee.text === 'require';
        const argument = ts.isTaggedTemplateExpression(node) ? undefined : node.arguments?.[0];
        if (!dynamic && !required) {
          // A **construction** is never vouched for: a constructed `Worker` loads and runs a
          // module, and the rule below — which asks only whether this file binds the callee's root
          // name — passes one whose `Worker` came out of a destructured `require`.
          const rootName = ts.isCallExpression(node) ? calleeRootName(callee) : null;
          const vouched =
            rootName !== null &&
            fileBindings.declared.has(rootName) &&
            !fileBindings.aliased.has(rootName);
          if (!vouched) {
            for (const candidate of stringsHandedTo(node, fileBindings.constants)) {
              if (!stringNamesTheStore(from, candidate)) continue;
              throw new Error(
                `${from} hands ${JSON.stringify(candidate)} to \`${snippet(callee)}\`, and that ` +
                  `string resolves to ${storeModule}. This gate cannot show the call is not a ` +
                  'module load: its callee is neither a construct this gate reads a specifier ' +
                  'from nor a name this file binds. Refused rather than passed over (ADR-0031 ' +
                  'clause 1), because a module reached that way carries the class while this ' +
                  'gate reads no bound name out of it.',
              );
            }
          }
          // The other arm, and a decision rather than a fall-through: no string this gate can read
          // at this call site resolves to `memory-store.ts`, so at this call site nothing names it. What
          // that leaves outside is in the header — a specifier arriving through a parameter, a
          // computation, or the source text handed to `eval`.
        } else {
          if (argument === undefined || !ts.isStringLiteralLike(argument)) {
            // A decided exception (ADR-0115), for the one file and the dynamic kind it names: it
            // is read as having no edge from this call, so nothing here names `memory-store.ts`.
            if (dynamic && COMPUTED_IMPORT_DECISIONS.has(from)) {
              ts.forEachChild(node, walk);
              return;
            }
            // The specifier is a run-time value, so this gate cannot tell whether it names
            // `memory-store.ts`. In verification round 3 a module that put `'./store'` in a `const` and
            // awaited a dynamic import of that binding constructed the class, while a check for a
            // string literal argument reported nothing.
            throw new Error(
              `${from} calls a dynamic import or require with an argument that is not a string ` +
                'literal, so this gate cannot tell which module it names. Write the specifier as ' +
                'a literal, or decide what a computed one means here; do not leave it unread.',
            );
          }
          if (namesTheStore(from, argument.text)) {
            throw new Error(
              `${from} reaches ${storeModule} through a dynamic import or require. This gate ` +
                'reads the bound name out of static import declarations and cannot read it out ' +
                'of that, so it fails rather than reporting the file as a non-importer.',
            );
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);

    for (const statement of source.statements) {
      const specifier = ts.isImportDeclaration(statement) ? statement.moduleSpecifier : undefined;
      const bindings =
        specifier !== undefined &&
        ts.isStringLiteralLike(specifier) &&
        namesTheStore(from, specifier.text) &&
        ts.isImportDeclaration(statement)
          ? statement.importClause?.namedBindings
          : undefined;
      if (bindings === undefined) {
        // Not an import of this module, or an import that binds no name from it (a default-only
        // or side-effect-only import). Either way it carries no `InMemoryRunStore`.
      } else if (ts.isNamespaceImport(bindings)) {
        // `import * as store from './store'` carries every export, this class among them.
        found = true;
      } else {
        for (const element of bindings.elements) {
          if ((element.propertyName?.text ?? element.name.text) === 'InMemoryRunStore')
            found = true;
        }
      }
    }
    return found;
  };

  /** Does this module name the environment variable the acceptance harness will not run without? */
  const namesTheHarnessVariable = (source: ts.SourceFile): boolean => {
    let found = false;
    const walk = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) && node.text === 'AW_ACCEPTANCE_HARNESS') found = true;
      ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
  };

  const suites: string[] = [];
  const harnesses: string[] = [];
  const deployable: string[] = [];
  for (const file of modules) {
    const extension = path.posix.extname(file).toLowerCase();
    const source = ts.createSourceFile(
      path.join(root, file),
      readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    if (file === storeModule || !importsTheClass(source, file)) {
      // Not an importer, or the module that declares the class. Nothing to classify.
    } else if (/\.test\.tsx?$/u.test(file)) {
      suites.push(file);
    } else if (namesTheHarnessVariable(source)) {
      harnesses.push(file);
    } else {
      deployable.push(file);
    }
  }

  const derivedSet = (): string =>
    `suites: ${suites.join(', ') || '(none)'}\nharnesses: ${harnesses.join(', ') || '(none)'}\n` +
    `other: ${deployable.join(', ') || '(none)'}`;

  it('holds exactly one decided computed dynamic import: the one ADR-0115 names', () => {
    expect([...COMPUTED_IMPORT_DECISIONS.keys()]).toEqual(['packages/aw/src/tools/host-child.ts']);
  });

  it('found importers to classify, so the classification is not vacuous', () => {
    expect(
      suites.length + harnesses.length + deployable.length,
      `no module imports InMemoryRunStore from ${storeModule}. Either the specifier resolver is ` +
        `broken or the class was renamed; either way this gate proved nothing.\n${derivedSet()}`,
    ).toBeGreaterThan(0);
  });

  it('classifies every importer as a suite or as the acceptance harness', () => {
    expect(
      deployable,
      'These modules import InMemoryRunStore and are neither a *.test.ts suite nor a harness ' +
        'that names AW_ACCEPTANCE_HARNESS, so a deployment could load one of them and quietly ' +
        `serve runs out of a Map that a restart empties.\n${derivedSet()}`,
    ).toEqual([]);
  });

  it('found the acceptance harness among them, so the harness arm is not dead', () => {
    expect(
      harnesses.length,
      'no importer named AW_ACCEPTANCE_HARNESS, so the harness arm of this classification has ' +
        `never been taken and would not be noticed if it stopped working.\n${derivedSet()}`,
    ).toBeGreaterThan(0);
  });
});
