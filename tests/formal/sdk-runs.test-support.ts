import { createClient } from '@indx-workspace/sdk';

type Seen = { url: URL; init: RequestInit; body: unknown };

export function recordingClient(
  route: (call: Seen) => Response | Promise<Response>,
  options: { timeoutMs?: number } = {},
) {
  const calls: Seen[] = [];
  const fetchDouble: typeof fetch = async (input, init = {}) => {
    const body: unknown = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const call = { url, init, body };
    calls.push(call);
    return route(call);
  };
  const client = createClient({
    baseUrl: 'https://example.test',
    auth: { kind: 'api-key', apiKey: 'key' },
    fetch: fetchDouble,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { runs: client.runs, calls };
}

export const runId = '33333333-3333-4333-8333-333333333333';
export const agentId = '11111111-1111-4111-8111-111111111111';
export const run = (status: string) => ({
  id: runId,
  workspaceId: '44444444-4444-4444-8444-444444444444',
  agentId,
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
  output: null,
  pendingApproval: null,
  accountingState: 'pending',
  accountingError: null,
  parentRunId: null,
});
export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
export const stream = (body: string) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
