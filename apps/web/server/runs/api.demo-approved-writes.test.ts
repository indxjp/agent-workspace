/**
 * ADR-0169 D3: the run API hands the demo exactly the calls a decision approved, once, after the
 * row that consumed the decision is in and before the continuation is launched; never for a
 * rejection or a new run.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetTestRunApi } from '../application-context-fixtures';
import { CALL, WORKSPACE, decide, install, pausedRun } from './approval.test-support';
import { startRun } from './api';
import { AGENT, post } from './api.test-support';
import type { DemoApprovedWrites } from './demo-approved-writes';

afterEach(() => {
  resetTestRunApi();
});

/** A recorder that notes each call and how many runs were launched when it was called. */
function recorder(launched: () => number, fails = false) {
  const seen: { calls: unknown; workspaceId: string; launchedBefore: number }[] = [];
  const keep = vi.fn<DemoApprovedWrites['keep']>(({ workspaceId, calls }) => {
    seen.push({ calls, workspaceId, launchedBefore: launched() });
    return fails ? Promise.reject(new Error('relation mcp_servers broke')) : Promise.resolve();
  });
  return { keep, seen };
}

describe('the demo keeps an approved write before the continuation launches', () => {
  it('hands over the approved call of the workspace once, before the launch', async () => {
    const watched: { launched: readonly unknown[] } = { launched: [] };
    const { keep, seen } = recorder(() => watched.launched.length);
    const { store, launched } = install({ demoApprovedWrites: { keep } });
    watched.launched = launched;
    const paused = await pausedRun(store);
    const response = await decide(paused.id, 'approve');
    expect(response.status).toBe(202);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ calls: [CALL], workspaceId: WORKSPACE, launchedBefore: 0 }]);
    expect(launched).toHaveLength(1);
  });

  it('hands over nothing for a rejection', async () => {
    const { keep } = recorder(() => 0);
    const { store, launched } = install({ demoApprovedWrites: { keep } });
    const paused = await pausedRun(store);
    expect((await decide(paused.id, 'reject')).status).toBe(202);
    expect(launched).toHaveLength(1);
    expect(keep).not.toHaveBeenCalled();
  });

  it('hands over nothing for a new run', async () => {
    const { keep } = recorder(() => 0);
    const { launched } = install({ demoApprovedWrites: { keep } });
    expect((await startRun(post(AGENT, { prompt: 'hi' }), AGENT)).status).toBe(202);
    expect(launched).toHaveLength(1);
    expect(keep).not.toHaveBeenCalled();
  });

  it('hands over nothing for a decision that loses: a second approval of the same run', async () => {
    const { keep } = recorder(() => 0);
    const { store } = install({ demoApprovedWrites: { keep } });
    const paused = await pausedRun(store);
    expect((await decide(paused.id, 'approve')).status).toBe(202);
    expect((await decide(paused.id, 'approve')).status).toBe(409);
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it('still continues the run when the demo cannot keep the write, and says nothing of why', async () => {
    const { keep } = recorder(() => 0, true);
    const { store, launched } = install({ demoApprovedWrites: { keep } });
    const paused = await pausedRun(store);
    const response = await decide(paused.id, 'approve');
    expect(response.status).toBe(202);
    expect(await response.text()).not.toContain('mcp_servers');
    expect(launched).toHaveLength(1);
  });
});
