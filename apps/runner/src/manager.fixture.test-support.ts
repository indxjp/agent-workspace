import { vi } from 'vitest';
import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import { createRunnerManagerServer } from './manager.js';
import type { ManagedRuntimeDriver } from './manager-support.js';

export const TOKEN = 'runner-manager-fixture-token-more-than-32-characters';

export function fixtureDriver(): {
  driver: ManagedRuntimeDriver;
  create: ReturnType<typeof vi.fn<ManagedRuntimeDriver['create']>>;
  destroy: ReturnType<typeof vi.fn<ManagedRuntimeDriver['destroy']>>;
} {
  const live = new Set<string>();
  const create = vi.fn<ManagedRuntimeDriver['create']>((config) => {
    const handle: RuntimeHandle = {
      id: `handle-${String(live.size + 1)}`,
      driver: 'docker',
      externalId: `container-${String(live.size + 1)}`,
      workspacePath: config.workspacePath,
      createdAt: new Date('2026-09-10T00:00:00Z'),
    };
    live.add(handle.id);
    return Promise.resolve(handle);
  });
  const destroy = vi.fn<ManagedRuntimeDriver['destroy']>((handle) => {
    live.delete(handle.id);
    return Promise.resolve();
  });
  return {
    create,
    destroy,
    driver: {
      create,
      destroy,
      isLive: (handle) => Promise.resolve(live.has(handle.id)),
    },
  };
}

export async function withManager(
  run: (
    base: string,
    fixture: ReturnType<typeof fixtureDriver>,
    proxy: ReturnType<typeof vi.fn<typeof fetch>>,
  ) => Promise<void>,
): Promise<void> {
  const fixture = fixtureDriver();
  const proxy = vi.fn<typeof fetch>().mockResolvedValue(
    new Response('event: run-done\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
  const server = createRunnerManagerServer({
    token: TOKEN,
    driver: fixture.driver,
    workspacesRoot: '/srv/runtimes',
    runtimeOrigin: (handle) => `http://${handle.externalId}:8080`,
    fetch: proxy,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  try {
    await run(`http://127.0.0.1:${String(address.port)}`, fixture, proxy);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export const allocationBody = {
  workspaceId: 'workspace-one',
  sessionId: 'session-one',
  engine: 'claude-agent-sdk',
  runSpec: {
    runtimeProfileId: 'profile-one',
    driver: 'docker',
    networkPolicy: 'none',
    filesystem: 'read-write',
  },
};

export const authenticated = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
};

export function allocate(base: string): Promise<Response> {
  return fetch(`${base}/runtimes`, {
    method: 'POST',
    headers: authenticated,
    body: JSON.stringify(allocationBody),
  });
}
