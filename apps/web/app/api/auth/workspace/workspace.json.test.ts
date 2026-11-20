/**
 * The JSON branch of `POST /api/auth/workspace` (issue #236, SDK-04, S-2): same route, same shared
 * logic as `workspace.test.ts`, `Content-Type: application/json` in and `200 { workspace }` +
 * `Set-Cookie` out instead of a `303`. Every failure here is the standard
 * `{ error: { code, message } }` envelope (`detail` a deprecated duplicate), which is also the
 * property that would catch a regression toward the form path's bare codes on this branch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { installTestDomains } from '../../../../server/application-context-fixtures';
import { signInSessionCookieName } from '../../../../server/auth';
import type { WorkspaceRepositoryPort } from '../../../../server/workspaces/wiring';

import { POST } from './route';
import {
  SINGLE_WORKSPACE_SEED,
  U1_EMAIL,
  installDirectory,
  jsonRequest,
  mintSession,
  sessionCookies,
  setCookieValue,
  uninstallDirectory,
} from './workspace.test-support';

const WS_A_RECORD = {
  id: 'ws-a',
  slug: 'acme',
  name: 'Acme',
  publicSharingEnabled: false,
  archivedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function fakeWorkspaceRepository(role: Record<string, string>): WorkspaceRepositoryPort {
  const notImplemented = (): never => {
    throw new Error('not used by these fixtures');
  };
  return {
    listForUser: notImplemented,
    ownerPrincipalId: notImplemented,
    get: (id) => Promise.resolve(id === WS_A_RECORD.id ? { ...WS_A_RECORD } : null),
    getForMember: (id, userId) => {
      const memberRole = role[userId];
      if (id !== WS_A_RECORD.id || memberRole === undefined) return Promise.resolve(null);
      return Promise.resolve({ ...WS_A_RECORD, role: memberRole as never });
    },
    create: notImplemented,
    update: notImplemented,
    archive: notImplemented,
    restore: notImplemented,
  };
}

/** The standard error envelope for `code`. */
function errorEnvelope(code: string): unknown {
  return {
    error: {
      code,
      message: expect.any(String) as unknown,
      detail: expect.any(String) as unknown,
    },
  };
}

describe('POST /api/auth/workspace (application/json)', () => {
  let directory: ReturnType<typeof installDirectory>;

  beforeEach(() => {
    directory = installDirectory(SINGLE_WORKSPACE_SEED);
  });

  afterEach(uninstallDirectory);

  /** Installs a workspace repository where U1 is an admin of `ws-a`. */
  const installWorkspaceRepository = async (): Promise<void> => {
    const u1 = await directory.findUserByEmail(U1_EMAIL);
    if (u1 === null) throw new Error('seed missing u1@example.test');
    installTestDomains({
      workspaces: { repository: fakeWorkspaceRepository({ [u1.id]: 'admin' }) },
    });
  };

  it('answers 200 with the membership view and the new session cookie', async () => {
    await installWorkspaceRepository();
    const response = await POST(
      jsonRequest({
        method: 'POST',
        cookies: sessionCookies(await mintSession()),
        body: { workspace: 'acme' },
      }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      workspace: { id: string; slug: string; role: string };
    };
    expect(body.workspace).toMatchObject({ id: 'ws-a', slug: 'acme', role: 'admin' });
    expect(setCookieValue(response, signInSessionCookieName())).toBeDefined();
  });

  it('answers a workspace the caller does not belong to exactly like one that does not exist', async () => {
    await installWorkspaceRepository();
    const notMine = await POST(
      jsonRequest({
        method: 'POST',
        cookies: sessionCookies(await mintSession()),
        body: { workspace: 'no-such-workspace' },
      }),
    );
    expect(notMine.status).toBe(404);
    expect((await notMine.json()) as unknown).toEqual(errorEnvelope('workspace_not_available'));
    expect(setCookieValue(notMine, signInSessionCookieName())).toBeUndefined();
  });

  it('rejects a malformed body and an unknown field in the standard envelope', async () => {
    const cookies = sessionCookies(await mintSession());
    for (const request_ of [
      jsonRequest({ method: 'POST', cookies, rawBody: '{' }),
      jsonRequest({ method: 'POST', cookies, body: { workspace: 'acme', extra: 1 } }),
      jsonRequest({ method: 'POST', cookies, body: {} }),
    ]) {
      const response = await POST(request_);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('malformed_request');
    }
  });

  it('still refuses cross-origin before anything is minted, in the standard envelope', async () => {
    const response = await POST(
      jsonRequest({
        method: 'POST',
        cookies: sessionCookies(await mintSession()),
        origin: 'https://attacker.example',
        body: { workspace: 'acme' },
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()) as unknown).toEqual(errorEnvelope('cross_origin'));
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
  });

  it('sends an expired session to a 401 in the standard envelope, never a redirect', async () => {
    const response = await POST(jsonRequest({ method: 'POST', body: { workspace: 'acme' } }));
    expect(response.status).toBe(401);
    expect((await response.json()) as unknown).toEqual(errorEnvelope('session_expired'));
  });
});
