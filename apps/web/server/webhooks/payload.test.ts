import { WebhookEventSchema } from '@indx-workspace/contracts/webhooks';
import { describe, expect, it } from 'vitest';

import { toWebhookEvent, type WebhookEventDelivery } from './payload';
import { finishedRun, WEBHOOK_TEST_WORKSPACE_ID } from './testing';

const delivery: WebhookEventDelivery = {
  id: '55555555-5555-4555-8555-555555555555',
  workspaceId: WEBHOOK_TEST_WORKSPACE_ID,
  eventType: 'run.completed',
  createdAt: new Date('2026-10-31T00:00:09.500Z'),
};

describe('toWebhookEvent (ADR-SDK-18-N3-250 D3)', () => {
  it('builds the contract envelope with the delivery id and the run outcome', () => {
    const outcome = toWebhookEvent(finishedRun(), delivery);
    if (!outcome.ok) throw new Error('expected an event');
    expect(WebhookEventSchema.parse(outcome.event)).toEqual(outcome.event);
    expect(outcome.event).toEqual({
      id: delivery.id,
      type: 'run.completed',
      createdAt: '2026-10-31T00:00:09.500Z',
      workspaceId: WEBHOOK_TEST_WORKSPACE_ID,
      data: {
        run: {
          id: finishedRun().id,
          agentId: finishedRun().agentId,
          sessionId: finishedRun().sessionId,
          status: 'completed',
          endedAt: '2026-10-31T00:00:09.000Z',
          error: null,
          usage: finishedRun().usage,
          cost: finishedRun().cost,
          accountingState: 'complete',
        },
      },
    });
  });

  it('never carries the output, the prompt or any field outside the projection', () => {
    const outcome = toWebhookEvent(finishedRun(), delivery);
    if (!outcome.ok) throw new Error('expected an event');
    const text = JSON.stringify(outcome.event);
    expect(text).not.toContain('secret answer');
    expect(Object.keys(outcome.event.data.run).sort()).toEqual(
      [
        'accountingState',
        'agentId',
        'cost',
        'endedAt',
        'error',
        'id',
        'sessionId',
        'status',
        'usage',
      ].sort(),
    );
  });

  it('reports a failed run with its safe error text', () => {
    const outcome = toWebhookEvent(
      finishedRun({ status: 'failed', error: 'The run failed.', output: null }),
      { ...delivery, eventType: 'run.failed' },
    );
    expect(outcome.ok && outcome.event.data.run.error).toBe('The run failed.');
  });

  it('refuses a run whose status is not the one the event names, or of another workspace', () => {
    expect(toWebhookEvent(finishedRun({ status: 'running' }), delivery)).toEqual({
      ok: false,
      reason: 'run_mismatch',
    });
    expect(
      toWebhookEvent(
        finishedRun({ workspaceId: '66666666-6666-4666-8666-666666666666' }),
        delivery,
      ),
    ).toEqual({ ok: false, reason: 'run_mismatch' });
  });
});
