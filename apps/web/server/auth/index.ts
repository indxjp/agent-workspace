/**
 * `@/server/auth` — everything a route handler or a server component needs.
 *
 * Route handlers import from here, not from the modules underneath. Two rules follow from that
 * and both matter:
 *
 *   * **The middleware is a gate, not an authentication source.** It answers 401 before an
 *     unauthenticated request reaches a handler, but it does not hand the handler an identity —
 *     no `x-user` header, no forwarded claim. A handler that needs to know who is calling calls
 *     `requireSession()` and verifies the cookie itself. One source of truth, and no header that
 *     becomes a forgery vector the day something reaches the app without passing the middleware.
 *   * **The tenant comes from the session.** `WorkspaceScope` is a class with private fields, so
 *     it cannot be written as an object literal, cannot be constructed outside `workspace.ts`,
 *     and cannot be spread with its tenant replaced: writing a scope out of a request body, a
 *     query string or a path segment does not compile, and `tests/auth.test.ts` runs `tsc` over
 *     each of those forgeries to prove it. What does *not* fail to compile is
 *     `Object.assign(scope, { workspaceSlug: … })` — `readonly` is erased and `Object.assign`
 *     consults no modifier — so the scope is also frozen at construction and that line throws
 *     `TypeError` instead. Two named escapes remain and both are declared, in
 *     ./workspace.ts and in this task's PR. Every query in a handler is expected to filter on
 *     the scope (spec §25) — that second half is a contract, not a gate, and is declared unbuilt.
 *
 * This is the one file in the directory that imports its siblings, and it is also the one file
 * that only Next.js ever loads — `next/headers` exists in no other context. The siblings import
 * nothing from each other for the reason recorded in
 * docs/adr/W1-CP-06-auth-modules-are-standalone-es-modules.md.
 */
import { cookies } from 'next/headers';

import {
  INVITATION_IDENTITY_COOKIE_BASE_NAME,
  INVITATION_IDENTITY_TTL_SECONDS,
  invitationIdentityCookie as baseInvitationIdentityCookie,
  type InvitationIdentityCookie,
} from './invitation-identity';
import { OIDC_TRANSACTION_COOKIE_BASE_NAME } from './oidc';
import {
  SELECTION_COOKIE_BASE_NAME,
  SELECTION_TTL_SECONDS,
  selectionCookie as baseSelectionCookie,
  type SelectionCookie,
} from './selection';
import {
  installedAuthSettings,
  installedOidcConfiguration,
  installedScopedCookieName,
  installedSessionCookieName,
  installedSessionSecret,
} from '../auth-settings';
import {
  clearedSessionCookie as baseClearedSessionCookie,
  sessionCookie as baseSessionCookie,
  signInWith,
  verifySessionToken,
  type SessionCookie,
  type SignInInput,
  type SignInResult,
  type VerifiedSessionClaims,
} from './session';
import { workspaceScopeFrom, WorkspaceScope } from './workspace';

export {
  DEFAULT_SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  MIN_SESSION_SECRET_LENGTH,
  MIN_BOOTSTRAP_PASSWORD_LENGTH,
  mintSessionToken,
  newSessionClaims,
  readSessionSecret,
  readBootstrapAdmin,
  verifySessionToken,
} from './session';
export type {
  SessionClaims,
  VerifiedSessionClaims,
  SessionCookie,
  VerifyFailure,
  VerifyResult,
  BootstrapAdmin,
  SignInInput,
  SignInResult,
  SignInFailure,
} from './session';
export { classifyPath, enforcementFor } from './paths';
export type { Surface, Enforcement, PathVerdict } from './paths';
export { checkRequestOrigin } from './origin';
export { safeNextPath } from './next-path';
export { workspaceScopeFrom, WorkspaceScope };
export { SELECTION_TTL_SECONDS, mintSelectionToken, verifySelectionToken } from './selection';
export type { SelectionClaims, SelectionCookie, SelectionVerifyResult } from './selection';
export {
  INVITATION_IDENTITY_TTL_SECONDS,
  mintInvitationIdentityToken,
  verifyInvitationIdentityToken,
} from './invitation-identity';
export type {
  InvitationIdentityClaims,
  InvitationIdentityCookie,
  InvitationIdentityVerifyResult,
} from './invitation-identity';
export { readOidcConfiguration, beginOidcLogin, finishOidcLogin } from './oidc';

