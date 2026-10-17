/**
 * Differential conformance for the `authz-tenancy` family (application half): the Lean tenancy
 * model (formal/AgentWorkspace/Authz/Tenancy.lean) replayed against the REAL server code:
 *
 *   - `run-concealment.json`: `readRun`, `streamRunEvents`, `interruptRun` and `revokeRunTokens`
 *     through the installed run API over an `InMemoryRunStore` holding one run of the caller's
 *     workspace and one of another — the real request path up to and past the lookup;
 *   - `principal-selection.json`: `Principal.fromSession`, `fromApiKey`, `fromBrowserToken`;
 *   - `workspace-access.json`: `memberOwnershipResolver` / `ownerOwnershipResolver` over the
 *     in-memory directory and workspace repository;
 *   - `authorise.json`: `requireResourceAccess` with those resolvers through the RBAC harness
 *     (`installRbacHarness`), whose answer after the resolver is `decide()`'s.
 *
 * The package half is `tests/formal/authz-tenancy.test.ts` (decision D-012).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { mintSessionToken, newSessionClaims, verifySessionToken } from '../server/auth/session';
import type { ApiKeyIdentity } from '../server/rbac/directory';
import { createMemoryDirectory } from '../server/rbac/memory-directory';
import { Principal } from '../server/rbac/principal';
import type { Role } from '../server/rbac/roles';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../server/rbac/testing';
import type { TokenScope } from '../server/rbac/token-scope';
import { requireResourceAccess } from '../server/resources/authorise';
import { interruptRun, readRun, revokeRunTokens, streamRunEvents } from '../server/runs/api';
import {
  installRunApi,
  resetRunApi,
  type Principal as RunPrincipal,
  type RunApiEnvironment,
} from '../server/runs/environment';
import { InMemoryRunStore } from '../server/runs/store';
import { memberOwnershipResolver, ownerOwnershipResolver } from '../server/workspaces/access';
import { createMemoryWorkspaceRepository } from '../server/workspaces/testing';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';

const FAMILY = 'authz-tenancy';
const SESSION_SECRET = 'a-test-session-secret-that-is-long-enough-32';

function asRole(value: unknown, what: string): Role {
  const role = asString(value, what);
  if (role === 'owner' || role === 'admin' || role === 'builder' || role === 'viewer') return role;
  throw new Error(`${what}: ${role} is not a role`);
}

async function errorOf(response: Response): Promise<{ code: unknown; message: unknown }> {
  const text = await response.text();
  if (text === '') return { code: undefined, message: undefined };
  const body = asRecord(JSON.parse(text) as unknown, 'response body');
  const error = body['error'] === undefined ? {} : asRecord(body['error'], 'error');
  return { code: error['code'], message: error['message'] };
}

// ---------------------------------------------------------------------------------------------
// Run lookup and 404 concealment, through the real run routes.

const AGENT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  resetRunApi();
});

async function installRuns(input: Record<string, unknown>, id: string): Promise<void> {
  const store = new InMemoryRunStore();
  for (const row of Array.isArray(input['runs']) ? (input['runs'] as unknown[]) : []) {
    const run = asRecord(row, `${id} run`);
    await store.create({
      engine: 'claude-agent-sdk',
      id: asString(run['id'], 'run id'),
      workspaceId: asString(run['workspaceId'], 'run workspace'),
      agentId: AGENT,
      sessionId: SESSION,
    });
  }
  const scope: TokenScope | null =
    input['browserScoped'] === true ? { kind: 'run', id: asString(input['runId'], 'runId') } : null;
  const principal: RunPrincipal = {
    principalId: '77777777-7777-4777-8777-777777777777',
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    userId: '66666666-6666-4666-8666-666666666666',
    workspaceId: asString(input['workspaceId'], 'workspaceId'),
    role: asRole(input['role'], 'role'),
    scope,
  };
  const environment: RunApiEnvironment = {
    authenticate: () => Promise.resolve(principal),
    findAgent: () => Promise.resolve(null),
    openSession: () => Promise.resolve(null),
    ownsRun: () => Promise.resolve(true),
    store,
    revokeRunTokens: () => Promise.resolve({ revoked: 0, outcome: 'already-revoked' }),
    interruptRun: async (_p, run) => {
      await store.finish(run.id, 'cancelled', null);
    },
    launch: () => undefined,
  };
  installRunApi(environment);
}

async function callRunRoute(route: string, runId: string): Promise<Response> {
  const base = `http://web/api/runs/${encodeURIComponent(runId)}`;
  switch (route) {
    case 'read':
      return readRun(new Request(base), runId);
    case 'events':
      return streamRunEvents(new Request(`${base}/events`), runId);
    case 'interrupt':
      return interruptRun(new Request(`${base}/interrupt`, { method: 'POST' }), runId);
    case 'revoke-tokens':
      return revokeRunTokens(
        new Request(`${base}/revoke-tokens`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
        runId,
      );
    default:
      throw new Error(`unknown run route ${route}`);
  }
}

describe('run routes conceal a foreign run exactly as an absent one', () => {
  it.each(loadVectors(FAMILY, 'run-concealment.json').map((v) => [v.id, v] as const))(
    '%s',
    async (id, vector) => {
      const input = asRecord(vector.input, id);
      const expected = asRecord(vector.expected, id);
      await installRuns(input, id);
      const runId = asString(input['runId'], 'runId');
      const response = await callRunRoute(asString(input['route'], 'route'), runId);
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.startsWith('text/event-stream')) {
        await response.body?.cancel();
        expect(expected['kind']).toBe('found');
        return;
      }
      const error = await errorOf(response);
      switch (expected['kind']) {
        case 'not-found':
          expect(response.status).toBe(expected['status']);
          expect(error.code).toBe(expected['code']);
          // Byte-identical for an absent and a foreign run: the message names only the id asked.
          expect(error.message).toBe(expected['message']);
          break;
        case 'preflight':
          expect(response.status).toBe(expected['status']);
          expect(error.code).toBe(expected['code']);
          break;
        case 'found':
          expect(error.code).not.toBe('run_not_found');
          expect(error.code).not.toBe('invalid_run_id');
          break;
        default:
          throw new Error(`${id}: unknown expected kind`);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Workspace selection: the three principal factories.

async function claimsFor(
  sub: string,
  ws: string,
): Promise<Parameters<typeof Principal.fromSession>[0]> {
  const token = await mintSessionToken(newSessionClaims(sub, ws), SESSION_SECRET);
  const verified = await verifySessionToken(token, SESSION_SECRET);
  if (!verified.ok) throw new Error(`could not verify a minted session: ${verified.reason}`);
  return verified.claims;
}

function apiKeyIdentityOf(value: unknown): ApiKeyIdentity {
  const identity = asRecord(value, 'identity');
  return {
    principalId: asString(identity['principalId'], 'principalId'),
    apiKeyId: asString(identity['apiKeyId'], 'apiKeyId'),
    workspaceId: asString(identity['workspaceId'], 'workspaceId'),
    label: asString(identity['label'], 'label'),
    role: asRole(identity['role'], 'role'),
  };
}

function principalView(p: Principal): Record<string, unknown> {
  return {
    principalId: p.principalId,
    kind: p.kind,
    workspaceId: p.workspaceId,
    label: p.label,
    actor: p.actor,
    role: p.role,
    via: p.via,
    userId: p.userId,
    apiKeyId: p.apiKeyId,
    scope: p.scope === null ? null : { kind: p.scope.kind, id: p.scope.id },
  };
}

const principalVectors = loadVectors(FAMILY, 'principal-selection.json');

function sessionMinterInput(): Record<string, unknown> {
  const vector = principalVectors.find((v) => v.id === 'from-session/match');
  if (vector === undefined) throw new Error('no from-session/match vector');
  return asRecord(vector.input, vector.id);
}

async function fromSessionInput(
  input: Record<string, unknown>,
): Promise<ReturnType<typeof Principal.fromSession>> {
  const claims = asRecord(input['claims'], 'claims');
  const workspace = asRecord(input['workspace'], 'workspace');
  const identity = asRecord(input['identity'], 'identity');
  return Principal.fromSession(
    await claimsFor(asString(claims['sub'], 'sub'), asString(claims['ws'], 'ws')),
    { id: asString(workspace['id'], 'id'), slug: asString(workspace['slug'], 'slug') },
    asRole(input['role'], 'role'),
    {
      principalId: asString(identity['principalId'], 'principalId'),
      userId: asString(identity['userId'], 'userId'),
      label: asString(identity['label'], 'label'),
    },
  );
}

describe('Principal factories select exactly one workspace', () => {
  it.each(principalVectors.map((v) => [v.id, v] as const))('%s', async (id, vector) => {
    const input = asRecord(vector.input, id);
    const expected = asRecord(vector.expected, id);
    let principal: Principal;
    switch (input['factory']) {
      case 'fromSession': {
        const built = await fromSessionInput(input);
        expect(built.ok).toBe(expected['ok']);
        if (!built.ok) {
          const phrase =
            expected['refusal'] === 'workspace-mismatch'
              ? 'the verified session is for workspace'
              : 'incomplete';
          expect(built.because).toContain(phrase);
          return;
        }
        principal = built.principal;
        break;
      }
      case 'fromApiKey':
        principal = Principal.fromApiKey(apiKeyIdentityOf(input['identity']));
        break;
      case 'fromBrowserToken': {
        let minter: Principal;
        if (input['minter'] === 'session-minter') {
          const built = await fromSessionInput(sessionMinterInput());
          if (!built.ok) throw new Error('the session minter did not build');
          minter = built.principal;
        } else {
          const apiKey = principalVectors.find((v) => v.id === 'from-api-key');
          if (apiKey === undefined) throw new Error('no from-api-key vector');
          minter = Principal.fromApiKey(
            apiKeyIdentityOf(asRecord(apiKey.input, 'input')['identity']),
          );
        }
        const scope = asRecord(input['scope'], 'scope');
        const kind = scope['kind'] === 'run' ? 'run' : 'session';
        principal = Principal.fromBrowserToken(minter, { kind, id: asString(scope['id'], 'id') });
        break;
      }
      default:
        throw new Error(`${id}: unknown factory`);
    }
    expect(principalView(principal)).toEqual(expected['principal']);
    expect(Principal.isPrincipal(principal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// The workspace-route resolvers.

const WS_A = '7a2e98e6-dd85-4fef-a38e-ee176fbdb0ff';
const WS_B = '5b1f0c9e-3a4d-4e2f-9b8a-1c2d3e4f5a6b';

async function accessPrincipal(name: string, actor: string): Promise<Principal> {
  if (name === 'api-key') {
    return Principal.fromApiKey({
      principalId: 'p-key',
      apiKeyId: 'k-1',
      workspaceId: WS_A,
      label: 'CI',
      role: 'admin',
    });
  }
  const role: Role = name === 'owner' || name === 'padded-upper-owner' ? 'owner' : 'viewer';
  const built = Principal.fromSession(
    await claimsFor(actor, 'alpha'),
    { id: WS_A, slug: 'alpha' },
    role,
    {
      principalId: `p-${role}`,
      userId: `u-${role}`,
      label: role,
    },
  );
  if (!built.ok) throw new Error(`could not build the ${name} principal: ${built.because}`);
  return built.principal;
}

function outcomeView(outcome: unknown): Record<string, unknown> {
  const o = asRecord(outcome, 'outcome');
  if (o['kind'] === 'ownership') return { kind: 'ownership', ownership: o['ownership'] };
  const result = asRecord(o['result'], 'result');
  const body = asRecord(result['body'], 'body');
  const error = asRecord(body['error'], 'error');
  return { kind: 'refuse', status: result['status'], code: error['code'] };
}

describe('workspace-route resolvers conceal what the caller does not belong to', () => {
  const directory = createMemoryDirectory({
    users: [
      { id: 'u-owner', email: 'owner@a.test', name: 'Owner', workspaceId: WS_A, role: 'owner' },
      { id: 'u-viewer', email: 'viewer@a.test', name: 'Viewer', workspaceId: WS_A, role: 'viewer' },
    ],
  });
  const repository = createMemoryWorkspaceRepository({
    workspaces: [
      {
        id: WS_A,
        slug: 'alpha',
        name: 'Alpha',
        members: [
          { userId: 'u-owner', role: 'owner' },
          { userId: 'u-viewer', role: 'viewer' },
        ],
      },
      { id: WS_B, slug: 'beta', name: 'Beta', members: [{ userId: 'u-other', role: 'owner' }] },
    ],
  });

  it.each(loadVectors(FAMILY, 'workspace-access.json').map((v) => [v.id, v] as const))(
    '%s',
    async (id, vector) => {
      const input = asRecord(vector.input, id);
      const principal = await accessPrincipal(
        asString(input['principal'], 'principal'),
        asString(input['actor'], 'actor'),
      );
      const target = asString(input['id'], 'id');
      const resolver =
        input['resolver'] === 'owner'
          ? ownerOwnershipResolver(repository, target)
          : memberOwnershipResolver(repository, target);
      const outcome = await resolver(principal, directory.forWorkspace(WS_A));
      expect(outcomeView(outcome)).toEqual(vector.expected);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// requireResourceAccess: the resolver's refusal is returned before decide(), then decide().

describe('requireResourceAccess answers the resolver, then decide()', () => {
  const members = (['owner', 'admin', 'builder', 'viewer'] as const).map((role) => ({
    id: `u-${role}`,
    email: `${role}@t.test`,
    name: role,
    workspaceId: TEST_WORKSPACE_ID,
    role,
  }));
  const repository = createMemoryWorkspaceRepository({
    workspaces: [
      {
        id: WS_A,
        slug: 'alpha',
        name: 'Alpha',
        members: members.map((m) => ({ userId: m.id, role: m.role })),
      },
      { id: WS_B, slug: 'beta', name: 'Beta', members: [{ userId: 'u-other', role: 'owner' }] },
    ],
  });
  let harness: RbacHarness | null = null;
  afterEach(() => {
    harness?.teardown();
    harness = null;
  });

  it.each(loadVectors(FAMILY, 'authorise.json').map((v) => [v.id, v] as const))(
    '%s',
    async (id, vector) => {
      const input = asRecord(vector.input, id);
      const expected = asRecord(vector.expected, id);
      const target = asString(input['id'], 'id');
      const resolver =
        input['resolver'] === 'owner'
          ? ownerOwnershipResolver(repository, target)
          : memberOwnershipResolver(repository, target);
      harness = installRbacHarness(members);
      const response = await harness.call(
        async (request) => {
          const access = await requireResourceAccess(request, resolver);
          return access.ok ? new Response(null, { status: 204 }) : access.response;
        },
        {
          method: asString(input['method'], 'method'),
          path: asString(input['path'], 'path'),
          as: { email: asString(input['email'], 'email') },
        },
      );
      expect(response.status).toBe(expected['status']);
      if (expected['kind'] === 'problem') {
        const body = asRecord(response.body, 'body');
        expect(asRecord(body['error'], 'error')['code']).toBe(expected['code']);
      }
    },
  );
});
