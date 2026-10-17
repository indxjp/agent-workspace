import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { createInMemorySecretsService } from '@agent-workspace/core/secrets';
import type { RuntimeDriverId, RuntimeRunSpec } from '@agent-workspace/runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from '../errors';
import { createSecretsRuntimeConnectionStoreProvider } from '../runtimes/connections';
import type { LaunchContext } from '../runs/environment';
import { installDriverRegistry } from '../composition/services';
import {
  clearWebRuntimeRegistry,
  currentWebRuntimeRegistry,
  type WebRuntimeRegistry,
} from '../runtimes/registry';
import { createRuntimeManagerClient } from './runtime-manager-client';
import { createProviderCredentialResolver } from './runtime-provider-credential';

const MANAGER_TOKEN = 'runtime-provider-credential-manager-token-over-32';
const KEY = 'SENTINEL_provider_key_0123456789';
const PROVIDER_DRIVERS: readonly RuntimeDriverId[] = [
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
];

const servers: Server[] = [];
let directory = '';
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aw-provider-credential-'));
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('HOST', '127.0.0.1');
  vi.stubEnv('AW_RUNTIME_VERIFICATION_FILE', join(directory, 'verifications.json'));
});
afterEach(() => {
  clearWebRuntimeRegistry();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  vi.restoreAllMocks();
});

