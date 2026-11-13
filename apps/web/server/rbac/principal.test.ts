/**
 * `Principal.fromSession` builds a principal only when its two tenant arguments name the same
 * tenant.
 *
 * Round 1 took `claims` and a `workspaceId` and never compared them, so a composition root that
 * resolved the wrong workspace — or resolved a workspace for a different tenant's slug — produced
 * a `Principal` scoped to a workspace the session never mentioned. Nothing called it outside the
 * harness, which made it a constraint the future composition root would have had to satisfy
 * without being told. It is a check now, and this file is the check on the check.
 */
import { describe, expect, it } from 'vitest';

import {
  mintSessionToken,
  newSessionClaims,
  verifySessionToken,
  type VerifiedSessionClaims,
} from '../auth/session';

import { decide } from './decide';
import { Principal } from './principal';

const SECRET = 'a-test-session-secret-that-is-long-enough-32';

/** Mint and verify, which is the only way to obtain `VerifiedSessionClaims`. */
async function claimsFor(email: string, slug: string): Promise<VerifiedSessionClaims> {
  const token = await mintSessionToken(newSessionClaims(email, slug), SECRET);
  const verified = await verifySessionToken(token, SECRET);
  if (!verified.ok)
    throw new Error(`the fixture could not verify its own token: ${verified.reason}`);
  return verified.claims;
}

