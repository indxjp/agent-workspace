# R-stream

## Attacker model and candidate witnesses

The attacker can supply stream bytes and event names through a runtime, choose a run cursor and
request timing. The attacker must not
forge a platform or control event, make a client accept a malformed or split frame, or lose or
duplicate a durable frame. The Lean counterexamples are checked against the real parser and store
boundaries below.

| Focus                         | Model seam                                                                          | Real replay needed                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A5 name injection             | `Sse.classifyEventName` rejects a newline-bearing name                              | `sse.ts#classifyEventName` and the real append boundary                                        |
| A5 resume cursor              | invalid present header blocks fallback to a valid query                             | `cursor.ts#readResumeCursor` with a newline-bearing header                                     |
| A5 lone CR                    | `SdkSse.splitSseFrames` leaves a lone-CR frame unsplit                              | `packages/sdk/src/events/sse.ts#readSseFrames` against chunked CR, LF, and CRLF                |
| A5 tail loss                  | `RunLog.repositoryCycle` lists before a later terminal read                         | PostgreSQL-backed `createRepositoryRunStore` with a controlled append/finish between the reads |
| A5 duplicate terminal         | two appends precede first-call-wins finish                                          | real interrupt and launcher with barriers at their append/finish boundary                      |
| A5 first truncated connection | `RunLog.resetFor` now announces a gap with an absent cursor when oldest id exceeds 1 | both stores with retention limit below event count and `after = null`              |
| A5 indeterminate outcome      | `Sse.outcomeFrames` writes unknown failure then `done` for a live run               | real server SSE response and SDK `waitForOutcome`                                              |
| A5 empty SDK id               | `SdkSse.parseSseFrame` preserves `id:` as an empty string                           | real SDK `follow` now clears the cursor and omits `last-event-id` after PR #287               |

The repository follow loop in `apps/web/server/runs/store.ts` lists pending events at lines
974–978 and then returns on a terminal run read at lines 980–981. The interrupt hook in
`apps/web/server/composition/register.ts` and `launcher.ts#conclude` both append a terminal
`run.status` before calling `finish`. These precise seams define the interleavings for the real
tests. security finding withheld; see the private ledger.

## Verification

The narrow theorem/vector build passed 20 jobs and generated thirteen vectors. Twelve replay
through real TypeScript in the app formal suite (12/12): all control names and platform-only
classification, invalid, oversized, and zero-padded resume cursors, SDK two- and three-line data,
lone-CR handling and empty-id reconnect, retention and both nonempty/empty ahead-cursor resets,
running and queued terminal closure, an indeterminate server outcome through SDK wait, and the
duplicate terminal interleaving. A separate focused real
launcher/interrupt handler replay passed 1/1 with a controlled finish barrier and reproduced the
duplicate terminal event; its temporary test and output are preserved below. App TypeScript
typecheck and focused ESLint pass. The thirteenth vector was reproduced over real PostgreSQL
(1/1): the active stream missed the event committed after its list snapshot and before its
terminal-status read, while a new stream found that persisted event. The temporary test is
reproduced verbatim below and was removed after verification.

The targeted `lake exe axioms` audited 1,323 declarations with only the three permitted axioms;
`lake exe imports` checked 29 layer edges. The independent frozen-source pass killed one of eight
fresh definition mutations and exposed seven theorem breadth gaps. The exact eight mutations were
rerun after repair: all eight now fail the named theorem build, including the seven former
survivors. They cover the last reserved runtime name, alternate platform and stored-control names,
a twenty-digit zero-padded cursor, a third SDK data line, an empty-log ahead reset, queued-run
terminal closure, and a terminal-tail off-by-one. The earlier thirteen author mutations also
failed their named builds. Every upstream source file was restored byte-for-byte; a final clean
20-job build and 12/12 replay passed. A separate verifier then reran three of the former
survivors (reserved runtime name, zero-padded cursor, and third SDK data line): all three failed
at the strengthened theorem statements, and the source was restored.

## Correctness findings for triage

