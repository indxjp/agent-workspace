import { afterEach, describe, expect, it } from 'vitest';
import {
  POST as createConnectionRoute,
  GET as listConnectionsRoute,
} from '../../app/api/runtime-connections/route';
import { clearApplicationContext } from '../application-context';
import { request, useMemoryRuntime, WORKSPACE_A, WORKSPACE_B } from './runtime-routes.test-support';

describe('/api/runtime-connections', () => {
  afterEach(() => clearApplicationContext());

  it(
    'answers 503 unconfigured, never a fabricated list',
    answers503UnconfiguredNeverFabricatedList,
  );

  it(
    'creates a connection and never echoes its credential back',
    createsConnectionNeverEchoesCredentialBack,
  );

  it(
    "rejects a body naming a driver outside §14.2's catalogue",
    rejectsBodyNamingDriverOutside142S,
  );

  it(
    "lists only the caller's workspace's connections, and never a credential",
    listsOnlyCallerSWorkspaceSConnectionsNever,
  );
});

async function answers503UnconfiguredNeverFabricatedList() {
  const response = await listConnectionsRoute(
    request('GET', '/api/runtime-connections', { workspace: WORKSPACE_A }),
  );
  expect(response.status).toBe(503);
}

async function createsConnectionNeverEchoesCredentialBack() {
  useMemoryRuntime();
  // Bound the real clock around the request rather than excluding one wrong constant
  // (round-3 repair — ADR-0015: `expect(body.createdAt).not.toBe(new Date(0).toISOString())`
  // decided on the absence of a single negative, which `new Date(1)` would still have passed).
  // A positive assertion that the returned instant falls inside [before, after] cannot be
  // satisfied by any fabricated constant, past or future.
  const before = Date.now();
  const response = await createConnectionRoute(
    request('POST', '/api/runtime-connections', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        name: 'Primary Docker host',
        driver: 'docker',
        endpoint: 'tcp://docker.internal:2376',
        credential: 'super-secret-client-cert',
      }),
    }),
  );
  const after = Date.now();
  expect(response.status).toBe(201);
  const text = await response.text();
  expect(text).not.toContain('super-secret-client-cert');
  expect(text).not.toContain('tcp://docker.internal:2376');
  const body = JSON.parse(text) as { name: string; driver: string; createdAt: string };
  // The response carries the STORED name, not the caller's raw display string — see
  // connections.ts's header (W3-CP-06-B2). A caller-supplied name is encoded before it is ever
  // persisted, so this is the value both create() and a later list() agree on.
  expect(body.name).toBe('RUNTIME_CONNECTION__DOCKER__PRIMARY_DOCKER_HOST');
  expect(body.driver).toBe('docker');
  const createdAtMs = new Date(body.createdAt).getTime();
  expect(createdAtMs).toBeGreaterThanOrEqual(before);
  expect(createdAtMs).toBeLessThanOrEqual(after);
}

async function rejectsBodyNamingDriverOutside142S() {
  useMemoryRuntime();
  const response = await createConnectionRoute(
    request('POST', '/api/runtime-connections', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        name: 'x',
        driver: 'my-cloud',
        endpoint: 'https://x',
        credential: 'y',
      }),
    }),
  );
  expect(response.status).toBe(400);
}

async function listsOnlyCallerSWorkspaceSConnectionsNever() {
  useMemoryRuntime();
  await createConnectionRoute(
    request('POST', '/api/runtime-connections', {
      workspace: WORKSPACE_A,
      body: JSON.stringify({
        name: 'Conn A',
        driver: 'docker',
        endpoint: 'https://a',
        credential: 'secret-a',
      }),
    }),
  );
  const responseA = await listConnectionsRoute(
    request('GET', '/api/runtime-connections', { workspace: WORKSPACE_A }),
  );
  const responseB = await listConnectionsRoute(
    request('GET', '/api/runtime-connections', { workspace: WORKSPACE_B }),
  );
  const textA = await responseA.text();
  expect(textA).not.toContain('secret-a');
  const bodyA = JSON.parse(textA) as { runtimeConnections: unknown[] };
  const bodyB = (await responseB.json()) as { runtimeConnections: unknown[] };
  expect(bodyA.runtimeConnections).toHaveLength(1);
  expect(bodyB.runtimeConnections).toHaveLength(0);
}
