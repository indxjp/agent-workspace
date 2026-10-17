import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  clearWebRuntimeRegistry,
  configureWebRuntimeRegistry,
  createWebRuntimeRegistry,
  type TestableDriverRegistry,
} from '../../../../server/runtimes/registry.js';
import { DomainError } from '../../../../server/errors';
import { clearRbacRuntime } from '../../../../server/rbac/runtime';
import { installWorkspaceHeaderRbac, TEST_ROLE_HEADER } from '../../../../server/rbac/testing';
import {
  createDockerDriver,
  createLocalDriver,
  runDockerCommand,
  type RuntimeDriver,
} from '@agent-workspace/runtime';

import { POST } from './route';

// No Docker CLI at all (the self-hosted dgx pool) means no daemon either: skip, not fail (#429).
const dockerDaemonAvailable = await runDockerCommand(['info']).then(
  (result) => result.exitCode === 0,
  () => false,
);

const WORKSPACE_HEADER = 'x-test-workspace';
/** An Owner of this workspace, unless a test names another role; see `installWorkspaceHeaderRbac`. */
const OWNER = { [WORKSPACE_HEADER]: '11111111-1111-4111-8111-111111111111' };

// Issue #388: the route authenticates and authorises before it does anything else. Every test
// below that expects to get past the gate says who is asking.
beforeEach(() => installWorkspaceHeaderRbac(WORKSPACE_HEADER));
afterEach(() => {
  clearWebRuntimeRegistry();
  clearRbacRuntime();
});

const testContext = { params: Promise.resolve({ id: 'test' }) };

function testRegistry(
  drivers: readonly RuntimeDriver<string, string>[],
): TestableDriverRegistry<string, string> {
  const byId = new Map<string, RuntimeDriver<string, string>>(
    drivers.map((driver) => [driver.id, driver]),
  );
  const verified = new Set<string>();
  return {
    wasVerified: (driverId) => verified.has(driverId),
    async test(driverId, config, request, renderEvent) {
      const driver = byId.get(driverId);
      if (driver === undefined) throw new Error(`driver ${driverId} is not registered`);
      const handle = await driver.create(config);
      const transcript: string[] = [];
      try {
        const connection = await driver.startAgent(handle, request);
        for await (const event of connection.events) transcript.push(renderEvent(event));
        await connection.sessionId;
      } finally {
        await driver.destroy(handle);
      }
      verified.add(driverId);
      return { driverId, handle, transcript, destroyed: true };
    },
  };
}

