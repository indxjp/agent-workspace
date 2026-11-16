import { main, type CliIo } from '@indx-workspace/aw';

export const agent = '11111111-1111-4111-8111-111111111111';
export const runId = '33333333-3333-4333-8333-333333333333';
export const session = '55555555-5555-4555-8555-555555555555';
export const workspace = '44444444-4444-4444-8444-444444444444';

export const run = (status: string) => ({
  id: runId,
  workspaceId: workspace,
  agentId: agent,
  projectId: null,
  initiatingUserId: null,
  sessionId: session,
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
export const stream = (body = 'event: done\ndata: null\n\n') =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

export interface Call {
  readonly url: URL;
  readonly method: string;
  readonly body: unknown;
  readonly headers: Headers;
  readonly signal: AbortSignal | null;
}

export async function runMain(
  argv: readonly string[],
  route: (call: Call) => Response | Promise<Response>,
  options: { stdin?: string; signal?: AbortSignal; throwOnStdout?: boolean } = {},
) {
  const calls: Call[] = [];
  let stdout = '';
  let stderr = '';
  const fetchDouble: typeof fetch = async (input, init = {}) => {
    const call: Call = {
      url: input instanceof Request ? new URL(input.url) : new URL(input),
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      headers: new Headers(init.headers),
      signal: init.signal ?? null,
    };
    calls.push(call);
    return route(call);
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(options.stdin ?? ''),
    stdout: (text) => {
      if (options.throwOnStdout) throw new Error('output failed');
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: {
      AGENT_WORKSPACE_URL: 'https://aw.example.com',
      AGENT_WORKSPACE_API_KEY: 'ak_live_test',
    },
    homeDir: 'C:/nonexistent-home',
    fetch: fetchDouble,
    isTty: false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, calls };
}

export const successRoute = ({ url, method }: Call): Response => {
  if (method === 'POST' && url.pathname.endsWith('/runs'))
    return json(202, { run: run('queued'), events: `/api/runs/${runId}/events` });
  if (url.pathname.endsWith('/events')) return stream();
  if (url.pathname.endsWith('/interrupt')) return json(200, { run: run('cancelled') });
  if (url.pathname === '/api/runs')
    return json(200, { runs: [run('completed')], nextCursor: 'next' });
  return json(200, { run: run('completed') });
};
