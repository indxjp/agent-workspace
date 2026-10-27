import { describe, expect, it } from 'vitest';

import { createClient } from '@indx-workspace/sdk';
import { fetchDouble, jsonResponse } from '@indx-workspace/sdk/testing';

import {
  recoverWorkspaceSession,
  shouldRecoverFromWorkspaceListProblem,
  shouldRecoverSession,
} from './session-recovery';
import { loadWorkspaces } from './workspaces-requests-model';

describe('shouldRecoverSession', () => {
  it('recovers when a configured runtime cannot resolve the session’s identity — a vanished membership', () => {
    expect(
      shouldRecoverSession({ hasSession: true, identityResolved: false, runtimeConfigured: true }),
    ).toBe(true);
  });

  it('does not recover an unauthenticated request — nothing to recover from', () => {
    expect(
      shouldRecoverSession({ hasSession: false, identityResolved: false, runtimeConfigured: true }),
    ).toBe(false);
  });

  it('does not recover once identity resolved — the ordinary, healthy case', () => {
    expect(
      shouldRecoverSession({ hasSession: true, identityResolved: true, runtimeConfigured: true }),
    ).toBe(false);
  });

  it('does not recover when the RBAC runtime itself is unwired — a different, already-declared gap', () => {
    expect(
      shouldRecoverSession({ hasSession: true, identityResolved: false, runtimeConfigured: false }),
    ).toBe(false);
  });

  // BREAK-IT CHECK (done by hand, reverted before commit): dropping the `runtimeConfigured` guard
  // (returning `true` whenever `hasSession && !identityResolved`) makes the third case above still
  // pass but turns every shell page load into a redirect loop the moment the RBAC runtime is
  // unwired — exactly the regression this function exists to prevent — which the fourth test here
  // catches (`toBe(false)` where the unguarded version answers `true`). Restoring the
  // `runtimeConfigured` check fixes it.
});

describe('shouldRecoverFromWorkspaceListProblem', () => {
  it('recovers from a missing session and the vanished-membership race outcome', () => {
    expect(
      shouldRecoverFromWorkspaceListProblem({
        kind: 'api',
        status: 401,
        code: 'unauthorised',
        detail: 'Sign in.',
      }),
    ).toBe(true);
    expect(
      shouldRecoverFromWorkspaceListProblem({
        kind: 'api',
        status: 500,
        code: 'authorisation_undecidable',
        detail: 'The caller identity could not be resolved.',
      }),
    ).toBe(true);
  });

  it('leaves unrelated server and transport failures visible in place', () => {
    expect(
      shouldRecoverFromWorkspaceListProblem({
        kind: 'api',
        status: 500,
        code: 'internal_error',
        detail: 'Try again later.',
      }),
    ).toBe(false);
    expect(
      shouldRecoverFromWorkspaceListProblem({ kind: 'transport', reason: 'network down' }),
    ).toBe(false);
  });
});

describe('recoverWorkspaceSession', () => {
  it.each([
    { status: 401, code: 'unauthorised' },
    { status: 500, code: 'authorisation_undecidable' },
  ])('clears and conceals tenant UI before navigating for $status $code', ({ status, code }) => {
    const observed: string[] = [];
    const recovered = recoverWorkspaceSession(
      { kind: 'api', status, code, detail: 'Session no longer resolves.' },
      {
        clearTenantState: () => observed.push('clear'),
        concealTenantDocument: () => observed.push('conceal'),
        navigate: (path) => observed.push(`navigate:${path}`),
      },
    );

    expect(recovered).toBe(true);
    expect(observed).toEqual(['clear', 'conceal', 'navigate:/signin?error=session_expired']);
  });

  it('recovers from a 401 the server renders with problem() — the standard envelope end to end', async () => {
    const client = createClient({
      baseUrl: 'https://aw.example.com',
      auth: { kind: 'session' },
      fetch: fetchDouble(() =>
        jsonResponse(401, { error: { code: 'unauthorised', message: 'Sign in again.' } }),
      ).fetch,
    });
    const result = await loadWorkspaces(client);
    if (result.ok) throw new Error('expected a refusal');
    const read = result.problem;
    const observed: string[] = [];
    const recovered = recoverWorkspaceSession(read, {
      clearTenantState: () => observed.push('clear'),
      concealTenantDocument: () => observed.push('conceal'),
      navigate: (path) => observed.push(`navigate:${path}`),
    });

    expect(read.kind).toBe('api');
    expect(recovered).toBe(true);
    expect(observed).toEqual(['clear', 'conceal', 'navigate:/signin?error=session_expired']);
  });

  it('does not clear, conceal or navigate for an ordinary authorisation refusal', () => {
    const observed: string[] = [];
    const recovered = recoverWorkspaceSession(
      { kind: 'api', status: 403, code: 'forbidden', detail: 'Not permitted.' },
      {
        clearTenantState: () => observed.push('clear'),
        concealTenantDocument: () => observed.push('conceal'),
        navigate: (path) => observed.push(`navigate:${path}`),
      },
    );

    expect(recovered).toBe(false);
    expect(observed).toEqual([]);
  });
});