describe('POST /api/runtimes/test', () => {
  const networkName = `w3-api-registry-${randomUUID().slice(0, 8)}`;
  afterAll(async () => {
    if (dockerDaemonAvailable) await runDockerCommand(['network', 'rm', networkName]);
  });
  // Issue #388: this route starts real sandbox infrastructure, and it used to have no auth call
  // of its own — `proxy.ts`'s session gate was its only guard, and that gate admits any bearer
  // shaped like an API key. The registry must never be reached by a caller the gate refuses.
  describe('who may start a test runtime', () => {
    function recordingRegistry(): unknown[][] {
      const calls: unknown[][] = [];
      configureWebRuntimeRegistry({
        list: () => Promise.resolve([]),
        test(driverId, echo) {
          calls.push([driverId, echo]);
          return Promise.resolve({ driverId, transcript: [echo], destroyed: true });
        },
      });
      return calls;
    }

    function testRequest(headers: Record<string, string>): Request {
      return new Request('http://test/api/runtimes/test', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ driver: 'docker' }),
      });
    }

    it('answers 401 to a request with no verified credential, before the registry', async () => {
      const calls = recordingRegistry();
      for (const headers of [{}, { authorization: `Bearer ak_live_${'x'.repeat(40)}` }]) {
        const response = await POST(testRequest(headers), testContext);
        expect(response.status).toBe(401);
      }
      expect(calls).toEqual([]);
    });

    it.each(['builder', 'viewer'] as const)(
      'answers 403 to a %s, before the registry',
      async (role) => {
        const calls = recordingRegistry();
        const response = await POST(
          testRequest({ ...OWNER, [TEST_ROLE_HEADER]: role }),
          testContext,
        );
        expect(response.status).toBe(403);
        expect(calls).toEqual([]);
      },
    );

    it("passes the caller's workspace and the named runtime connection to the registry", async () => {
      const scopes: unknown[] = [];
      configureWebRuntimeRegistry({
        list: () => Promise.resolve([]),
        test(driverId, echo, scope) {
          scopes.push(scope);
          return Promise.resolve({ driverId, transcript: [echo], destroyed: true });
        },
      });
      const request = (body: unknown) =>
        new Request('http://test/api/runtimes/test', {
          method: 'POST',
          headers: { ...OWNER, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

      expect((await POST(request({ driver: 'external' }), testContext)).status).toBe(200);
      expect(
        (await POST(request({ driver: 'external', runtimeConnectionId: 'c-1' }), testContext))
          .status,
      ).toBe(200);
      // A key in the body is never copied into the scope: only first-run setup may supply one.
      expect(
        (
          await POST(
            request({ driver: 'external', runtimeConnectionId: 'c-1', providerCredential: 'k' }),
            testContext,
          )
        ).status,
      ).toBe(200);
      expect(scopes).toEqual([
        { workspaceId: OWNER[WORKSPACE_HEADER] },
        { workspaceId: OWNER[WORKSPACE_HEADER], runtimeConnectionId: 'c-1' },
        { workspaceId: OWNER[WORKSPACE_HEADER], runtimeConnectionId: 'c-1' },
      ]);
      for (const bad of [7, '', null]) {
        const response = await POST(
          request({ driver: 'external', runtimeConnectionId: bad }),
          testContext,
        );
        expect(response.status).toBe(400);
      }
      expect(scopes).toHaveLength(3);
    });

    it.each([
      ['runtime_connection_missing', 422],
      ['runtime_connection_credential_unavailable', 422],
      ['something_else', 400],
    ])('answers a %s refusal with HTTP %i', async (code, status) => {
      configureWebRuntimeRegistry({
        list: () => Promise.resolve([]),
        test: () =>
          Promise.reject(
            new DomainError({
              category: 'validation',
              code,
              publicMessage: `${code}: name the connection`,
            }),
          ),
      });
      const response = await POST(
        new Request('http://test/api/runtimes/test', {
          method: 'POST',
          headers: { ...OWNER, 'Content-Type': 'application/json' },
          body: JSON.stringify({ driver: 'external' }),
        }),
        testContext,
      );

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({
        error: { code, message: `${code}: name the connection` },
      });
    });

    it('lets an Admin through', async () => {
      const calls = recordingRegistry();
      const response = await POST(
        testRequest({ ...OWNER, [TEST_ROLE_HEADER]: 'admin' }),
        testContext,
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual([['docker', 'agent-workspace runtime test']]);
    });
  });

  it('refuses every dynamic operation name except test', async () => {
    const response = await POST(
      new Request('http://test/api/runtimes/unknown', {
        method: 'POST',
        headers: OWNER,
        body: '{}',
      }),
      { params: Promise.resolve({ id: 'unknown' }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'runtime_operation_not_found' });
  });

  it('returns 503 until the real registry is installed', async () => {
    expect(
      await POST(
        new Request('http://test/api/runtimes/test', {
          method: 'POST',
          headers: OWNER,
          body: '{}',
        }),
        testContext,
      ),
    ).toMatchObject({ status: 503 });
  });

  it('calls the named runtime test and returns its transcript', async () => {
    const calls: unknown[][] = [];
    configureWebRuntimeRegistry({
      list: () => Promise.resolve([]),
      test(driverId, echo) {
        calls.push([driverId, echo]);
        return Promise.resolve({ driverId, transcript: [echo], destroyed: true });
      },
    });
    const response = await POST(
      new Request('http://test/api/runtimes/test', {
        method: 'POST',
        headers: { ...OWNER, 'Content-Type': 'application/json' },
        body: JSON.stringify({ driver: 'docker', echo: 'real echo marker' }),
      }),
      testContext,
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([['docker', 'real echo marker']]);
    expect(await response.json()).toEqual({
      driverId: 'docker',
      transcript: ['real echo marker'],
      destroyed: true,
    });
  });

  it.skipIf(!dockerDaemonAvailable)(
    'creates, echoes in, and destroys real local and Docker runtimes through the endpoint',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'w3-api-runtime-test-'));
      const connection = (value: string) => ({
        events: (async function* () {
          await Promise.resolve();
          yield value;
        })(),
        sessionId: Promise.resolve(randomUUID()),
        interrupt: () => Promise.resolve(),
      });
      const local = createLocalDriver<string, string>((_runtime, request) => connection(request));
      const docker = createDockerDriver<string, string>({
        images: new Map([['claude-agent-sdk', 'alpine:3.20']]),
        networkName,
        command: ['sleep', '300'],
        async startAgent(runtime, request) {
          const echoed = await runDockerCommand([
            'exec',
            runtime.externalId,
            'printf',
            '%s',
            request,
          ]);
          if (echoed.exitCode !== 0) throw new Error(echoed.stderr);
          return connection(echoed.stdout);
        },
      });
      const registry = testRegistry([local, docker]);
      configureWebRuntimeRegistry(
        createWebRuntimeRegistry({
          registry,
          entries: [
            { id: 'local', label: 'Local', connectionExists: true, imageReachable: true },
            { id: 'docker', label: 'Docker', connectionExists: true, imageReachable: true },
          ],
          configFor: (driverId) => ({
            sessionId: randomUUID(),
            engine: 'claude-agent-sdk',
            workspacePath: path.join(root, driverId),
          }),
          requestForEcho: String,
          renderEvent: String,
        }),
      );
      try {
        for (const driver of ['local', 'docker']) {
          const marker = `endpoint-echo-${driver}-${randomUUID()}`;
          const response = await POST(
            new Request('http://test/api/runtimes/test', {
              method: 'POST',
              headers: { ...OWNER, 'Content-Type': 'application/json' },
              body: JSON.stringify({ driver, echo: marker }),
            }),
            testContext,
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            driverId: driver,
            transcript: [marker],
            destroyed: true,
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
