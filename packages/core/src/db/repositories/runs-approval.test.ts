/**
 * The `awaiting_approval` run status against a real PostgreSQL (P5-2, ADR-0145 D1).
 *
 * A paused run has stopped: it has an end time, its tokens are revoked, and it neither keeps its
 * session busy nor counts as in flight. It leaves the pause only by a decision (`completed` or
 * `cancelled`), exactly once, and never back to `running`.
 */
import { describe, expect, it } from 'vitest';

import { runStatuses } from '../schema/runs.js';
import { registerConsumptionCases } from './runs-approval.consumption.test-support.js';
import { registerContinuationCases } from './runs-approval.continuation.test-support.js';
import { CALL, createRunsApprovalFixture } from './runs-approval.fixture.test-support.js';
import { registerIdempotencyCases } from './runs-approval.idempotency.test-support.js';
import { registerPauseCases, registerPauseEventCases } from './runs-approval.pause.test-support.js';
import { parseApprovalCall, parseApprovalCalls, runStatusesThatMayMoveTo } from './runs/rows.js';

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
if (!hasDatabase) {
  console.warn('[repositories/runs-approval.test.ts] SKIPPED — TEST_DATABASE_URL is not set.');
}

describe('runStatusesThatMayMoveTo', () => {
  it('is the transition table, and no status moves to itself', () => {
    const table: Record<(typeof runStatuses)[number], readonly string[]> = {
      queued: [],
      running: ['queued'],
      awaiting_approval: ['running'],
      completed: ['queued', 'running', 'awaiting_approval'],
      cancelled: ['queued', 'running', 'awaiting_approval'],
      failed: ['queued', 'running'],
    };
    for (const to of runStatuses) {
      expect([...runStatusesThatMayMoveTo(to)]).toEqual(table[to]);
      expect(runStatusesThatMayMoveTo(to)).not.toContain(to);
    }
  });
});

describe('the approval call shape', () => {
  it.each([
    ['an empty tool name', { toolName: '', canonicalCall: '{}' }],
    ['an empty call', { toolName: 'send_email', canonicalCall: '' }],
    ['a missing call', { toolName: 'send_email' }],
    ['an unknown key', { toolName: 'send_email', canonicalCall: '{}', extra: 1 }],
    ['a non-object', 'send_email'],
    ['null', null],
    ['an array', []],
  ])('rejects %s', (_label, value) => {
    expect(() => parseApprovalCall(value)).toThrow(/approval call/u);
  });

  it('accepts exactly a tool name and a canonical call, and a list of them', () => {
    expect(parseApprovalCall(CALL)).toEqual(CALL);
    expect(parseApprovalCalls([CALL, CALL])).toEqual([CALL, CALL]);
    expect(() => parseApprovalCalls(CALL)).toThrow(/array/u);
  });
});

describe.skipIf(!hasDatabase)('the awaiting_approval run status against PostgreSQL', () => {
  const fixture = createRunsApprovalFixture();
  registerPauseCases(fixture);
  registerConsumptionCases(fixture);
  registerIdempotencyCases(fixture);
  registerContinuationCases(fixture);
  registerPauseEventCases(fixture);
});
