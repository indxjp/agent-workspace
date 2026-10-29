import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_ARCHIVE_MIN_INTERVAL_MS,
  AGENT_ARCHIVE_PAGE_SIZE,
  AGENT_AUTO_ARCHIVE_DAYS,
  createAgentArchiveSweep,
  startAgentArchiveScheduler,
  type AgentArchiveStore,
  type ArchiveCandidate,
} from './sweep';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T04:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

const LINEAGE = { agentId: 'creator', version: 1, runId: 'run-1' } as const;

const candidate = (id: string, overrides: Partial<ArchiveCandidate> = {}): ArchiveCandidate => ({
  id,
  createdAt: daysAgo(31),
  lastRunAt: null,
  createdByAgent: LINEAGE,
  ...overrides,
});

/** An in-memory store: `listArchiveCandidates` pages by id like the repository, `archive` records. */
function fakeStore(candidates: readonly ArchiveCandidate[]) {
  const archived: { ids: readonly string[]; at: Date }[] = [];
  const done = new Set<string>();
  const store: AgentArchiveStore = {
    listArchiveCandidates: ({ createdBefore, afterId, limit }) =>
      Promise.resolve(
        candidates
          .filter((c) => !done.has(c.id) && c.createdAt < createdBefore)
          .filter((c) => afterId === null || c.id > afterId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit),
      ),
    archive: (ids, at) => {
      archived.push({ ids, at });
      for (const id of ids) done.add(id);
      return Promise.resolve(ids);
    },
  };
  return { store, archived, archivedIds: () => archived.flatMap((call) => call.ids) };
}

type Deps = Parameters<typeof createAgentArchiveSweep>[0];

function deps(
  stores: Readonly<Record<string, AgentArchiveStore>>,
  overrides: Partial<Deps> = {},
): Deps {
  return {
    listWorkspaceIds: () => Promise.resolve(Object.keys(stores)),
    tryAcquireMaintenanceLease: () => Promise.resolve({ release: () => Promise.resolve() }),
    storeFor: (workspaceId) => Promise.resolve(stores[workspaceId] ?? null),
    now: () => NOW,
    log: { error: vi.fn() },
    ...overrides,
  };
}

const RAN = { leaseHeld: false, throttled: false, failed: 0 } as const;