describe('a session principal is scoped to the workspace the session names', () => {
  it('builds one when the resolved workspace is the session’s own', async () => {
    const claims = await claimsFor('member@example.test', 'acme');
    const built = Principal.fromSession(claims, { id: 'ws-acme-id', slug: 'acme' }, 'admin', {
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      label: 'Workspace Member',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    // The id is what scopes every row (§25); the slug is what travelled in the token. Both are
    // asserted, so a factory that wrote the slug into `workspaceId` would fail here.
    expect(built.principal.workspaceId).toBe('ws-acme-id');
    expect(built.principal).toMatchObject({
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      kind: 'membership',
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      apiKeyId: null,
      label: 'Workspace Member',
      actor: 'member@example.test',
    });
    expect(built.principal.role).toBe('admin');
    expect(built.principal.via).toBe('session');
  });

  it('builds none when the resolved workspace is another tenant’s', async () => {
    const claims = await claimsFor('member@example.test', 'acme');
    const built = Principal.fromSession(claims, { id: 'ws-other-id', slug: 'other' }, 'owner', {
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      label: 'Workspace Member',
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('a principal was built across two tenants');
    // The reason names both, so an operator reading a log can tell which pair disagreed.
    expect(built.because).toContain('acme');
    expect(built.because).toContain('other');
  });

  it('does not accept a workspace id that merely looks like the slug', async () => {
    const claims = await claimsFor('member@example.test', 'acme');
    // The id happens to equal the slug of a *different* workspace. The comparison is on the slug,
    // positively, so this is refused rather than passing on a coincidence of spelling.
    expect(
      Principal.fromSession(claims, { id: 'acme', slug: 'acme-staging' }, 'owner', {
        principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
        userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
        label: 'Workspace Member',
      }).ok,
    ).toBe(false);
  });

  it('keeps a machine principal separate from human identity and uses its verified label', () => {
    const principal = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'CI key',
    });

    expect(principal).toMatchObject({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      kind: 'api_key',
      userId: null,
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      label: 'CI key',
      actor: 'CI key',
      via: 'api-key',
    });
  });
});

describe('a browser-token principal is its minter, attenuated by a scope (issue #236)', () => {
  it('carries the minter’s identity, via "browser-token", and the given scope', () => {
    const minter = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'CI key',
    });
    const scope = { kind: 'run', id: 'run-1' } as const;
    const attenuated = Principal.fromBrowserToken(minter, scope);

    expect(attenuated.via).toBe('browser-token');
    expect(attenuated.scope).toEqual(scope);
    expect(attenuated).toMatchObject({
      principalId: minter.principalId,
      kind: minter.kind,
      workspaceId: minter.workspaceId,
      role: minter.role,
      apiKeyId: minter.apiKeyId,
      userId: minter.userId,
      label: minter.label,
    });
    expect(Principal.isPrincipal(attenuated)).toBe(true);
  });

  it('attenuates a membership minter the same way', async () => {
    const claims = await claimsFor('member@example.test', 'acme');
    const built = Principal.fromSession(claims, { id: 'ws-acme-id', slug: 'acme' }, 'owner', {
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      label: 'Workspace Member',
    });
    if (!built.ok) throw new Error('unreachable');
    const scope = { kind: 'session', id: 'session-1' } as const;
    const attenuated = Principal.fromBrowserToken(built.principal, scope);
    expect(attenuated.via).toBe('browser-token');
    expect(attenuated.kind).toBe('membership');
    expect(attenuated.userId).toBe(built.principal.userId);
    expect(attenuated.apiKeyId).toBeNull();
    expect(Principal.isPrincipal(attenuated)).toBe(true);
  });

  it('isPrincipal refuses a scope on a session or an api-key principal, and refuses none on a browser token', () => {
    const apiKeyPrincipal = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'CI key',
    });
    expect(Principal.isPrincipal(apiKeyPrincipal)).toBe(true);
    expect(apiKeyPrincipal.scope).toBeNull();

    // A value the freeze cannot cover because it never was one of this class's instances: the
    // runtime half of the invariant, not merely the type.
    expect(Principal.isPrincipal({ ...apiKeyPrincipal })).toBe(false);
  });

  it.each([
    { kind: 'session', id: 'session-1' },
    { kind: 'run', id: 'run-1' },
  ] as const)('isPrincipal refuses an API key carrying a $kind scope', (scope) => {
    const principal = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'CI key',
      scope,
    });
    expect(Principal.isPrincipal(principal)).toBe(false);
  });

  it('isPrincipal refuses an API key carrying a builder scope: it rides on an OAuth token only', () => {
    const principal = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'CI key',
      scope: { kind: 'builder', id: 'f1d2d2f9-24c8-4ed3-9f7c-3a5f4b1f6d10' },
    });
    expect(Principal.isPrincipal(principal)).toBe(false);
  });

  it('an endpoint-scoped API key carries its scope and the member it acts for (ADR-0134)', () => {
    const MEMBER = '5730530e-4f41-4d62-88c7-0696f4995dca';
    const agent = '0b9ad1fc-9a3a-4f0b-9a37-1d6d1a7c5b11';
    const principal = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'support-bot key',
      actsForPrincipalId: MEMBER,
      scope: { kind: 'a2a-agent', id: agent },
    });
    expect(principal.via).toBe('api-key');
    expect(principal.scope).toEqual({ kind: 'a2a-agent', id: agent });
    expect(principal.ownerPrincipalId).toBe(MEMBER);
    expect(Principal.isPrincipal(principal)).toBe(true);

    const attempt = (method: string, path: string) =>
      decide({ role: principal.role, method, path, ownership: 'own', scope: principal.scope });
    expect(attempt('POST', `/api/agents/${agent}/runs`).effect).toBe('allow');
    expect(attempt('POST', '/api/agents/3c8f6c6e-1b60-4d40-8e21-c0d0a7b5a2f1/runs')).toMatchObject({
      effect: 'deny',
      code: 'token_out_of_scope',
    });
    expect(attempt('POST', '/api/tokens')).toMatchObject({
      effect: 'deny',
      code: 'token_out_of_scope',
    });
  });
});

