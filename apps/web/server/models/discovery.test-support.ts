import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { ModelConnectionRecord } from '@agent-workspace/core/db';

import type { ResolvedModelConnection } from './store';

const openServers: Server[] = [];

export function closeFixtureServers(): void {
  while (openServers.length > 0) openServers.pop()?.close();
}

export interface Fixture {
  baseUrl: string;
  requests: number;
}

export async function fixtureServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<Fixture> {
  const fixture: Fixture = { baseUrl: '', requests: 0 };
  const server = createServer((req, res) => {
    fixture.requests += 1;
    handler(req, res);
  });
  openServers.push(server);
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const { port } = server.address() as AddressInfo;
  fixture.baseUrl = `http://127.0.0.1:${port}`;
  return fixture;
}

export function connection(
  provider: ModelConnectionRecord['provider'],
  config: ModelConnectionRecord['config'],
): ResolvedModelConnection {
  return {
    connection: {
      id: 'conn-fixture',
      workspaceId: 'ws-fixture',
      name: 'Fixture connection',
      provider,
      config,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
    credential: 'sk-fixture-secret',
  };
}

export function modelsResponse(res: ServerResponse, ids: readonly string[]): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      data: ids.map((id) => ({
        id,
        type: 'model',
        display_name: id,
        created_at: new Date(0).toISOString(),
      })),
    }),
  );
}
