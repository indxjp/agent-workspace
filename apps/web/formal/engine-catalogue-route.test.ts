/**
 * `sdk.json` (ENG-02c, #319), replayed against the real `GET /api/engines`.
 *
 * The model's `Descriptor` carries the four fields the projection can observe; `capabilities` is
 * `Contracts/Engines.lean`'s business and is checked by `schemas.json`. So the route's body is
 * projected onto those four fields before the comparison, and every other field of it is already
 * held to `EngineDescriptorSchema` by the route itself. Part of the `engines` family; see
 * `engines.test.ts`.
 */
import { EngineCapabilitiesSchema } from '@indx-workspace/contracts/engines';
import { createClient } from '@indx-workspace/sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as getEngines } from '../app/api/engines/route';
import { listEngines } from '../server/engines/handlers';
import {
  clearEngineImagesConfiguredForTests,
  configureEngineImagesForTests,
} from '../server/engines/images';
import { clearEnginesRegisteredForTests, registerEngineForTests } from '../server/engines/registry';
import { parseRole } from '../server/rbac/core/roles';
import { installRbacHarness, TEST_WORKSPACE_ID } from '../server/rbac/testing';
import { asRecord, asString, loadVectors, type FormalVector } from '../../../tests/formal/vectors';
import { asArray } from './engines.test-support';

const sdkVectors = loadVectors('engines', 'sdk.json');

const MEMBER = { email: 'formal-engines@example.test' };

/** The `{ id, displayName, version, installed }` projection the Lean model states. */
function projectDescriptor(value: unknown, what: string): Record<string, unknown> {
  const descriptor = asRecord(value, what);
  return {
    id: descriptor['id'],
    displayName: descriptor['displayName'],
    version: descriptor['version'],
    installed: descriptor['installed'],
  };
}

/**
 * The call the real SDK makes, as the CLI and the browser both reach it: `engines.list()`
 * through a fetch double that records the request and answers with the route's own body.
 * `expected['columns']` is replayed against the real table header by
 * `tests/formal/engines.test.ts`, which drives the `aw` binary.
 */
async function replayRequestVector(vector: FormalVector): Promise<void> {
  const expected = asRecord(vector.expected, vector.id);
  const accepted = expected['expect'];
  if (typeof accepted !== 'number') throw new Error(`${vector.id}: expect is not a number`);
  const served = listEngines();
  expect(served.status).toBe(accepted);
  const seen: Request[] = [];
  const sdkAnswering = (status: number) =>
    createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'api-key', apiKey: 'ak_live_k' },
      fetch: (request, init) => {
        seen.push(new Request(request, init));
        return Promise.resolve(
          new Response(JSON.stringify(served.body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });

  await expect(sdkAnswering(accepted).engines.list()).resolves.toBeDefined();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.method).toBe(expected['method']);
  expect(new URL(seen[0]?.url ?? '').pathname).toBe(expected['path']);
  // The accepted status is exactly the model's: any other, even another success, is refused.
  await expect(sdkAnswering(accepted + 1).engines.list()).rejects.toMatchObject({
    status: accepted + 1,
  });
}

/**
 * The decision itself is replayed by `authz-decide.test.ts` over the whole matrix; what
 * this vector pins is that the catalogue route is in it and readable by every role.
 */
async function replayAuthzVector(vector: FormalVector): Promise<void> {
  const expected = asRecord(vector.expected, vector.id);
  const readableBy = asArray(expected['readableBy'], vector.id).map((entry, index) => {
    const role = parseRole(asString(entry, `${vector.id} role ${String(index)}`));
    if (role === null) throw new Error(`${vector.id}: "${String(entry)}" is not a role`);
    return role;
  });
  const harness = installRbacHarness(
    readableBy.map((role) => ({
      email: `${role}@example.test`,
      name: 'Formal',
      workspaceId: TEST_WORKSPACE_ID,
      role,
    })),
  );
  try {
    for (const role of readableBy) {
      const response = await harness.call(getEngines, {
        method: 'GET',
        path: '/api/engines',
        as: { email: `${role}@example.test` },
      });
      expect(response.status, `${vector.id}: ${role}`).toBe(200);
    }
  } finally {
    harness.teardown();
  }
}

