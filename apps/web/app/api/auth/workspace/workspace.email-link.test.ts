/**
 * `POST /api/auth/workspace` for a session the email-link sign-in minted: the mark on the session
 * confines it to its own demo workspace, even when the same address later joined a real one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  mintSignInSessionToken,
  newEmailLinkSignInSessionClaims,
  newSignInSessionClaims,
  signInSessionCookieName,
  verifySignInSessionToken,
} from '../../../../server/auth';

import { POST } from './route';
import {
  SECRET,
  installDirectory,
  jsonRequest,
  request,
  sessionCookies,
  setCookieValue,
  uninstallDirectory,
  viewer,
} from './workspace.test-support';

const GUEST = 'guest@example.test';
const NOT_AVAILABLE_LOCATION = '/api/auth/workspace?error=workspace_not_available';

describe('POST /api/auth/workspace for a session the email-link sign-in minted', () => {
  beforeEach(async () => {
    const directory = installDirectory({
      workspaces: [
        { id: 'ws-demo', slug: 'demo-1', name: 'Demo' },
        { id: 'ws-real', slug: 'acme', name: 'Acme' },
      ],
      users: [{ email: GUEST, name: 'Guest', workspaceId: 'ws-demo', role: 'guest' }],
    });
    // The same address joins a real workspace through the identity provider after the link was
    // opened: the case the mark exists for.
    await directory.forWorkspace('ws-real').createMembership({ email: GUEST, role: viewer });
  });

  afterEach(uninstallDirectory);

  const marked = () =>
    mintSignInSessionToken(newEmailLinkSignInSessionClaims(GUEST, 'demo-1'), SECRET);
  const unmarked = () => mintSignInSessionToken(newSignInSessionClaims(GUEST, 'demo-1'), SECRET);
  const switchTo = async (session: string, workspace: string, json = false) =>
    POST(
      json
        ? jsonRequest({ method: 'POST', cookies: sessionCookies(session), body: { workspace } })
        : request({ method: 'POST', cookies: sessionCookies(session), form: { workspace } }),
    );

  /** The signed-in session token set on `response`, verified. */
  const verifiedSessionOf = async (response: Response) => {
    const token = setCookieValue(response, signInSessionCookieName());
    return verifySignInSessionToken(decodeURIComponent(token ?? ''), SECRET);
  };

  it.each(['acme', 'ws-real'])(
    'refuses a switch to the real workspace %s the address joined, and sets no cookie (form)',
    async (workspace) => {
      const response = await switchTo(await marked(), workspace);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(NOT_AVAILABLE_LOCATION);
      expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
    },
  );

  it('refuses the same switch in the JSON branch with 404 workspace_not_available and no cookie', async () => {
    const response = await switchTo(await marked(), 'acme', true);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'workspace_not_available' } });
    expect(setCookieValue(response, signInSessionCookieName())).toBeUndefined();
  });

  it('answers a refused real workspace exactly as it answers one that does not exist', async () => {
    const real = await switchTo(await marked(), 'acme');
    const missing = await switchTo(await marked(), 'no-such-workspace');
    expect(real.status).toBe(missing.status);
    expect(real.headers.get('location')).toBe(missing.headers.get('location'));
  });

  it('allows a switch to its own demo workspace and the new session is still marked', async () => {
    const response = await switchTo(await marked(), 'demo-1');
    expect(response.status).toBe(303);
    expect(setCookieValue(response, signInSessionCookieName())).toBeDefined();
    const verified = await verifiedSessionOf(response);
    expect(verified.ok && verified.claims.via).toBe('email_link');
    expect(verified.ok && verified.claims.ws).toBe('demo-1');
  });

  it('leaves an unmarked session free to switch to a workspace it belongs to, and mints it unmarked', async () => {
    const response = await switchTo(await unmarked(), 'acme');
    expect(response.status).toBe(303);
    const verified = await verifiedSessionOf(response);
    expect(verified.ok && verified.claims.ws).toBe('acme');
    expect(verified.ok && 'via' in verified.claims).toBe(false);
  });
});