type ManagerCall = {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** A fake runner manager: records each allocation and answers with `reply`. */
async function fakeManager(reply: (call: ManagerCall) => { status: number; body: unknown }) {
  const calls: ManagerCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const call = {
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      calls.push(call);
      const answer = reply(call);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return { calls, url };
}

const VERIFIED = {
  status: 200,
  body: {
    fingerprint: 'fingerprint-one',
    verifiedAt: '2026-10-08T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
  },
};

const ALLOCATED = {
  status: 201,
  body: {
    handle: {
      id: 'handle-1',
      driver: 'external',
      externalId: 'sandbox-1',
      workspacePath: '/workspace',
      createdAt: '2026-10-08T00:00:00Z',
    },
    runnerUrl: 'http://manager/runtimes/handle-1',
  },
};

function launchContext(workspaceId: string): LaunchContext {
  return {
    run: {},
    agent: { id: 'agent', workspaceId, engine: 'claude-agent-sdk' },
    session: { id: 'session-one', agentId: 'agent', engine: null },
    principal: {
      principalId: 'principal',
      ownerPrincipalId: 'principal',
      userId: 'user',
      workspaceId,
      scope: null,
    },
    prompt: 'hello',
  } as unknown as LaunchContext;
}

function specFor(driver: RuntimeDriverId, runtimeConnectionId?: string): RuntimeRunSpec {
  return {
    runtimeProfileId: 'profile-one',
    driver,
    ...(runtimeConnectionId === undefined ? {} : { runtimeConnectionId }),
    networkPolicy: 'none',
    filesystem: 'read-write',
  };
}

/** The web side as `register.ts` wires it: stored connection -> resolver -> manager client. */
function webSide(managerUrl: string) {
  const secrets = createInMemorySecretsService();
  const scopes = createInMemoryWorkspaceScopeResolver([
    { id: 'workspace-a', slug: 'workspace-a' },
    { id: 'workspace-b', slug: 'workspace-b' },
  ]);
  const connections = createSecretsRuntimeConnectionStoreProvider({ secrets, scopes });
  const resolve = createProviderCredentialResolver({ secrets, scopes });
  const client = createRuntimeManagerClient(managerUrl, MANAGER_TOKEN);
  return {
    secrets,
    scopes,
    connect: async (workspaceId: string, driver: RuntimeDriverId, credential = KEY) => {
      const outcome = await connections
        .forWorkspace(workspaceId)
        .create({ name: 'primary', driver, endpoint: 'https://provider.example', credential });
      if (outcome.kind !== 'created') throw new Error('connection was not created');
      return outcome.connection;
    },
    client,
    resolve,
    /** Test Runtime as `installDriverRegistry` wires it for the runner manager's own driver. */
    testRuntime: async (
      driver: RuntimeDriverId,
      managerUrl: string,
    ): Promise<WebRuntimeRegistry> => {
      vi.stubEnv('RUNTIME_DRIVER', driver);
      await installDriverRegistry(client, managerUrl, 'none', resolve);
      const registry = currentWebRuntimeRegistry();
      if (registry === null) throw new Error('the runtime registry was not installed');
      return registry;
    },
    allocate: async (workspaceId: string, spec: RuntimeRunSpec) =>
      client.allocate(
        launchContext(workspaceId),
        spec,
        undefined,
        await resolve(workspaceId, spec),
      ),
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected the promise to reject');
}

function watchConsole(): () => string {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  return () => JSON.stringify(spies.map((spy) => spy.mock.calls));
}

describe.each(PROVIDER_DRIVERS)('provider credential forwarding (%s)', (driver) => {
  it('delivers the resolved key in a header to the manager, never in the body', async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);
    const connection = await web.connect('workspace-a', driver);

    await web.allocate('workspace-a', specFor(driver, connection.id));

    expect(manager.calls).toHaveLength(1);
    expect(manager.calls[0]?.headers['x-provider-credential']).toBe(KEY);
    expect(manager.calls[0]?.body).not.toContain(KEY);
  });

  it('redacts a key the manager echoes in its error, and logs nothing with it', async () => {
    const logged = watchConsole();
    const manager = await fakeManager((call) => ({
      status: 502,
      body: { error: 'provider_failed', echoed: call.headers['x-provider-credential'] },
    }));
    const web = webSide(manager.url);
    const connection = await web.connect('workspace-a', driver);

    const error = await rejection(web.allocate('workspace-a', specFor(driver, connection.id)));

    expect(error.message).toContain('runtime manager allocation failed with 502');
    expect(error.message).toContain('[redacted]');
    expect(`${error.message}${String(error.stack)}${logged()}`).not.toContain(KEY);
  });

  it('refuses a profile with no runtime connection before calling the manager', async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);

    const error = await rejection(web.allocate('workspace-a', specFor(driver)));

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe('runtime_connection_missing');
    expect(error.message).toContain('profile-one');
    expect(manager.calls).toHaveLength(0);
  });

  it('refuses an unknown connection, naming it, before calling the manager', async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);

    const error = await rejection(web.allocate('workspace-a', specFor(driver, 'connection-gone')));

    expect((error as DomainError).code).toBe('runtime_connection_missing');
    expect(error.message).toContain('connection-gone');
    expect(manager.calls).toHaveLength(0);
  });

  it("never resolves another tenant's connection", async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);
    const foreign = await web.connect('workspace-b', driver);

    const error = await rejection(web.allocate('workspace-a', specFor(driver, foreign.id)));

    expect((error as DomainError).code).toBe('runtime_connection_missing');
    expect(error.message).not.toContain(KEY);
    expect(manager.calls).toHaveLength(0);
  });

  it('does not hand a connection of another driver to this one', async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);
    const other = await web.connect('workspace-a', driver === 'external' ? 'docker' : 'external');

    const error = await rejection(web.allocate('workspace-a', specFor(driver, other.id)));

    expect((error as DomainError).code).toBe('runtime_connection_missing');
    expect(manager.calls).toHaveLength(0);
  });

  it('fails a revoked (emptied) credential with a typed error naming the connection', async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);
    const connection = await web.connect('workspace-a', driver);
    const scope = await web.scopes.forWorkspaceId('workspace-a');
    if (scope === null) throw new Error('workspace-a is unknown');
    await web.secrets.replace(scope, connection.id, Buffer.from('{"endpoint":"x"}', 'utf8'));

    const error = await rejection(web.allocate('workspace-a', specFor(driver, connection.id)));

    expect((error as DomainError).code).toBe('runtime_connection_credential_unavailable');
    expect(error.message).toContain(connection.name);
    expect(manager.calls).toHaveLength(0);
  });

  it('fails a credential that is not a valid header value without sending or logging it', async () => {
    const logged = watchConsole();
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);
    const connection = await web.connect('workspace-a', driver, `${KEY}\n`);

    const error = await rejection(web.allocate('workspace-a', specFor(driver, connection.id)));

    expect((error as DomainError).code).toBe('runtime_connection_credential_unavailable');
    expect(manager.calls).toHaveLength(0);
    expect(`${error.message}${String(error.stack)}${logged()}`).not.toContain(KEY);
  });
});

describe('provider credential scope', () => {
  it('sends no credential header for a driver that takes none, even with a connection', async () => {
    const manager = await fakeManager(() => ALLOCATED);
    const web = webSide(manager.url);
    const connection = await web.connect('workspace-a', 'docker');

    await web.allocate('workspace-a', specFor('docker', connection.id));

    expect(manager.calls[0]?.headers['x-provider-credential']).toBeUndefined();
  });
});