/*
 * The other auth cookies, scoped per deployment exactly as the session cookie is (issue #394):
 * two projects on one host would otherwise overwrite each other's workspace selection, invitation
 * identity or OIDC transaction. Their own modules import nothing (W1-CP-06), so this composition
 * root applies `scopedCookieName` to each base name, and every route reads and writes these.
 */

/** The workspace-selection cookie's name for this deployment. */
/** The session cookie's name for this deployment, from the settings installed at start-up. */
export const sessionCookieName = installedSessionCookieName;

/** The deployment's session secret, parsed once at start-up, or why there is none. */
export const sessionSecret = installedSessionSecret;

/** The OIDC client parsed at start-up, or `null`; a partial client throws when used. */
export const oidcConfiguration = installedOidcConfiguration;

/** Sign in against the settings installed at start-up. */
export function signIn(input: SignInInput, nowMs?: number): Promise<SignInResult> {
  const settings = installedAuthSettings();
  return signInWith(
    input,
    {
      secret: settings.sessionSecret,
      admin: settings.bootstrapAdmin,
      cookieName: installedSessionCookieName(),
    },
    nowMs,
  );
}

/** The session cookie carrying `token`, under this deployment's name. */
export function sessionCookie(token: string, maxAgeSeconds?: number): SessionCookie {
  return baseSessionCookie(token, installedSessionCookieName(), maxAgeSeconds);
}

/** The session cookie with an immediate expiry: sign-out. */
export function clearedSessionCookie(): SessionCookie {
  return baseClearedSessionCookie(installedSessionCookieName());
}

export function selectionCookieName(): string {
  return installedScopedCookieName(SELECTION_COOKIE_BASE_NAME);
}

/** The invitation-identity cookie's name for this deployment. */
export function invitationIdentityCookieName(): string {
  return installedScopedCookieName(INVITATION_IDENTITY_COOKIE_BASE_NAME);
}

/** The OIDC transaction cookie's name for this deployment. */
export function oidcTransactionCookieName(): string {
  return installedScopedCookieName(OIDC_TRANSACTION_COOKIE_BASE_NAME);
}

export function selectionCookie(
  token: string,
  maxAgeSeconds: number = SELECTION_TTL_SECONDS,
): SelectionCookie {
  return { ...baseSelectionCookie(token, maxAgeSeconds), name: selectionCookieName() };
}

/** The same cookie with an immediate expiry — clears the selection once it has been used. */
export function clearedSelectionCookie(): SelectionCookie {
  return { ...selectionCookie(''), maxAge: 0 };
}

export function invitationIdentityCookie(
  token: string,
  maxAgeSeconds: number = INVITATION_IDENTITY_TTL_SECONDS,
): InvitationIdentityCookie {
  return {
    ...baseInvitationIdentityCookie(token, maxAgeSeconds),
    name: invitationIdentityCookieName(),
  };
}

export function clearedInvitationIdentityCookie(): InvitationIdentityCookie {
  return { ...invitationIdentityCookie(''), maxAge: 0 };
}

/**
 * Thrown by `requireSession()`. A route handler that lets it escape produces a 500 rather than a
 * 401, which is why the middleware answers 401 first: this is the second lock, not the first.
 */
export class UnauthenticatedError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
    this.code = code;
  }
}

/** The signed-in identity, or `null`. Never throws for an absent or invalid session. */
export async function getSession(): Promise<VerifiedSessionClaims | null> {
  const secret = installedSessionSecret();
  if (!secret.ok) {
    return null;
  }
  const store = await cookies();
  const result = await verifySessionToken(
    store.get(installedSessionCookieName())?.value,
    secret.secret,
  );
  return result.ok ? result.claims : null;
}

/** The signed-in identity, or throw. */
export async function requireSession(): Promise<VerifiedSessionClaims> {
  const claims = await getSession();
  if (claims === null) {
    throw new UnauthenticatedError('unauthenticated', 'this request carries no valid session');
  }
  return claims;
}

/**
 * The tenant this request may touch. Derived from the session and from nothing else — and
 * "nothing else" is now checked by the compiler rather than asserted in a comment. See
 * ./workspace.ts for what the nominal type does and does not promise.
 */
export async function requireWorkspaceScope(): Promise<WorkspaceScope> {
  return workspaceScopeFrom(await requireSession());
}
