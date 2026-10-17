import { describe, expect, it } from 'vitest';

import type { RunFeedbackItem } from '@indx-workspace/contracts/feedback';

import { ContractViolationError } from '../errors.js';
import { createClient } from '../index.js';
import { fetchDouble, jsonResponse, type RecordedRequest } from '../testing.js';

/** Issue #620: `agents.feedback.list`. */

const AGENT = '33333333-3333-4333-8333-333333333333';
const item: RunFeedbackItem = {
  runId: '44444444-4444-4444-8444-444444444444',
  rating: 'down',
  comment: 'Wrong order.',
  input: 'Where is order 1042?',
  answer: 'Order 1043 has shipped.',
  createdAt: '2026-10-04T00:00:00.000Z',
};

function client(route: (request: RecordedRequest) => Response) {
  const api = fetchDouble(route);
  const aw = createClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { aw, calls: api.calls };
}

describe('FeedbackClient.list', () => {
  it('sends the query and reads the items', async () => {
    const { aw, calls } = client(() => jsonResponse(200, { items: [item] }));
    const since = '2026-09-27T00:00:00.000Z';
    expect(await aw.agents.feedback.list(AGENT, { rating: 'down', since })).toEqual([item]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.pathname).toBe(`/api/agents/${AGENT}/feedback`);
    expect(Object.fromEntries(calls[0]?.url.searchParams ?? [])).toEqual({ rating: 'down', since });
  });

  it('refuses a 200 that is not a feedback list', async () => {
    const { aw } = client(() => jsonResponse(200, { items: [{ ...item, rating: 'meh' }] }));
    await expect(aw.agents.feedback.list(AGENT)).rejects.toBeInstanceOf(ContractViolationError);
  });
});
