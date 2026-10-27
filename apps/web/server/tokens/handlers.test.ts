/**
 * `POST /api/tokens` (issue #236, SDK-04, S-1) — driven with real `Request` objects through the
 * real route file, over `installRbacHarness`'s in-memory directory, exactly like every other
 * route's test in this program.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { POST } from '../../app/api/tokens/route';
import {
  BROWSER_TOKEN_PATTERN,
  BROWSER_TOKEN_DEFAULT_TTL_SECONDS,
} from '@indx-workspace/contracts/tokens';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from '../rbac/testing';
import type { TokensRuntime } from './runtime';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

interface TargetRow {
  readonly kind: 'run' | 'session';
  readonly ownerPrincipalId: string;
}

function fakeTokensRuntime(targets: ReadonlyMap<string, TargetRow>): TokensRuntime & {
  readonly issued: { readonly principalId: string; readonly scope: unknown }[];
} {
  const issued: { readonly principalId: string; readonly scope: unknown }[] = [];
  return {
    issued,
    findTarget(_principal, scope) {
      const row = targets.get(scope.id);
      return Promise.resolve(
        row === undefined || row.kind !== scope.kind
          ? { kind: 'not-found' }
          : { kind: 'found', ownerPrincipalId: row.ownerPrincipalId },
      );
    },
    issue(principal, scope) {
      const row = targets.get(scope.id);
      if (row === undefined || row.kind !== scope.kind) return Promise.resolve(null);
      issued.push({ principalId: principal.principalId, scope });
      return Promise.resolve({
        token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
        expiresAt: new Date(),
      });
    },
  };
}

let harness: RbacHarness | undefined;

afterEach(() => {
  harness?.teardown();
  harness = undefined;
  clearApplicationContext();
});

describe('POST /api/tokens', () => {
  // With no context installed the RBAC gate, which lives in the same context, answers first.
  it.each([
    [
      'disabled (no run runtime wired)',
      () => installTestDomains({ tokens: { kind: 'disabled' } }),
      'tokens_runtime_not_configured',
    ],
    [
      'absent (no context installed)',
      () => clearApplicationContext(),
      'rbac_runtime_not_configured',
    ],
  ])('answers 503 while the runtime is %s', async (_, wire, code) => {
    harness = installRbacHarness([
      { email: 'owner@example.test', name: 'Owner', workspaceId: TEST_WORKSPACE_ID, role: 'owner' },
    ]);
    wire();
    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'owner@example.test' },
      body: { scope: { kind: 'run', id: RUN_ID } },
    });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code } });
  });

  it('mints a token for a run the caller owns, and the plaintext matches the wire pattern', async () => {
    const OWNER_PRINCIPAL = 'principal-owner';
    harness = installRbacHarness([
      {
        email: 'owner@example.test',
        name: 'Owner',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
        principalId: OWNER_PRINCIPAL,
      },
    ]);
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: fakeTokensRuntime(
          new Map([[RUN_ID, { kind: 'run', ownerPrincipalId: OWNER_PRINCIPAL }]]),
        ),
      },
    });

    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'owner@example.test' },
      body: { scope: { kind: 'run', id: RUN_ID } },
    });

    expect(response.status).toBe(201);
    const body = response.body as {
      token: string;
      scope: unknown;
      expiresAt: string;
      warning: string;
    };
    expect(BROWSER_TOKEN_PATTERN.test(body.token)).toBe(true);
    expect(body.scope).toEqual({ kind: 'run', id: RUN_ID });
    expect(body.warning.length).toBeGreaterThan(0);
  });

  it('refuses a Viewer outright', async () => {
    const VIEWER_PRINCIPAL = 'principal-viewer';
    harness = installRbacHarness([
      {
        email: 'viewer@example.test',
        name: 'Viewer',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'viewer',
        principalId: VIEWER_PRINCIPAL,
      },
    ]);
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: fakeTokensRuntime(
          new Map([[RUN_ID, { kind: 'run', ownerPrincipalId: VIEWER_PRINCIPAL }]]),
        ),
      },
    });

    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'viewer@example.test' },
      body: { scope: { kind: 'run', id: RUN_ID } },
    });

    expect(response.status).toBe(403);
  });

  it('confines a Builder to rows it owns: another member’s run answers 403, not 404', async () => {
    const BUILDER_PRINCIPAL = 'principal-builder';
    const OTHER_PRINCIPAL = 'principal-other';
    harness = installRbacHarness([
      {
        email: 'builder@example.test',
        name: 'Builder',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'builder',
        principalId: BUILDER_PRINCIPAL,
      },
    ]);
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: fakeTokensRuntime(
          new Map([
            [RUN_ID, { kind: 'run', ownerPrincipalId: BUILDER_PRINCIPAL }],
            [OTHER_RUN_ID, { kind: 'run', ownerPrincipalId: OTHER_PRINCIPAL }],
          ]),
        ),
      },
    });

    const own = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'builder@example.test' },
      body: { scope: { kind: 'run', id: RUN_ID } },
    });
    expect(own.status).toBe(201);

    const other = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'builder@example.test' },
      body: { scope: { kind: 'run', id: OTHER_RUN_ID } },
    });
    expect(other.status).toBe(403);
  });

  it('answers a foreign or malformed target exactly like a nonexistent one', async () => {
    const OWNER_PRINCIPAL = 'principal-owner';
    harness = installRbacHarness([
      {
        email: 'owner@example.test',
        name: 'Owner',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
        principalId: OWNER_PRINCIPAL,
      },
    ]);
    installTestDomains({ tokens: { kind: 'serving', runtime: fakeTokensRuntime(new Map()) } });

    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'owner@example.test' },
      body: { scope: { kind: 'run', id: RUN_ID } },
    });
    expect(response.status).toBe(404);
  });

  it('refuses a non-UUID scope.id without ever reaching the store', async () => {
    const OWNER_PRINCIPAL = 'principal-owner';
    harness = installRbacHarness([
      {
        email: 'owner@example.test',
        name: 'Owner',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
        principalId: OWNER_PRINCIPAL,
      },
    ]);
    // Stands in for the production runtime's reads: `runs.id` and `sessions.id` are `uuid`
    // columns, so a malformed id raised `22P02` and surfaced as a 500. Both the wire schema and
    // `ownershipOfScope`'s guard now stop it before this runtime is consulted at all.
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: {
          findTarget() {
            throw new Error('22P02 invalid input syntax for type uuid');
          },
          issue() {
            throw new Error('22P02 invalid input syntax for type uuid');
          },
        },
      },
    });

    for (const id of ['not-a-uuid', '']) {
      const response = await harness.call(POST, {
        method: 'POST',
        path: '/api/tokens',
        as: { email: 'owner@example.test' },
        body: { scope: { kind: 'run', id } },
      });
      expect(response.status, id).toBe(400);
    }
  });

  it('rejects an unknown field, a missing scope, and an out-of-bounds ttlSeconds', async () => {
    const OWNER_PRINCIPAL = 'principal-owner';
    harness = installRbacHarness([
      {
        email: 'owner@example.test',
        name: 'Owner',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
        principalId: OWNER_PRINCIPAL,
      },
    ]);
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: fakeTokensRuntime(
          new Map([[RUN_ID, { kind: 'run', ownerPrincipalId: OWNER_PRINCIPAL }]]),
        ),
      },
    });

    for (const body of [
      { scope: { kind: 'run', id: RUN_ID }, extra: 1 },
      {},
      { scope: { kind: 'run', id: RUN_ID }, ttlSeconds: 1 },
      { scope: { kind: 'run', id: RUN_ID }, ttlSeconds: 999_999 },
    ]) {
      const response = await harness.call(POST, {
        method: 'POST',
        path: '/api/tokens',
        as: { email: 'owner@example.test' },
        body,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('mints a session-scoped token with the default TTL honoured by the runtime', async () => {
    const OWNER_PRINCIPAL = 'principal-owner';
    harness = installRbacHarness([
      {
        email: 'owner@example.test',
        name: 'Owner',
        workspaceId: TEST_WORKSPACE_ID,
        role: 'owner',
        principalId: OWNER_PRINCIPAL,
      },
    ]);
    let capturedTtl: number | null = null;
    installTestDomains({
      tokens: {
        kind: 'serving',
        runtime: {
          findTarget() {
            return Promise.resolve({ kind: 'found', ownerPrincipalId: OWNER_PRINCIPAL });
          },
          issue(_principal, _scope, ttlSeconds) {
            capturedTtl = ttlSeconds;
            return Promise.resolve({
              token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
              expiresAt: new Date(),
            });
          },
        },
      },
    });

    const response = await harness.call(POST, {
      method: 'POST',
      path: '/api/tokens',
      as: { email: 'owner@example.test' },
      body: { scope: { kind: 'session', id: SESSION_ID } },
    });
    expect(response.status).toBe(201);
    expect(capturedTtl).toBe(BROWSER_TOKEN_DEFAULT_TTL_SECONDS);
  });
});
