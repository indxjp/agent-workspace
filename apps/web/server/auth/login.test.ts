import { describe, expect, it, vi } from 'vitest';

import type { UserMembershipSummary, UserSummary } from '../rbac/directory';
import { resolveOidcSignIn } from './login';

const ISSUER = 'https://issuer.example.test';
const IDENTITY = { subject: 'sub-1', email: 'idp@example.test' };

function membership(slug: string): UserMembershipSummary {
  return {
    principalId: `principal-${slug}`,
    workspaceId: `ws-${slug}`,
    workspaceSlug: slug,
    workspaceName: slug,
    role: 'builder',
  };
}

function user(id: string, email: string): UserSummary {
  return { id, email, name: id, createdAt: '2026-01-01T00:00:00.000Z' };
}

function stubDirectory(options: {
  readonly bound?: { readonly userId: string; readonly email: string };
  readonly byEmail?: UserSummary;
  readonly memberships?: readonly UserMembershipSummary[];
}) {
  return {
    findIdentity: vi.fn().mockResolvedValue(options.bound ?? null),
    findUserByEmail: vi.fn().mockResolvedValue(options.byEmail ?? null),
    membershipsForUser: vi.fn().mockResolvedValue(options.memberships ?? []),
    linkIdentity: vi.fn().mockResolvedValue(undefined),
  };
}

describe('resolveOidcSignIn', () => {
  it('signs a bound identity with one membership in without linking or looking up the email', async () => {
    const directory = stubDirectory({
      bound: { userId: 'u1', email: 'idp@example.test' },
      memberships: [membership('acme')],
    });

    await expect(resolveOidcSignIn(directory, ISSUER, IDENTITY)).resolves.toEqual({
      kind: 'session',
      userId: 'u1',
      email: 'idp@example.test',
      workspaceSlug: 'acme',
    });
    expect(directory.findUserByEmail).not.toHaveBeenCalled();
    expect(directory.linkIdentity).not.toHaveBeenCalled();
  });

  it('does not link an email match that has no membership', async () => {
    const directory = stubDirectory({ byEmail: user('u1', 'idp@example.test') });

    await expect(resolveOidcSignIn(directory, ISSUER, IDENTITY)).resolves.toEqual({
      kind: 'invitation',
    });
    expect(directory.linkIdentity).not.toHaveBeenCalled();
  });

  it('returns invitation for an identity that matches no account', async () => {
    const directory = stubDirectory({});

    await expect(resolveOidcSignIn(directory, ISSUER, IDENTITY)).resolves.toEqual({
      kind: 'invitation',
    });
    expect(directory.membershipsForUser).not.toHaveBeenCalled();
    expect(directory.linkIdentity).not.toHaveBeenCalled();
  });

  it('links an email match with one membership exactly once and signs it in', async () => {
    const directory = stubDirectory({
      byEmail: user('u1', 'idp@example.test'),
      memberships: [membership('acme')],
    });

    await expect(resolveOidcSignIn(directory, ISSUER, IDENTITY)).resolves.toEqual({
      kind: 'session',
      userId: 'u1',
      email: 'idp@example.test',
      workspaceSlug: 'acme',
    });
    expect(directory.linkIdentity).toHaveBeenCalledTimes(1);
    expect(directory.linkIdentity).toHaveBeenCalledWith(ISSUER, 'sub-1', 'u1');
  });

  it('asks for a workspace choice when there are several memberships', async () => {
    const directory = stubDirectory({
      bound: { userId: 'u1', email: 'dir@example.test' },
      memberships: [membership('acme'), membership('globex')],
    });

    await expect(resolveOidcSignIn(directory, ISSUER, IDENTITY)).resolves.toEqual({
      kind: 'select',
      userId: 'u1',
      email: 'dir@example.test',
    });
  });

  it("uses the directory email, not the IdP's claim, for a bound user", async () => {
    const directory = stubDirectory({
      bound: { userId: 'u1', email: 'directory@example.test' },
      memberships: [membership('acme')],
    });

    const result = await resolveOidcSignIn(directory, ISSUER, IDENTITY);

    expect(result).toMatchObject({ kind: 'session', email: 'directory@example.test' });
  });
});