- **F-100, medium:** The real PostgreSQL follow loop can end after a terminal read without
  delivering an event committed since its list snapshot. This contradicts S-233, S-237, S-239,
  and S-236 in `docs/formal/domains/d1-runs.md` suspicious point 1. Make terminal exit depend on
  catching up with the durable event tail, then retest the controlled interleaving below.
  [PR #282](https://github.com/indxjp/agent-workspace/pull/282) did so; the permanent
  PostgreSQL regression failed before repair and passed afterward, and the model now proves
  terminal-tail delivery.
- **Terminal race, medium, repaired:** The real launcher and interrupt handler could append two
  `run.status` events before first-call-wins finish stored one status. PR #290 commits the winning
  event and record transition together. The memory/PostgreSQL race regression failed before repair
  and passed afterward; the current vector now expects one matching terminal event.
- **First truncated connection, low:** Both stores originally omitted `stream-reset` when a new
  client supplied no cursor and retained ids began above 1 (suspicious point 13). PR #288 now
  announces the gap; the shared memory/PostgreSQL regression and adversarial vector verify it.
- **Lone CR, low:** The SDK frame splitter originally missed lone CR as a line delimiter. PR #284
  normalized all three SSE line endings, including a CR at a chunk boundary or stream end.
- **Indeterminate `done`, medium:** For a live run whose stream source ends, the real SSE writer
  emits `run-failed` with status `unknown` followed by `done`. SDK `follow` stops, then
  `waitForOutcome` rejects the still-running record as a contract violation. This is suspicious
  point 4 and conflicts with S-81, S-82, S-107, S-122, S-184, and S-198. Preserve reconnectability
  until the terminal record is known, or specify this terminal stream outcome consistently.
- **Empty SDK cursor, low:** An explicit empty `id:` originally advanced the SDK's remembered
  cursor to an empty string, so reconnect sent `last-event-id: ''` (suspicious point 22). PR #287
  clears the cursor and omits the header; the adversarial vector now replays that behavior.

## Temporary PostgreSQL replay artifact

The temporary test below drove the real `createRepositoryRunStore` over an isolated PostgreSQL database. It is preserved here verbatim because the temporary source file is removed after verification. The wrapper returns a real event-list snapshot, then commits the final event and terminal status before the store's later status read. The active stream delivers no event; reopening finds the persisted event.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryRunStore, type RunStore } from './store';

type CoreDb = typeof import('@agent-workspace/core/db/unscoped');
const enabled = Boolean(process.env['TEST_DATABASE_URL']);

describe.skipIf(!enabled)('repository terminal read interleaving', () => {
  let core: CoreDb;
  let isolated: Awaited<ReturnType<CoreDb['createIsolatedTestDatabase']>>;

  beforeAll(async () => {
    core = await import('@agent-workspace/core/db/unscoped');
    isolated = await core.createIsolatedTestDatabase('aw_redteam_stream_tail');
  }, 180_000);

  afterAll(async () => {
    await isolated.close();
  });

  it('does not replay an event committed between list and terminal read', async () => {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const agentId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    await isolated.db.insert(core.workspaces).values({
      id: workspaceId,
      slug: workspaceId,
      name: 'Stream race',
    });
    await isolated.db.insert(core.users).values({
      id: userId,
      email: `${userId}@example.com`,
      name: 'Runner',
    });
    const membershipId = crypto.randomUUID();
    await isolated.db.insert(core.memberships).values({
      id: membershipId,
      workspaceId,
      userId,
      role: 'owner',
    });
    const principal = (await isolated.db.select().from(core.workspacePrincipals)).find(
      (row) => row.membershipId === membershipId,
    );
    if (principal === undefined) throw new Error('membership principal missing');
    await isolated.db.insert(core.agents).values({
      id: agentId,
      workspaceId,
      name: 'Stream race',
      instructions: '',
      modelConnectionId: null,
      model: null,
      createdBy: userId,
      ownerPrincipalId: principal.id,
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
      ownerPrincipalId: principal.id,
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
              const current = storeRef.current;
              if (current === undefined) throw new Error('run store missing');
              await current.appendPlatformEvent(id, {
                type: 'run.status',
                data: { status: 'completed' },
              });
              await current.finish(id, 'completed', null);
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
    await store.create({ id: runId, workspaceId, agentId, sessionId });
    await store.markRunning(runId);
    const stream = await store.openStream(runId, null);
    if (stream === null) throw new Error('created run had no stream');
    const delivered: bigint[] = [];
    for await (const event of stream.events) delivered.push(event.id);
    expect(delivered).toEqual([]);
    expect((await store.get(runId))?.status).toBe('completed');
    const replay = await store.openStream(runId, null);
    if (replay === null) throw new Error('created run had no replay stream');
    const persisted: bigint[] = [];
    for await (const event of replay.events) persisted.push(event.id);
    expect(persisted).toEqual([1n]);
  }, 180_000);
});
```

Focused service-runner output:

```text
Scope: 3 of 10 workspace projects
packages/contracts build$ tsc -p tsconfig.build.json
packages/core build$ tsc -p tsconfig.build.json
packages/contracts build: Done
packages/core build: Done
packages/sdk build$ tsc -p tsconfig.build.json
packages/sdk build: Done

 RUN  v5.0.0 <repo>-formal


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  04:38:49
   Duration  3.16s (tests 95%, import 3%, transform 3%)
```

## Temporary interrupt/launcher replay artifact

The temporary test below drives the real `createRunnerLauncher` and `interruptRun` handler over `InMemoryRunStore`. Its environment interrupt callback uses the same append-then-finish order as the production composition root. A barrier holds the launcher's first terminal finish after its append, allowing interrupt to append and finish; the log then contains two terminal events while the stored run has one terminal status. The source is preserved verbatim because the temporary test file is removed after verification.

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { interruptRun } from './api';
import { installRunApi, resetRunApi, type Principal } from './environment';
import { createRunnerLauncher } from './launcher';
import { InMemoryRunStore } from './store';

afterEach(() => {
  resetRunApi();
  vi.restoreAllMocks();
});

it('interrupt races a launcher terminal append before first-call-wins finish', async () => {
  const id = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  const principal: Principal = {
    principalId,
    userId: principalId,
    workspaceId,
    role: 'owner',
    scope: null,
  };
  const store = new InMemoryRunStore();
  const run = await store.create({ id, workspaceId, agentId, sessionId });
  const gate: { entered: () => void; release: () => void } = {
    entered: () => undefined,
    release: () => undefined,
  };
  const entered = new Promise<void>((resolve) => {
    gate.entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const finish = store.finish.bind(store);
  vi.spyOn(store, 'finish').mockImplementation(async (runId, status, error) => {
    if (status === 'completed') {
      gate.entered();
      await paused;
    }
    return finish(runId, status, error);
  });
  const launch = createRunnerLauncher({
    baseUrl: 'http://runtime.invalid',
    store,
    buildRunRequest: () => ({ runId: id }),
    fetch: () =>
      Promise.resolve(
        new Response('event: run-done\ndata: {}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
  });
  installRunApi({
    authenticate: () => Promise.resolve(principal),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(true),
    store,
    launch: () => undefined,
    revokeRunTokens: () => Promise.resolve({ revoked: 0, outcome: 'not-found' }),
    interruptRun: async (_principal, current) => {
      await store.appendPlatformEvent(current.id, {
        type: 'run.status',
        data: { status: 'cancelled', error: 'interrupted by request' },
      });
      await store.finish(current.id, 'cancelled', 'interrupted by request');
    },
  });
  launch({
    run,
    agent: { id: agentId, workspaceId },
    session: { id: sessionId, agentId },
    principal,
    prompt: 'hello',
  });
  await entered;
  const response = await interruptRun(new Request(`http://test/api/runs/${id}/interrupt`), id);
  expect(response.status).toBe(200);
  gate.release();
  for (let i = 0; i < 200; i += 1) {
    if ((await store.get(id))?.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await store.get(id))?.status).toBe('cancelled');
  const stream = await store.openStream(id, null);
  if (stream === null) throw new Error('created run has no stream');
  const statuses: string[] = [];
  for await (const event of stream.events) {
    if (event.type !== 'run.status') continue;
    if (typeof event.data !== 'object' || event.data === null) continue;
    const status: unknown = Reflect.get(event.data, 'status');
    if (typeof status === 'string' && ['completed', 'cancelled'].includes(status)) {
      statuses.push(status);
    }
  }
  expect(statuses).toEqual(['completed', 'cancelled']);
});
```

Focused replay output:

```text
 RUN  v5.0.0 <repo>-formal


 Test Files  1 passed (1)
      Tests  1 passed (1)
   Start at  04:38:30
   Duration  1.17s (import 50%, transform 44%, tests 5%, worker 1%)
```
