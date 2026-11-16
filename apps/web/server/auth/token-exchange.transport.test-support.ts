import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';

import { POST as startRunRoute } from '../../app/api/agents/[id]/runs/route';
import { POST as createAgentRoute } from '../../app/api/agents/route';
import { GET as meRoute } from '../../app/api/me/route';
import { GET as readRunRoute } from '../../app/api/runs/[id]/route';
import { GET as listRunsRoute } from '../../app/api/runs/route';
import { GET as listWorkspacesRoute } from '../../app/api/workspaces/route';
import { proxy } from '../../proxy';

export const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_ISSUER_URL',
  'OIDC_REDIRECT_URI',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

export const BASE_URL = 'http://127.0.0.1:3000';

export const PASSED_THROUGH = 'x-middleware-next';

export const ISSUER = 'https://idp.example';

export const AUDIENCE = 'portal-web';

export const AGENT_MODEL = 'claude-sonnet-4-5';

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

export const ROUTES: readonly { method: string; pattern: RegExp; handler: RouteHandler }[] = [
  { method: 'POST', pattern: /^\/api\/agents$/u, handler: createAgentRoute },
  { method: 'POST', pattern: /^\/api\/agents\/([^/]+)\/runs$/u, handler: startRunRoute },
  { method: 'GET', pattern: /^\/api\/runs$/u, handler: (request) => listRunsRoute(request) },
  { method: 'GET', pattern: /^\/api\/runs\/([^/]+)$/u, handler: readRunRoute },
  { method: 'GET', pattern: /^\/api\/me$/u, handler: (request) => meRoute(request) },
  {
    method: 'GET',
    pattern: /^\/api\/workspaces$/u,
    handler: (request) => listWorkspacesRoute(request),
  },
];

export async function serve(
  method: string,
  pathname: string,
  bearer: string,
  body?: unknown,
): Promise<Response> {
  const request = new NextRequest(`${BASE_URL}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const gated = await proxy(request);
  if (gated.headers.get(PASSED_THROUGH) !== '1') return gated;
  for (const route of ROUTES) {
    const match = route.method === method ? route.pattern.exec(request.nextUrl.pathname) : null;
    if (match === null) continue;
    return route.handler(request, { params: Promise.resolve({ id: match[1] ?? '' }) });
  }
  throw new Error(`the harness has no route for ${method} ${pathname}`);
}

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
