import { HttpClient } from '../http.js';
import { fetchDouble, type RecordedRequest } from '../testing.js';
import { RunsClient } from './runs.js';

export const AGENT = '11111111-1111-4111-8111-111111111111';

export const RUN = '33333333-3333-4333-8333-333333333333';

export const run = (status: string, output: unknown = null) => ({
  id: RUN,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId: AGENT,
  projectId: null,
  initiatingUserId: null,
  sessionId: '55555555-5555-4555-8555-555555555555',
  agentVersion: null,
  status,
  createdAt: '2026-09-21T10:00:00.000Z',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  model: null,
  provider: null,
  modelConnectionId: null,
  engine: 'claude-agent-sdk',
  engineVersion: null,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
  },
  cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
  spendCeilingUsd: null,
  error: null,
  output,
  pendingApproval:
    status === 'awaiting_approval' ? { toolName: 'send_email', canonicalCall: '{}' } : null,
  accountingState: 'pending',
  accountingError: null,
  parentRunId: null,
});

export const detail = <Run extends { readonly cost: { amount: string; currency: string } }>(
  of: Run,
) => ({
  ...of,
  children: [],
  treeCost: { amount: of.cost.amount, currency: of.cost.currency },
});

export function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly runs: RunsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { runs: new RunsClient(http), calls: api.calls };
}