describe.each(PROVIDER_DRIVERS)(
  'provider credential on Test Runtime and destroy (%s)',
  (driver) => {
    it('verifies with the key in a header, never in the body', async () => {
      const manager = await fakeManager(() => VERIFIED);
      const web = webSide(manager.url);
      const connection = await web.connect('workspace-a', driver);
      const registry = await web.testRuntime(driver, manager.url);

      await registry.test(driver, 'echo', {
        workspaceId: 'workspace-a',
        runtimeConnectionId: connection.id,
      });

      expect(manager.calls).toHaveLength(1);
      expect(manager.calls[0]?.headers['x-provider-credential']).toBe(KEY);
      expect(manager.calls[0]?.body).not.toContain(KEY);
    });

    it('redacts a key the manager echoes when verification fails, and logs nothing with it', async () => {
      const logged = watchConsole();
      const manager = await fakeManager((call) => ({
        status: 502,
        body: { error: 'provider_failed', echoed: call.headers['x-provider-credential'] },
      }));
      const web = webSide(manager.url);
      const connection = await web.connect('workspace-a', driver);
      const registry = await web.testRuntime(driver, manager.url);

      const error = await rejection(
        registry.test(driver, 'echo', {
          workspaceId: 'workspace-a',
          runtimeConnectionId: connection.id,
        }),
      );

      expect(error.message).toContain('runtime manager verification failed with 502');
      expect(error.message).toContain('[redacted]');
      expect(`${error.message}${String(error.stack)}${logged()}`).not.toContain(KEY);
    });

    it('refuses a Test Runtime that names no connection before calling the manager', async () => {
      const manager = await fakeManager(() => VERIFIED);
      const web = webSide(manager.url);
      await web.connect('workspace-a', driver);
      const registry = await web.testRuntime(driver, manager.url);

      const error = await rejection(registry.test(driver, 'echo', { workspaceId: 'workspace-a' }));

      expect((error as DomainError).code).toBe('runtime_connection_missing');
      expect(error.message).toContain(`Test Runtime of driver ${driver}`);
      expect(error.message).not.toContain('verification');
      expect(manager.calls).toHaveLength(0);
    });

    it("never verifies with another tenant's connection", async () => {
      const manager = await fakeManager(() => VERIFIED);
      const web = webSide(manager.url);
      const foreign = await web.connect('workspace-b', driver);
      const registry = await web.testRuntime(driver, manager.url);

      const error = await rejection(
        registry.test(driver, 'echo', {
          workspaceId: 'workspace-a',
          runtimeConnectionId: foreign.id,
        }),
      );

      expect((error as DomainError).code).toBe('runtime_connection_missing');
      expect(manager.calls).toHaveLength(0);
    });

    it('destroys with the key in a header and redacts a key the manager echoes', async () => {
      const logged = watchConsole();
      const manager = await fakeManager((call) =>
        call.headers['x-provider-credential'] === KEY && manager.calls.length === 1
          ? { status: 204, body: null }
          : { status: 502, body: { echoed: call.headers['x-provider-credential'] } },
      );
      const web = webSide(manager.url);
      const connection = await web.connect('workspace-a', driver);
      const credential = await web.resolve('workspace-a', specFor(driver, connection.id));

      await web.client.destroy('handle-1', credential);
      const error = await rejection(web.client.destroy('handle-1', credential));

      expect(manager.calls[0]?.headers['x-provider-credential']).toBe(KEY);
      expect(manager.calls[0]?.body).toBe('');
      expect(error.message).toContain('runtime manager destroy failed with 502');
      expect(error.message).toContain('[redacted]');
      expect(`${error.message}${String(error.stack)}${logged()}`).not.toContain(KEY);
    });
  },
);

describe.each(['docker', 'local'] as const)('Test Runtime and destroy on %s', (driver) => {
  it('send no credential header, even when a connection is named', async () => {
    const manager = await fakeManager((call) =>
      call.method === 'DELETE' ? { status: 204, body: null } : VERIFIED,
    );
    const web = webSide(manager.url);
    const connection = await web.connect('workspace-a', driver);
    const registry = await web.testRuntime(driver, manager.url);

    await registry.test(driver, 'echo', {
      workspaceId: 'workspace-a',
      runtimeConnectionId: connection.id,
    });
    await web.client.destroy(
      'handle-1',
      await web.resolve('workspace-a', specFor(driver, connection.id)),
    );

    expect(manager.calls.map((call) => call.headers['x-provider-credential'])).toEqual([
      undefined,
      undefined,
    ]);
  });
});