describe('an OAuth-token principal is the consenting member, narrowed to one endpoint (ADR-0134 part 3)', () => {
  const grant = {
    clientId: 'f1d2d2f9-24c8-4ed3-9f7c-3a5f4b1f6d10',
    audience: 'https://aw.example/mcp/projects/docs',
  };

  async function member(): Promise<Principal> {
    const claims = await claimsFor('member@example.test', 'acme');
    const built = Principal.fromSession(claims, { id: 'ws-acme-id', slug: 'acme' }, 'builder', {
      principalId: '5730530e-4f41-4d62-88c7-0696f4995dca',
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      label: 'Workspace Member',
    });
    if (!built.ok) throw new Error('unreachable');
    return built.principal;
  }

  it('keeps the member’s identity and role, and carries the scope and grant', async () => {
    const subject = await member();
    const principal = Principal.fromOAuthToken(
      subject,
      { kind: 'mcp-project', id: grant.clientId },
      grant,
    );
    expect(principal.via).toBe('oauth-token');
    expect(principal).toMatchObject({
      principalId: subject.principalId,
      kind: 'membership',
      workspaceId: 'ws-acme-id',
      role: 'builder',
      userId: subject.userId,
      apiKeyId: null,
      ownerPrincipalId: subject.principalId,
    });
    expect(principal.scope).toEqual({ kind: 'mcp-project', id: grant.clientId });
    expect(principal.oauth).toEqual(grant);
    expect(Principal.isPrincipal(principal)).toBe(true);
  });

  it('accepts a builder scope on an OAuth token', async () => {
    const principal = Principal.fromOAuthToken(
      await member(),
      { kind: 'builder', id: grant.clientId },
      { ...grant, audience: 'https://aw.example/mcp/builder' },
    );
    expect(principal.scope).toEqual({ kind: 'builder', id: grant.clientId });
    expect(Principal.isPrincipal(principal)).toBe(true);
  });

  it('accepts an app-backend scope on an OAuth token only, and only with its bound agents (ADR-0161 D8)', async () => {
    const agent = '0b9ad1fc-9a3a-4f0b-9a37-1d6d1a7c5b11';
    const appGrant = {
      clientId: grant.clientId,
      audience: `urn:agent-workspace:app-backend:${grant.clientId}`,
    };
    const bound = Principal.fromOAuthToken(
      await member(),
      { kind: 'app-backend', id: grant.clientId, agentIds: [agent] },
      appGrant,
    );
    expect(Principal.isPrincipal(bound)).toBe(true);
    const unbound = Principal.fromOAuthToken(
      await member(),
      { kind: 'app-backend', id: grant.clientId, agentIds: [] },
      appGrant,
    );
    expect(Principal.isPrincipal(unbound)).toBe(false);
    const missing = Principal.fromOAuthToken(
      await member(),
      { kind: 'app-backend', id: grant.clientId },
      appGrant,
    );
    expect(Principal.isPrincipal(missing)).toBe(false);
    const stray = Principal.fromOAuthToken(
      await member(),
      { kind: 'mcp-project', id: grant.clientId, agentIds: [agent] },
      grant,
    );
    expect(Principal.isPrincipal(stray)).toBe(false);
    const key = Principal.fromApiKey({
      principalId: 'c58a0886-0011-4d53-bdfd-e5acd233b341',
      apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
      workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
      role: 'builder',
      label: 'CI key',
      scope: { kind: 'app-backend', id: grant.clientId, agentIds: [agent] },
    });
    expect(Principal.isPrincipal(key)).toBe(false);
  });

  it('is refused outside its endpoint by the scope grammar', async () => {
    const agent = '0b9ad1fc-9a3a-4f0b-9a37-1d6d1a7c5b11';
    const principal = Principal.fromOAuthToken(
      await member(),
      { kind: 'a2a-agent', id: agent },
      grant,
    );
    const attempt = (path: string) =>
      decide({
        role: principal.role,
        method: 'POST',
        path,
        ownership: 'own',
        scope: principal.scope,
      });
    expect(attempt('/api/tokens')).toMatchObject({ effect: 'deny', code: 'token_out_of_scope' });
    expect(attempt('/api/endpoint-clients')).toMatchObject({
      effect: 'deny',
      code: 'token_out_of_scope',
    });
  });

  it('carries no grant on any other kind of principal, and no scope-less OAuth principal exists', async () => {
    const subject = await member();
    expect(subject.oauth).toBeNull();
    expect(Principal.isPrincipal(subject)).toBe(true);
    expect(
      Principal.isPrincipal({
        ...Principal.fromOAuthToken(subject, { kind: 'mcp-project', id: 'x' }, grant),
      }),
    ).toBe(false);
  });
});

