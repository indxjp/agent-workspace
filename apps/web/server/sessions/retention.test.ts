import { describe, expect, it, vi } from 'vitest';

import {
  readSessionRetentionPolicy,
  runSessionRetention,
  runSessionRetentionPass,
  startSessionRetentionScheduler,
} from './retention';

/** A state store that removes nothing, for the cases that are about the legacy half. */
const NO_STATE = { purgeBefore: () => Promise.resolve({ entries: 0, blobs: 0 }) };

describe('session retention maintenance', () => {
  it('defaults to a safe dry run and validates configuration', () => {
    expect(readSessionRetentionPolicy({})).toEqual({
      transcriptDays: 30,
      leaseTtlMs: 300_000,
      dryRun: true,
    });
    expect(() =>
      readSessionRetentionPolicy({ AW_SESSION_TRANSCRIPT_RETENTION_DAYS: '0' }),
    ).toThrow();
    expect(() => readSessionRetentionPolicy({ AW_SESSION_RETENTION_DRY_RUN: 'yes' })).toThrow();
  });

  it('does no work when another process holds the workspace lease', async () => {
    const purgeBefore = vi.fn();
    const statePurge = vi.fn();
    const result = await runSessionRetention({
      workspaceId: 'workspace-a',
      store: { purgeBefore },
      stateStore: { purgeBefore: statePurge },
      lease: { tryAcquire: () => Promise.resolve(null) },
      policy: { transcriptDays: 7, leaseTtlMs: 1_000, dryRun: false },
    });
    expect(result).toEqual({ kind: 'lease-held' });
    expect(purgeBefore).not.toHaveBeenCalled();
    expect(statePurge).not.toHaveBeenCalled();
  });

  it('purges by a deterministic cutoff and releases its lease', async () => {
    const release = vi.fn(() => Promise.resolve());
    const purgeBefore = vi.fn(() => Promise.resolve(4));
    const result = await runSessionRetention({
      workspaceId: 'workspace-a',
      store: { purgeBefore },
      stateStore: NO_STATE,
      lease: { tryAcquire: () => Promise.resolve({ release }) },
      policy: { transcriptDays: 10, leaseTtlMs: 1_000, dryRun: false },
      now: new Date('2026-09-10T00:00:00Z'),
    });
    expect(result).toMatchObject({
      kind: 'purged',
      transcripts: 4,
      cutoff: new Date('2026-08-31T00:00:00Z'),
    });
    expect(purgeBefore).toHaveBeenCalledWith('workspace-a', new Date('2026-08-31T00:00:00Z'));
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the lease when purge fails', async () => {
    const release = vi.fn(() => Promise.resolve());
    await expect(
      runSessionRetention({
        workspaceId: 'workspace-a',
        store: { purgeBefore: () => Promise.reject(new Error('database unavailable')) },
        stateStore: NO_STATE,
        lease: { tryAcquire: () => Promise.resolve({ release }) },
        policy: { transcriptDays: 10, leaseTtlMs: 1_000, dryRun: false },
      }),
    ).rejects.toThrow('database unavailable');
    expect(release).toHaveBeenCalledOnce();
  });

  it('purges the engine-scoped store under the same cutoff and reports its counts (ENG-06)', async () => {
    const statePurge = vi.fn(() => Promise.resolve({ entries: 12, blobs: 2 }));
    const result = await runSessionRetention({
      workspaceId: 'workspace-a',
      store: { purgeBefore: () => Promise.resolve(1) },
      stateStore: { purgeBefore: statePurge },
      lease: { tryAcquire: () => Promise.resolve({ release: () => Promise.resolve() }) },
      policy: { transcriptDays: 10, leaseTtlMs: 1_000, dryRun: false },
      now: new Date('2026-09-10T00:00:00Z'),
    });
    expect(result).toEqual({
      kind: 'purged',
      cutoff: new Date('2026-08-31T00:00:00Z'),
      transcripts: 1,
      stateEntries: 12,
      stateBlobs: 2,
    });
    expect(statePurge).toHaveBeenCalledWith('workspace-a', new Date('2026-08-31T00:00:00Z'));
  });

  it('touches neither store on a dry run', async () => {
    const purgeBefore = vi.fn();
    const statePurge = vi.fn();
    const result = await runSessionRetention({
      workspaceId: 'workspace-a',
      store: { purgeBefore },
      stateStore: { purgeBefore: statePurge },
      lease: { tryAcquire: () => Promise.resolve({ release: () => Promise.resolve() }) },
      policy: { transcriptDays: 10, leaseTtlMs: 1_000, dryRun: true },
      now: new Date('2026-09-10T00:00:00Z'),
    });
    expect(result).toEqual({ kind: 'dry-run', cutoff: new Date('2026-08-31T00:00:00Z') });
    expect(purgeBefore).not.toHaveBeenCalled();
    expect(statePurge).not.toHaveBeenCalled();
  });
});

describe('startSessionRetentionScheduler', () => {
  it('covers every workspace while a concurrent tick shares the active pass', async () => {
    const purged: string[] = [];
    const statePurged: string[] = [];
    const reported: string[] = [];
    let releaseList: (() => void) | undefined;
    const listed = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const scheduler = startSessionRetentionScheduler({
      listWorkspaceIds: async () => {
        await listed;
        return ['workspace-a', 'workspace-b'];
      },
      store: {
        purgeBefore: (workspaceId) => {
          purged.push(workspaceId);
          return Promise.resolve(1);
        },
      },
      stateStore: {
        purgeBefore: (workspaceId) => {
          statePurged.push(workspaceId);
          return Promise.resolve({ entries: 3, blobs: 1 });
        },
      },
      onResult: (workspaceId, result) => {
        if (result.kind === 'purged') {
          reported.push(
            `${workspaceId}:${String(result.stateEntries)}:${String(result.stateBlobs)}`,
          );
        }
      },
      lease: {
        tryAcquire: () => Promise.resolve({ release: () => Promise.resolve() }),
      },
      policy: { transcriptDays: 30, leaseTtlMs: 1_000, dryRun: false },
      intervalMs: 60_000,
    });
    const concurrent = scheduler.runNow();
    releaseList?.();
    await concurrent;
    scheduler.stop();
    expect(purged).toEqual(['workspace-a', 'workspace-b']);
    expect(statePurged).toEqual(['workspace-a', 'workspace-b']);
    expect(reported).toEqual(['workspace-a:3:1', 'workspace-b:3:1']);
  });
});

describe('runSessionRetentionPass', () => {
  it('returns one result per workspace, in order, and reports each', async () => {
    const reported: string[] = [];
    const results = await runSessionRetentionPass({
      listWorkspaceIds: () => Promise.resolve(['workspace-a', 'workspace-b']),
      store: { purgeBefore: () => Promise.resolve(1) },
      stateStore: NO_STATE,
      lease: {
        tryAcquire: (name) =>
          Promise.resolve(
            name.endsWith('workspace-b') ? null : { release: () => Promise.resolve() },
          ),
      },
      policy: { transcriptDays: 10, leaseTtlMs: 1_000, dryRun: false },
      onResult: (workspaceId) => reported.push(workspaceId),
    });

    expect(results.map(({ kind }) => kind)).toEqual(['purged', 'lease-held']);
    expect(reported).toEqual(['workspace-a', 'workspace-b']);
  });
});
