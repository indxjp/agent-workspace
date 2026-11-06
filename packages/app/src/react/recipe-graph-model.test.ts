import { describe, expect, it } from 'vitest';

import type { RecipeRunDetail, RecipeRunView, RecipeStepView } from '../recipe-wire.js';
import { appStrings } from './locale.js';
import {
  changeAnnouncement,
  formatCost,
  formatDuration,
  keepsPolling,
  orderedSteps,
  runBadge,
  stepBadge,
  stepDurationMs,
} from './recipe-graph-model.js';

const strings = appStrings('en').recipes;

function step(key: string, overrides: Partial<RecipeStepView> = {}): RecipeStepView {
  return {
    key,
    status: 'completed',
    runId: null,
    runUrl: null,
    decision: null,
    error: null,
    startedAt: '2026-11-01T09:00:00.000000Z',
    endedAt: '2026-11-01T09:00:04.200000Z',
    cost: null,
    pendingApproval: null,
    ...overrides,
  };
}

function run(status: RecipeRunView['status']): RecipeRunView {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    recipe: 'triage-incident',
    status,
    error: null,
    startedBy: null,
    createdAt: '2026-11-01T09:00:00.000000Z',
    updatedAt: '2026-11-01T09:00:00.000000Z',
  };
}

describe('recipe graph model (#1514)', () => {
  it('orders the steps by start, then by key', () => {
    const steps = [
      step('notify', { startedAt: '2026-11-01T09:00:05.000000Z' }),
      step('b'),
      step('a'),
    ];
    expect(orderedSteps(steps).map((each) => each.key)).toEqual(['a', 'b', 'notify']);
  });

  it('maps every status to its badge', () => {
    expect(stepBadge('running', strings)).toEqual({ label: 'Running', tone: 'info' });
    expect(stepBadge('awaiting_approval', strings)).toEqual({
      label: 'Awaiting approval',
      tone: 'warn',
    });
    expect(stepBadge('completed', strings).tone).toBe('ok');
    expect(stepBadge('failed', strings).tone).toBe('danger');
    expect(runBadge('waiting', strings)).toEqual({ label: 'Waiting for a decision', tone: 'warn' });
    expect(runBadge('cancelled', appStrings('ja').recipes).label).toBe('キャンセル済み');
  });

  it('computes a duration, so far for a running step, and never below zero', () => {
    const now = new Date('2026-11-01T09:01:00.000Z');
    expect(stepDurationMs(step('a'), now)).toBe(4200);
    expect(stepDurationMs(step('a', { endedAt: null }), now)).toBe(60_000);
    expect(stepDurationMs(step('a', { endedAt: null }), new Date('2026-01-01T00:00:00Z'))).toBe(0);
    expect(formatDuration(850, 'en')).toBe('850 ms');
    expect(formatDuration(4200, 'en')).toBe('4.2 sec');
    expect(formatDuration(185_000, 'en')).toBe('3 min 5 sec');
    expect(formatDuration(4200, 'ja')).toContain('4.2');
  });

  it('formats a cost in its currency, and an unknown currency as written', () => {
    expect(formatCost({ amount: '0.012345', currency: 'USD' }, 'en')).toBe('$0.0123');
    expect(formatCost({ amount: '1.5', currency: 'USD' }, 'en')).toBe('$1.50');
    expect(formatCost({ amount: '0.5', currency: 'NOT-A-CODE' }, 'en')).toBe('0.5 NOT-A-CODE');
    expect(formatCost({ amount: 'x', currency: 'USD' }, 'en')).toBe('x USD');
  });

  it('keeps polling until the run is stopped', () => {
    expect(keepsPolling(null)).toBe(true);
    expect(keepsPolling(run('running'))).toBe(true);
    expect(keepsPolling(run('waiting'))).toBe(true);
    for (const stopped of ['completed', 'failed', 'cancelled'] as const) {
      expect(keepsPolling(run(stopped))).toBe(false);
    }
  });

  it('announces each changed step and the run, and nothing when nothing changed', () => {
    const before: RecipeRunDetail = {
      run: run('waiting'),
      steps: [step('classify', { status: 'awaiting_approval', endedAt: null })],
    };
    const after: RecipeRunDetail = {
      run: run('completed'),
      steps: [step('classify'), step('notify', { startedAt: '2026-11-01T09:00:05.000000Z' })],
    };
    expect(changeAnnouncement(null, after, strings)).toBeNull();
    expect(changeAnnouncement(before, before, strings)).toBeNull();
    expect(changeAnnouncement(before, after, strings)).toBe(
      'Step classify: Completed. Step notify: Completed. Recipe: Completed.',
    );
  });
});
