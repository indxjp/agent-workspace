import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiProblemError, createClient } from '@indx-workspace/sdk';
import { NextRequest } from 'next/server';
import { POST as startRunRoute } from '../../app/api/agents/[id]/runs/route';
import { GET as listAgentsRoute, POST as createAgentRoute } from '../../app/api/agents/route';
import { GET as runEventsRoute } from '../../app/api/runs/[id]/events/route';
import { GET as readRunRoute } from '../../app/api/runs/[id]/route';
import { proxy } from '../../proxy';

export const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

export const BASE_URL = 'http://127.0.0.1:3000';

export const PASSED_THROUGH = 'x-middleware-next';

export const HOUR_MS = 60 * 60 * 1000;

export const DAY_MS = 24 * HOUR_MS;

export const PINNED_NOW = new Date(Date.now() + HOUR_MS);

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

export const ROUTES: readonly {
  readonly method: string;
  readonly pattern: RegExp;
  readonly handler: RouteHandler;
}[] = [
  { method: 'GET', pattern: /^\/api\/agents$/u, handler: listAgentsRoute },
  { method: 'POST', pattern: /^\/api\/agents$/u, handler: createAgentRoute },
  { method: 'POST', pattern: /^\/api\/agents\/([^/]+)\/runs$/u, handler: startRunRoute },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)$/u, handler: readRunRoute },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)\/events$/u, handler: runEventsRoute },
];

export const reachedRoutes: string[] = [];

export async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new NextRequest(input instanceof Request ? input : new Request(input, init));
  const gated = await proxy(request);
  if (gated.headers.get(PASSED_THROUGH) !== '1') return gated;
  const { pathname } = request.nextUrl;
  for (const route of ROUTES) {
    const match = route.method === request.method ? route.pattern.exec(pathname) : null;
    if (match === null) continue;
    reachedRoutes.push(`${request.method} ${pathname}`);
    return route.handler(request, { params: Promise.resolve({ id: match[1] ?? '' }) });
  }
  throw new Error(`the quickstart harness has no route for ${request.method} ${pathname}`);
}

export function client(apiKey: string): ReturnType<typeof createClient> {
  return createClient({
    baseUrl: BASE_URL,
    auth: { kind: 'api-key', apiKey },
    fetch: serve,
    timeoutMs: 10_000,
  });
}

export async function refusal(call: () => Promise<unknown>): Promise<ApiProblemError> {
  const outcome = await call().then(
    () => null,
    (error: unknown) => error,
  );
  if (!(outcome instanceof ApiProblemError)) {
    throw new Error(`expected an ApiProblemError, got ${String(outcome)}`);
  }
  return outcome;
}

export const AGENT_MODEL = 'claude-sonnet-4-5';

export async function startModelListServer(): Promise<{
  readonly server: Server;
  readonly url: string;
}> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models') === true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [
            {
              id: AGENT_MODEL,
              type: 'model',
              display_name: 'Claude Sonnet 4.5',
              created_at: '2025-09-29T00:00:00Z',
            },
          ],
          has_more: false,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${String(port)}` };
}

export const AGENT_BODY = {
  instructions: 'Answer briefly.',
  model: AGENT_MODEL,
  permissions: {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  },
} as const;
