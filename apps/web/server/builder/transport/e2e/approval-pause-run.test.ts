/**
 * [US-BLD-03][api][run] A Builder run that calls `draft_save`, `trial_run` or `evals_run` pauses at
 * `awaiting_approval` (ADR-0145). Approving starts a continuation run that makes the call once;
 * rejecting writes nothing, and the door still refuses the call (issue #1847 slice 4).
 */
import { randomUUID } from 'node:crypto';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InMemoryRunStore } from '../../../runs/memory-store';
import { callContextOf } from '../../testing/context';
import { draftBody } from '../../adapters/checker/checker.contract';
import {
  gatedInputs,
  type GatedTool,
  WORKSPACE,
  builderDoor,
  scriptedModel,
  toolResults,
  toolUse,
} from './harness';

const scopes = () => createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);
const PERSON = callContextOf(WORKSPACE, 'builder', 'principal-builder', 'user-builder');
const SAVE = { body: draftBody('Order desk', ['crm']) };

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A Builder run that has called `tool` and stopped at the gate, over a workspace with one saved agent. */
async function pausedOn(tool: GatedTool) {
  const runStore = new InMemoryRunStore();
  const door = builderDoor({ scopes: scopes(), runStore });
  const saved = await door.ports.store.save(PERSON, SAVE);
  if (!saved.ok) throw new Error('the fixture agent was not saved');
  const input = gatedInputs(saved)[tool];
  const script = { turns: [{ toolUses: [toolUse(tool, input)] }, { text: 'Done.' }] };
  const model = await scriptedModel(`builder-pause-${randomUUID()}`, script);
  const { runId, token } = await door.start({ role: 'builder' }, model);
  await door.runScripted(token, model, { gated: true });
  const saves = door.versions.versionCount();
  const audits = door.auditEvents.length;

  async function decide(decision: 'approve' | 'reject') {
    const decided = await door.decide(runId, decision);
    const again = await scriptedModel(`builder-continue-${randomUUID()}`, script);
    const continuation = await door.start({ role: 'builder' }, again, decided.runId);
    const transcript = await door.runScripted(continuation.token, again, { gated: true });
    return { decided, continuation, transcript };
  }
  return {
    door,
    runStore,
    runId,
    input,
    decide,
    versionsSaved: () => door.versions.versionCount() - saves,
    auditsWritten: () => door.auditEvents.length - audits,
    launches: () => door.launched.filter((launch) => launch.limits !== undefined),
    rowsOf: (name: string) => door.journal.filter((row) => row.tool === name),
  };
}

describe('[US-BLD-03][api][run] draft_save stops for the person', () => {
  it('[US-BLD-03][api][run] pauses at awaiting_approval without saving; approving continues the run and saves exactly once', async () => {
    const paused = await pausedOn('draft_save');

    expect((await paused.runStore.get(paused.runId))?.status).toBe('awaiting_approval');
    expect(paused.versionsSaved()).toBe(0);
    expect(paused.rowsOf('draft_save')).toEqual([]);

    const { decided, transcript } = await paused.decide('approve');

    expect(decided.status).toBe(202);
    expect((await paused.runStore.get(paused.runId))?.status).toBe('completed');
    expect(toolResults(transcript)).toEqual([
      expect.objectContaining({ ok: true, version: 1, pointer: 'local' }) as unknown,
    ]);
    expect(paused.versionsSaved()).toBe(1);
    expect(paused.rowsOf('draft_save').filter((row) => row.outcome === 'ok')).toHaveLength(1);
  });
});

describe('[US-BLD-04][api][run] trial_run and evals_run stop for the person', () => {
  it('trial_run starts no run until approved, then exactly one under the trial budget', async () => {
    const paused = await pausedOn('trial_run');
    expect(paused.launches()).toEqual([]);

    const { transcript } = await paused.decide('approve');

    expect(toolResults(transcript)).toEqual([
      expect.objectContaining({ ok: true, status: 'completed' }) as unknown,
    ]);
    expect(paused.launches().map((launch) => launch.limits?.maxBudgetUsd)).toEqual([0.3]);
  });

  it('evals_run scores no case until approved, then each case once under the trial budget', async () => {
    const paused = await pausedOn('evals_run');
    expect(paused.launches()).toEqual([]);

    const { transcript } = await paused.decide('approve');

    expect(toolResults(transcript)).toEqual([
      expect.objectContaining({ ok: true, total: 1, passed: 1 }) as unknown,
    ]);
    expect(paused.launches().map((launch) => launch.limits?.maxBudgetUsd)).toEqual([0.3]);
  });
});

describe('[US-BLD-03][api][run] a rejection writes nothing', () => {
  it.each(['draft_save', 'trial_run', 'evals_run'] as const)(
    '%s: no version, no run, no audit event, and the door still refuses the call',
    async (tool) => {
      const paused = await pausedOn(tool);

      const { continuation } = await paused.decide('reject');
      // Past the engine's gate, the door's own approval check still refuses the rejected call.
      const direct = await paused.door.call(
        continuation.token,
        tool,
        paused.input,
        {},
        'after-reject',
      );

      expect((await paused.runStore.get(continuation.runId))?.status).toBe('awaiting_approval');
      expect(direct.result).toMatchObject({ ok: false, code: 'approval_required' });
      expect(paused.versionsSaved()).toBe(0);
      expect(paused.launches()).toEqual([]);
      expect(paused.auditsWritten()).toBe(0);
      expect(paused.rowsOf(tool).map((row) => row.outcome)).toEqual(['refused']);
    },
  );
});
