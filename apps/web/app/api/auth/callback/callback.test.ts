/**
 * `POST /api/auth/callback` — issue #118's verifier attack #3, plus the refusal paths.
 * The identity → membership branching lives in `callback.membership.test.ts`.
 *
 * `finishOidcLogin` is faked via {@link CallbackDeps} for the reason `route.ts`'s header gives:
 * driving the real `openid-client` exchange needs a live or stubbed issuer (declared gap G-4),
 * and every branch this task actually owns — origin, the transaction cookie, and what happens
 * once an identity comes back or `finishOidcLogin` throws — is real code, not faked.
 */
import { describe, expect, it } from 'vitest';

import {
  oidcTransactionCookieName,
  selectionCookieName,
  signInSessionCookieName,
} from '../../../../server/auth';
import { installTestDomains } from '../../../../server/application-context-fixtures';
import { createMemoryDirectory } from '../../../../server/rbac/memory-directory';

import {
  HOST,
  URL_,
  fakeDeps,
  request,
  setCookieValue,
  stubCallbackEnvironment,
  transactionRequest,
  unsetOidcEnvironment,
  useCallbackEnvironment,
} from './callback.test-support';
import { handleCallback, type CallbackDeps } from './route';

/** Deps whose `finishOidcLogin` records that it was reached. */
function trackedDeps(): { deps: CallbackDeps; wasCalled: () => boolean } {
  let called = false;
  const deps: CallbackDeps = {
    finishOidcLogin: () => {
      called = true;
      return Promise.resolve({ subject: 's', email: 'e@example.test', name: null });
    },
  };
  return { deps, wasCalled: () => called };
}

/** A body the platform cannot read as form data — the `request.formData()` catch arm. */
function malformedBodyRequest(): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: {
      host: HOST,
      origin: `https://${HOST}`,
      cookie: `${oidcTransactionCookieName()}=txn`,
      'content-type': 'application/json',
    },
    body: '{"not":"a form"}',
  });
}

/** Runs the callback with every OIDC variable unset. */
async function callWithoutOidcConfiguration(deps: CallbackDeps): Promise<Response> {
  unsetOidcEnvironment();
  try {
    return await handleCallback(transactionRequest(), deps);
  } finally {
    stubCallbackEnvironment();
  }
}

async function expectRefusal(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ error });
}

describe('POST /api/auth/callback', () => {
  useCallbackEnvironment();

  it('refuses a cross-origin callback before ever calling finishOidcLogin', async () => {
    const { deps, wasCalled } = trackedDeps();
    const response = await handleCallback(
      request({
        cookies: { [oidcTransactionCookieName()]: 'txn' },
        origin: 'https://attacker.example',
      }),
      deps,
    );
    expect(response.status).toBe(403);
    expect(wasCalled()).toBe(false);
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
    expect(setCookieValue(response, selectionCookieName())).toBeUndefined();

    // BREAK-IT CHECK (done by hand while writing this test, reverted before commit): commenting
    // out the `if (!origin.ok)` early return in route.ts makes `called` become `true` and the
    // response a redirect instead of a 403. Restoring the check makes this test pass again.
  });

  it('refuses when the transaction cookie is missing, without calling finishOidcLogin', async () => {
    const { deps, wasCalled } = trackedDeps();
    const response = await handleCallback(request({}), deps);
    expect(response.status).toBe(400);
    expect(wasCalled()).toBe(false);
  });

  it('refuses when finishOidcLogin throws — mismatched state, missing PKCE verifier, or a consumed state all reach this path', async () => {
    for (const reason of ['state does not match', 'no PKCE verifier', 'state already consumed']) {
      const response = await handleCallback(transactionRequest(), fakeDeps(new Error(reason)));
      expect(response.status).toBe(401);
      expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
      expect(setCookieValue(response, selectionCookieName())).toBeUndefined();
    }

    // BREAK-IT CHECK (done by hand, reverted before commit): removing the `try`/`catch` around
    // `deps.finishOidcLogin(...)` (letting the rejection propagate) makes this test fail with an
    // unhandled rejection instead of a clean 401. Restoring the catch makes it pass again.
  });

  it('never answers a Location on any refusal path — a refusal redirects nowhere', async () => {
    const identity = { subject: 'sub-1', email: 'nobody@example.test', name: null };

    const crossOrigin = await handleCallback(
      request({
        cookies: { [oidcTransactionCookieName()]: 'txn' },
        origin: 'https://attacker.example',
      }),
      fakeDeps(identity),
    );
    await expectRefusal(crossOrigin, 403, 'cross_origin');

    // All four together, because a partial set is a misconfiguration `readOidcConfiguration`
    // throws on rather than the "OIDC is simply not enabled here" `null` this arm answers to.
    const notConfigured = await callWithoutOidcConfiguration(fakeDeps(identity));
    await expectRefusal(notConfigured, 503, 'oidc_not_configured');

    const malformed = await handleCallback(malformedBodyRequest(), fakeDeps(identity));
    await expectRefusal(malformed, 400, 'malformed_request');

    const noTransaction = await handleCallback(request({}), fakeDeps(identity));
    await expectRefusal(noTransaction, 400, 'oidc_transaction_missing');

    const rejected = await handleCallback(
      transactionRequest(),
      fakeDeps(new Error('state does not match')),
    );
    await expectRefusal(rejected, 401, 'oidc_callback_rejected');

    // No `installTestDomains({ rbac })` anywhere in this test, so the identity resolves and then
    // finds no runtime — the last refusal before the first redirecting arm. The typed code is asserted on
    // every arm above and here because the statuses collide (503 twice, 400 twice): status alone
    // cannot tell this arm from `oidc_not_configured`, so a later edit that hoisted
    // `installTestDomains({ rbac })` into a shared `beforeEach` would silently make six refusals five.
    const noRuntime = await handleCallback(transactionRequest(), fakeDeps(identity));
    await expectRefusal(noRuntime, 503, 'rbac_runtime_not_configured');

    for (const response of [
      crossOrigin,
      notConfigured,
      malformed,
      noTransaction,
      rejected,
      noRuntime,
    ]) {
      expect(response.headers.get('location'), String(response.status)).toBeNull();
    }
  });

  it('clears the OIDC transaction cookie on every path, including a refusal', async () => {
    installTestDomains({
      rbac: {
        directory: createMemoryDirectory(),
        identify: () => Promise.resolve(null),
      },
    });
    const response = await handleCallback(
      transactionRequest(),
      fakeDeps({ subject: 'sub-1', email: 'nobody@example.test', name: null }),
    );
    expect(setCookieValue(response, oidcTransactionCookieName())).toBe('');
  });
});
