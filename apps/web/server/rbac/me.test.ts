/**
 * The principal serializer behind `GET /api/me` — issue #233.
 *
 * `Principal` carries nine public fields; the wire carries six. The three it does not carry are
 * `actor` (a session email or a machine label), `via` (which verifier produced the value) and
 * `apiKeyId` (`api_keys.id`), and publishing any of them would turn a route every consumer calls
 * first into a credential-adjacent disclosure. A type alone is no evidence about that — a
 * `JSON.stringify` of a spread would satisfy `MePrincipal` structurally while carrying more — so
 * what this file asserts is the **rendered body**: its exact key set, and a scan of its text for
 * every string the fixtures below make findable.
 *
 * Both `Principal` constructors are driven, because the `api_key → api-key` mapping has two arms
 * and a `switch` that got one of them wrong would still type-check.
 */
import { describe, expect, it } from 'vitest';

import {
  mintSessionToken,
  newSessionClaims,
  verifySessionToken,
  type VerifiedSessionClaims,
} from '../auth/session';

import { readMe } from './handlers';
import { Principal } from './principal';

const SECRET = 'a-me-serializer-test-session-secret-long-enough';

/** The session's own workspace, in both spellings `Principal.fromSession` compares. */
const WORKSPACE = { id: 'ws-acme-id', slug: 'acme' } as const;

/**
 * Strings that must never appear in a body. Each is planted in a fixture below, so the scan is
 * looking for something that really is reachable from the `Principal` rather than for a token
 * that could not have been rendered in the first place.
 */
const SESSION_EMAIL = 'member@example.test';
const API_KEY_ID = 'ac6cbf4f-9b2e-4a14-9b6a-6a0cf1aa4f39';

/** Mint and verify, which is the only way to obtain `VerifiedSessionClaims`. */
async function claimsFor(email: string, slug: string): Promise<VerifiedSessionClaims> {
  const token = await mintSessionToken(newSessionClaims(email, slug), SECRET);
  const verified = await verifySessionToken(token, SECRET);
  if (!verified.ok)
    throw new Error(`the fixture could not verify its own token: ${verified.reason}`);
  return verified.claims;
}

async function sessionPrincipal(): Promise<Principal> {
  const claims = await claimsFor(SESSION_EMAIL, WORKSPACE.slug);
  const built = Principal.fromSession(claims, WORKSPACE, 'admin', {
    principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
    userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
    label: 'Workspace Member',
  });
  if (!built.ok) throw new Error(`the fixture built no principal: ${built.because}`);
  return built.principal;
}

function apiKeyPrincipal(): Principal {
  return Principal.fromApiKey({
    principalId: '2e6d9d0f-55f1-4d9f-9a2a-13a4a0f2b0a1',
    apiKeyId: API_KEY_ID,
    workspaceId: WORKSPACE.id,
    role: 'builder',
    label: 'ci',
  });
}

/** The six fields the contract publishes, in the order `docs/sdk/04-api-specification.md` §5.2 prints them. */
const WIRE_FIELDS = ['principalId', 'kind', 'role', 'workspaceId', 'userId', 'label'];

describe('readMe renders exactly the six fields the contract publishes', () => {
  it('renders a session principal, naming its user and a human label', async () => {
    const result = readMe(await sessionPrincipal());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      kind: 'membership',
      role: 'admin',
      workspaceId: WORKSPACE.id,
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      label: 'Workspace Member',
    });
  });

  it('renders an API-key principal with a null userId and the kebab-cased kind', () => {
    const result = readMe(apiKeyPrincipal());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      principalId: '2e6d9d0f-55f1-4d9f-9a2a-13a4a0f2b0a1',
      // Not the stored `api_key`: `workspace_principals.kind` keeps that spelling under a CHECK
      // constraint and the wire is kebab-case, so this is the mapping's second arm.
      kind: 'api-key',
      role: 'builder',
      workspaceId: WORKSPACE.id,
      userId: null,
      label: 'ci',
    });
  });

  it('publishes that key set and no other, for either kind', async () => {
    for (const principal of [await sessionPrincipal(), apiKeyPrincipal()]) {
      const body = readMe(principal).body as Record<string, unknown>;
      expect(Object.keys(body), `${principal.kind} rendered a different key set`).toEqual(
        WIRE_FIELDS,
      );
      // Derived from the `Principal` itself, not transcribed: every public field it carries that
      // the wire does not is named here by subtraction, so a field added to `Principal` and
      // rendered by accident lands in this list rather than passing unnoticed.
      const withheld = Object.keys(principal).filter((field) => !WIRE_FIELDS.includes(field));
      // `scope` (issue #236, SDK-04, S-1): a browser token's attenuation is an authorisation input
      // decide() consumes, never a fact `GET /api/me` discloses about how the caller authenticated.
      // `ownerPrincipalId` (issue #509, S1-24): the owner of what the caller writes; `/api/me`
      // reports the principal that acted.
      // `oauth` (issue #971): the client and audience of an OAuth access token, an input to the
      // endpoint handlers and never a fact `GET /api/me` discloses.
      expect(withheld.sort()).toEqual([
        'actor',
        'apiKeyId',
        'oauth',
        'ownerPrincipalId',
        'scope',
        'via',
      ]);
      expect(withheld.filter((field) => field in body)).toEqual([]);
    }
  });

  it('leaves no credential-adjacent text in the rendered JSON', async () => {
    for (const principal of [await sessionPrincipal(), apiKeyPrincipal()]) {
      const rendered = JSON.stringify(readMe(principal).body);
      for (const forbidden of [API_KEY_ID, SESSION_EMAIL, 'session', 'api_key', 'ak_live_']) {
        expect(rendered, `${forbidden} reached the body`).not.toContain(forbidden);
      }
    }
  });
});