/**
 * ENG-07 (#306): `installed` is the deployment's configured `engine to image` map and is no
 * longer a field of a registered descriptor, so the vector's `installed` flags are replayed as
 * the *configuration* this deployment has. That makes the assertion in the replay the T1 statement
 * itself — the catalogue the route serves is the map — rather than an echo of a field the test
 * handed the registry a moment earlier.
 */
function configureImagesFromExpected(vector: FormalVector): void {
  const expected = asRecord(vector.expected, vector.id);
  configureEngineImagesForTests(
    new Map(
      asArray(expected['engines'] ?? [], vector.id)
        .map((entry, index) => asRecord(entry, `${vector.id} engine ${String(index)}`))
        .filter((descriptor) => descriptor['installed'] === true)
        .map((descriptor) => [
          asString(descriptor['id'], `${vector.id} engine id`),
          `registry.example/agent-workspace/runtime-${asString(descriptor['id'], 'id')}:test`,
        ]),
    ),
  );
}

/** A descriptor with every capability off, named by the vector's `extraEngines` entry. */
function registerExtraEngines(vector: FormalVector): void {
  const input = asRecord(vector.input, vector.id);
  for (const [index, extra] of asArray(input['extraEngines'], vector.id).entries()) {
    const descriptor = asRecord(extra, `${vector.id} extra ${String(index)}`);
    registerEngineForTests({
      id: asString(descriptor['id'], `${vector.id} extra id`),
      displayName: asString(descriptor['displayName'], `${vector.id} extra displayName`),
      version: asString(descriptor['version'], `${vector.id} extra version`),
      capabilities: EngineCapabilitiesSchema.parse({
        mcp: false,
        skills: false,
        subagents: false,
        resume: false,
        fork: false,
        interrupt: false,
        streamingText: false,
        reasoning: false,
        maxTurns: 'adapter',
        maxBudget: 'none',
        wireProtocols: ['anthropic-messages'],
      }),
    });
  }
}

/** Asserts the served catalogue (or the whole-route refusal) against the vector's expectation. */
function expectServedCatalogue(
  vector: FormalVector,
  response: { readonly status: number; readonly body: unknown; readonly text: string },
): void {
  const expected = asRecord(vector.expected, vector.id);
  expect(response.status).toBe(expected['status']);
  if (expected['engines'] === null) {
    // Refused whole: no engine of the registry crosses, not even a describable one.
    const body = asRecord(response.body, `${vector.id} problem body`);
    const error = asRecord(body['error'], `${vector.id} problem error`);
    expect(error['code']).toBe(expected['code']);
    expect(response.text).not.toContain('claude-agent-sdk');
    return;
  }
  const body = asRecord(response.body, `${vector.id} body`);
  const served = asArray(body['engines'], `${vector.id} engines`);
  expect(served.map((entry, index) => projectDescriptor(entry, `${vector.id}[${index}]`))).toEqual(
    asArray(expected['engines'], `${vector.id} expected`).map((entry, index) =>
      projectDescriptor(entry, `${vector.id} expected[${index}]`),
    ),
  );
}

async function replayCatalogueVector(vector: FormalVector): Promise<void> {
  configureImagesFromExpected(vector);
  registerExtraEngines(vector);

  const harness = installRbacHarness([
    { email: MEMBER.email, name: 'Formal', workspaceId: TEST_WORKSPACE_ID, role: 'viewer' },
  ]);
  try {
    const response = await harness.call(getEngines, {
      method: 'GET',
      path: '/api/engines',
      as: MEMBER,
    });
    expectServedCatalogue(vector, response);
  } finally {
    harness.teardown();
  }
}

describe('the engine catalogue route is a projection of the registry', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
    clearEngineImagesConfiguredForTests();
  });

  it.each(sdkVectors.map((v) => [v.id, v] as const))('%s', async (_id, vector) => {
    if (vector.id === 'request') return replayRequestVector(vector);
    if (vector.id.startsWith('authz/')) return replayAuthzVector(vector);
    return replayCatalogueVector(vector);
  });
});