describe('the agent auto-archive sweep', () => {
  it('the sweep archives an agent-made agent unused for 30 days, and never a person-made one', async () => {
    const { store, archived, archivedIds } = fakeStore([
      candidate('a-made-never-run'),
      candidate('b-creator-deleted', {
        createdByAgent: { ...LINEAGE, agentId: null },
        lastRunAt: daysAgo(31),
      }),
      // The store returns it on purpose: the sweep must not trust the query's prefilter.
      candidate('c-person-made', { createdAt: daysAgo(400), createdByAgent: null }),
      candidate('d-made-run-recently', { lastRunAt: daysAgo(29) }),
    ]);

    const result = await createAgentArchiveSweep(deps({ w1: store }))();

    expect(AGENT_AUTO_ARCHIVE_DAYS).toBe(30);
    expect(archivedIds()).toEqual(['a-made-never-run', 'b-creator-deleted']);
    expect(archived.every((call) => call.at.getTime() === NOW.getTime())).toBe(true);
    expect(result).toEqual({ ...RAN, workspaces: 1, archived: 2 });
  });

  it('keeps an agent-made agent that is 30 days old or has a run exactly 30 days ago', async () => {
    const { store, archivedIds } = fakeStore([
      candidate('a-created-30-days-ago', { createdAt: daysAgo(30) }),
      candidate('b-run-30-days-ago', { lastRunAt: daysAgo(30) }),
      candidate('c-run-31-days-ago', { lastRunAt: daysAgo(30.01) }),
    ]);

    await createAgentArchiveSweep(deps({ w1: store }))();

    expect(archivedIds()).toEqual(['c-run-31-days-ago']);
  });

  it('pages through more candidates than one page and archives every eligible one', async () => {
    const total = AGENT_ARCHIVE_PAGE_SIZE * 2 + 1;
    const ids = Array.from({ length: total }, (_, i) => `agent-${String(i).padStart(4, '0')}`);
    // Every third candidate was run recently, so a page is never entirely archivable.
    const { store, archivedIds } = fakeStore(
      ids.map((id, i) => candidate(id, i % 3 === 0 ? { lastRunAt: daysAgo(1) } : {})),
    );

    const result = await createAgentArchiveSweep(deps({ w1: store }))();

    expect(archivedIds()).toEqual(ids.filter((_, i) => i % 3 !== 0));
    expect(result.archived).toBe(archivedIds().length);
  });

  it('asks only for agents not restored within the 30-day window', async () => {
    const { store } = fakeStore([candidate('a')]);
    const listed = vi.spyOn(store, 'listArchiveCandidates');

    await createAgentArchiveSweep(deps({ w1: store }))();

    expect(listed).toHaveBeenCalledWith(expect.objectContaining({ notRestoredSince: daysAgo(30) }));
  });

  it('a sweep of another instance archives nothing more', async () => {
    const { store, archived } = fakeStore([candidate('a')]);

    await createAgentArchiveSweep(deps({ w1: store }))();
    const second = await createAgentArchiveSweep(deps({ w1: store }))();

    expect(second.archived).toBe(0);
    expect(archived).toHaveLength(1);
  });

  it('does nothing while another replica holds the lease, and tries again on the next call', async () => {
    const { store, archived } = fakeStore([candidate('a')]);
    let free = false;
    const sweep = createAgentArchiveSweep(
      deps(
        { w1: store },
        {
          tryAcquireMaintenanceLease: () =>
            Promise.resolve(free ? { release: () => Promise.resolve() } : null),
        },
      ),
    );

    expect(await sweep()).toEqual({ ...RAN, leaseHeld: true, workspaces: 0, archived: 0 });
    expect(archived).toEqual([]);
    free = true;
    expect((await sweep()).archived).toBe(1);
  });

  it('releases the lease it acquired', async () => {
    const release = vi.fn(() => Promise.resolve());

    await createAgentArchiveSweep(
      deps({}, { tryAcquireMaintenanceLease: () => Promise.resolve({ release }) }),
    )();

    expect(release).toHaveBeenCalledOnce();
  });

  it('counts a failing workspace and still sweeps the others', async () => {
    const good = fakeStore([candidate('a')]);
    const failing: AgentArchiveStore = {
      listArchiveCandidates: () => Promise.reject(new Error('relation "agents" does not exist')),
      archive: () => Promise.reject(new Error('unreachable')),
    };
    const log = { error: vi.fn() };

    const result = await createAgentArchiveSweep(deps({ bad: failing, w1: good.store }, { log }))();

    expect(good.archivedIds()).toEqual(['a']);
    expect(result).toEqual({ ...RAN, workspaces: 2, archived: 1, failed: 1 });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it('skips a workspace that no longer resolves', async () => {
    const result = await createAgentArchiveSweep(
      deps({}, { listWorkspaceIds: () => Promise.resolve(['gone']) }),
    )();

    expect(result).toEqual({ ...RAN, workspaces: 1, archived: 0 });
  });

  describe('the hourly throttle', () => {
    function throttled() {
      let clock = NOW;
      const now = () => clock;
      const { store, archived } = fakeStore([candidate('a'), candidate('b')]);
      const sweep = createAgentArchiveSweep(deps({ w1: store }, { now }));
      const listed = vi.spyOn(store, 'listArchiveCandidates');
      return {
        sweep,
        archived,
        listed,
        advance: (ms: number) => {
          clock = new Date(clock.getTime() + ms);
        },
      };
    }

    it('does not sweep on a second delivery within the hour, and sweeps again after it', async () => {
      const { sweep, listed, advance } = throttled();

      expect((await sweep()).throttled).toBe(false);
      const reads = listed.mock.calls.length;
      expect(reads).toBeGreaterThan(0);

      advance(AGENT_ARCHIVE_MIN_INTERVAL_MS - 1);
      expect(await sweep()).toEqual({
        ...RAN,
        throttled: true,
        workspaces: 0,
        archived: 0,
      });
      expect(listed).toHaveBeenCalledTimes(reads);

      advance(1);
      expect((await sweep()).throttled).toBe(false);
      expect(listed.mock.calls.length).toBeGreaterThan(reads);
    });

    it('is an hour, and a throttled delivery does not take the lease', async () => {
      expect(AGENT_ARCHIVE_MIN_INTERVAL_MS).toBe(60 * 60_000);
      const tryAcquireMaintenanceLease = vi.fn();
      const sweep = createAgentArchiveSweep(deps({}, { tryAcquireMaintenanceLease }));
      tryAcquireMaintenanceLease.mockResolvedValue({ release: () => Promise.resolve() });

      await sweep();
      await sweep();

      expect(tryAcquireMaintenanceLease).toHaveBeenCalledOnce();
    });
  });
});

describe('startAgentArchiveScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('polls often and still sweeps no more than once an hour', async () => {
    vi.useFakeTimers({ now: NOW });
    const { store } = fakeStore([candidate('a')]);
    const sweep = createAgentArchiveSweep(deps({ w1: store }, { now: () => new Date() }));
    const swept: number[] = [];
    const onError = vi.fn();
    const stop = startAgentArchiveScheduler({
      sweep: async () => {
        const result = await sweep();
        if (!result.throttled) swept.push(Date.now());
        return result;
      },
      intervalMs: 15 * 60_000,
      onError,
    });

    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    stop();

    expect(swept.length).toBeGreaterThanOrEqual(5);
    swept.slice(1).forEach((at, i) => {
      expect(at - (swept[i] ?? 0)).toBeGreaterThanOrEqual(AGENT_ARCHIVE_MIN_INTERVAL_MS);
    });
    expect(onError).not.toHaveBeenCalled();
  });
});
