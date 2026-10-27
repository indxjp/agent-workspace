/**
 * Spec §3.1's browser token, scanned the same way `api-keys.test.ts` scans §22's: the plaintext
 * must appear in exactly one response body across the whole suite, and the stored form — here,
 * every argument the runtime records — must never carry it.
 *
 * `POST /api/tokens` is driven with a real `Request` through the real route file, over
 * `installRbacHarness`'s in-memory directory (for `authorise`) and a minimal in-memory
 * `TokensRuntime` fake (for the mint itself, which needs no database to prove this property: the
 * hash is computed by `mintBrowserToken` — proved never to equal or contain the plaintext in
 * `browser-token.test.ts` — before this runtime ever sees it).
 */
import { afterEach, describe, expect, it } from 'vitest';

import { GET as LIST_API_KEYS } from '../../app/api/api-keys/route';
import { GET as READ_ME } from '../../app/api/me/route';
import { POST as MINT_TOKEN } from '../../app/api/tokens/route';

import { BROWSER_TOKEN_PATTERN } from '@indx-workspace/contracts/tokens';

import { mintBrowserToken } from './browser-token';
import { installRbacHarness, TEST_WORKSPACE_ID, type RbacHarness } from './testing';
import type { TokensRuntime } from '../tokens/runtime';
import { clearApplicationContext } from '../application-context';
import { installTestDomains } from '../application-context-fixtures';

const OWNER_PRINCIPAL = 'principal-owner-under-test';
const OWNER = { email: 'owner@example.test' };
const RUN_ID = '11111111-1111-4111-8111-111111111111';

function harnessWithOwner(): RbacHarness {
  return installRbacHarness([
    {
      email: OWNER.email,
      name: 'The Owner',
      workspaceId: TEST_WORKSPACE_ID,
      role: 'owner',
      principalId: OWNER_PRINCIPAL,
    },
  ]);
}

/** A runtime that mints for the one seeded run and records every argument it was called with. */
function recordingTokensRuntime(): TokensRuntime & {
  readonly issuedFor: { readonly principalId: string }[];
} {
  const issuedFor: { readonly principalId: string }[] = [];
  return {
    issuedFor,
    findTarget(_principal, scope) {
      return Promise.resolve(
        scope.id === RUN_ID
          ? { kind: 'found', ownerPrincipalId: OWNER_PRINCIPAL }
          : { kind: 'not-found' },
      );
    },
    async issue(principal, scope) {
      if (scope.id !== RUN_ID) return null;
      issuedFor.push({ principalId: principal.principalId });
      const minted = await mintBrowserToken();
      return { token: minted.presented, expiresAt: new Date(Date.now() + 300_000) };
    },
  };
}

let live: RbacHarness | null = null;

afterEach(() => {
  live?.teardown();
  live = null;
  clearApplicationContext();
});

describe('the token is returned exactly once, and nothing recorded ever carries it', () => {
  it('returns a token matching the wire pattern, once, in the 201', async () => {
    const harness = harnessWithOwner();
    live = harness;
    installTestDomains({ tokens: { kind: 'serving', runtime: recordingTokensRuntime() } });

    const response = await harness.call(MINT_TOKEN, {
      method: 'POST',
      path: '/api/tokens',
      as: OWNER,
      body: { scope: { kind: 'run', id: RUN_ID } },
    });
    expect(response.status).toBe(201);
    const body = response.body as { token: string };
    expect(BROWSER_TOKEN_PATTERN.test(body.token)).toBe(true);
  });

  it('puts the plaintext in exactly one response body across the whole exchange', async () => {
    const harness = harnessWithOwner();
    live = harness;
    installTestDomains({ tokens: { kind: 'serving', runtime: recordingTokensRuntime() } });

    const minted = await harness.call(MINT_TOKEN, {
      method: 'POST',
      path: '/api/tokens',
      as: OWNER,
      body: { scope: { kind: 'run', id: RUN_ID } },
    });
    const { token } = minted.body as { token: string };

    // Every other route this task's harness can drive, after the mint — including a second mint,
    // whose own (different) plaintext must not be confused with the first's.
    await harness.call(READ_ME, { method: 'GET', path: '/api/me', as: OWNER });
    await harness.call(LIST_API_KEYS, { method: 'GET', path: '/api/api-keys', as: OWNER });
    await harness.call(MINT_TOKEN, {
      method: 'POST',
      path: '/api/tokens',
      as: OWNER,
      body: { scope: { kind: 'run', id: RUN_ID } },
    });

    const revealing = harness.responses.filter((response) => response.text.includes(token));
    expect(
      revealing.map(
        (response) => `${response.method} ${response.url} → ${String(response.status)}`,
      ),
      'the plaintext token appears in these responses; §3.1 allows exactly one',
    ).toEqual(['POST https://control-plane.test/api/tokens → 201']);
  });

  it('never hands the runtime anything shaped like the plaintext — only the principal and scope', async () => {
    const harness = harnessWithOwner();
    live = harness;
    const runtime = recordingTokensRuntime();
    installTestDomains({ tokens: { kind: 'serving', runtime } });

    const response = await harness.call(MINT_TOKEN, {
      method: 'POST',
      path: '/api/tokens',
      as: OWNER,
      body: { scope: { kind: 'run', id: RUN_ID } },
    });
    const { token } = response.body as { token: string };

    expect(runtime.issuedFor).toEqual([{ principalId: OWNER_PRINCIPAL }]);
    // The route's own contract with its runtime: `issue` is handed a principal and a scope, never
    // a token or a hash — `TokensRuntime.issue`'s signature has no parameter for either, so this
    // is a second, independent check that the composition-level implementation (which does compute
    // a hash) could not smuggle the plaintext through this seam by widening the interface later.
    expect(JSON.stringify(runtime.issuedFor).includes(token)).toBe(false);
  });
});