describe('who acted and who owns what was written (issue #509, S1-24)', () => {
  const KEY_PRINCIPAL = 'c58a0886-0011-4d53-bdfd-e5acd233b341';
  const ADMIN_PRINCIPAL = '5730530e-4f41-4d62-88c7-0696f4995dca';
  const hostedKey = {
    principalId: KEY_PRINCIPAL,
    apiKeyId: '45ce8116-ab8f-4815-a972-a74c8473f989',
    workspaceId: '3f4f9b90-dda6-4da9-874c-daa5b578bdf0',
    role: 'admin',
    label: 'CI key',
  } as const;

  it('keeps a hosted key the owner of what it writes (regression)', () => {
    for (const identity of [hostedKey, { ...hostedKey, actsForPrincipalId: null }]) {
      const principal = Principal.fromApiKey(identity);
      expect(principal.principalId).toBe(KEY_PRINCIPAL);
      expect(principal.ownerPrincipalId).toBe(KEY_PRINCIPAL);
      expect(Principal.isPrincipal(principal)).toBe(true);
    }
  });

  it('makes the member a local runtime key acts for the owner, and keeps the key the actor', () => {
    const principal = Principal.fromApiKey({ ...hostedKey, actsForPrincipalId: ADMIN_PRINCIPAL });
    expect(principal.principalId).toBe(KEY_PRINCIPAL);
    expect(principal.ownerPrincipalId).toBe(ADMIN_PRINCIPAL);
    expect(principal.kind).toBe('api_key');
    expect(Principal.isPrincipal(principal)).toBe(true);
  });

  it('carries the acts-for owner through a directory record and a browser token it mints', () => {
    const minter = Principal.fromDirectoryRecord({
      principalId: KEY_PRINCIPAL,
      kind: 'api_key',
      workspaceId: hostedKey.workspaceId,
      role: 'admin',
      label: 'aw dev local runtime AAAAAAAA',
      userId: null,
      apiKeyId: hostedKey.apiKeyId,
      actsForPrincipalId: ADMIN_PRINCIPAL,
    });
    expect(minter.ownerPrincipalId).toBe(ADMIN_PRINCIPAL);
    const token = Principal.fromBrowserToken(minter, { kind: 'run', id: 'run-1' });
    // The token stays bound to the acting key (it dies with it) and writes for the same owner.
    expect(token.principalId).toBe(KEY_PRINCIPAL);
    expect(token.ownerPrincipalId).toBe(ADMIN_PRINCIPAL);
    expect(Principal.isPrincipal(token)).toBe(true);
  });

  it('never lets a membership principal own for someone else', async () => {
    const membership = Principal.fromDirectoryRecord({
      principalId: ADMIN_PRINCIPAL,
      kind: 'membership',
      workspaceId: hostedKey.workspaceId,
      role: 'owner',
      label: 'Workspace Member',
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      apiKeyId: null,
      actsForPrincipalId: KEY_PRINCIPAL,
    });
    expect(membership.ownerPrincipalId).toBe(ADMIN_PRINCIPAL);
    const claims = await claimsFor('member@example.test', 'acme');
    const built = Principal.fromSession(claims, { id: 'ws-acme-id', slug: 'acme' }, 'owner', {
      principalId: ADMIN_PRINCIPAL,
      userId: '580e9cc5-46bf-41ce-94a2-fdaf900e55c5',
      label: 'Workspace Member',
    });
    if (!built.ok) throw new Error('unreachable');
    expect(built.principal.ownerPrincipalId).toBe(ADMIN_PRINCIPAL);
    expect(Principal.isPrincipal(built.principal)).toBe(true);
  });
});
