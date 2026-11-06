/**
 * SDK conformance, team: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { describe, expect, it } from 'vitest';
import {
  API_KEY_ID_LENGTH,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  ApiKeyListResponseSchema,
  ApiKeyResourceSchema,
  ApiKeyResponseSchema,
  MintedApiKeyResponseSchema,
} from '@indx-workspace/contracts/api-keys';
import {
  AcceptedInvitationResponseSchema,
  InvitationListResponseSchema,
  InvitationResourceSchema,
  InvitationResponseSchema,
  IssuedInvitationResponseSchema,
} from '@indx-workspace/contracts/invitations';
import {
  CreatedUserResponseSchema,
  MEMBERSHIP_ROLES,
  MembershipListResponseSchema,
  MembershipResponseSchema,
  USER_EMAIL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  UserListResponseSchema,
  UserResourceSchema,
} from '@indx-workspace/contracts/team';
import { mintSessionToken, newSessionClaims, verifySessionToken } from './auth/session';
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from './invitations/handlers';
import { type InvitationsRuntime } from './invitations/runtime';
import { createManualLinkInvitationSender } from './invitations/send-invitation';
import {
  API_KEY_PREFIX as SERVER_API_KEY_PREFIX,
  KEY_ID_LENGTH as SERVER_KEY_ID_LENGTH,
  SECRET_LENGTH as SERVER_SECRET_LENGTH,
} from './rbac/api-key';
import { type ApiKeySummary, type UserSummary } from './rbac/directory';
import {
  changeMembershipRole,
  createApiKey,
  createMembership,
  createUser,
  deleteMembership,
  listApiKeys,
  listMemberships,
  listUsers,
  revokeApiKey,
} from './rbac/handlers';
import { createMemoryDirectory } from './rbac/memory-directory';
import { Principal } from './rbac/principal';
import { ROLES } from './rbac/core/roles';

const TEAM_WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const TEAM_WORKSPACE_SLUG = 'team-conformance';

const TEAM_OWNER_EMAIL = 'owner@team.example.test';

const TEAM_SESSION_SECRET = 'team-conformance-session-secret-that-is-long-enough';

function teamDirectory() {
  return createMemoryDirectory({
    newId: () => crypto.randomUUID(),
    workspaces: [{ id: TEAM_WORKSPACE, slug: TEAM_WORKSPACE_SLUG, name: 'Team' }],
    users: [
      { email: TEAM_OWNER_EMAIL, name: 'Owner', workspaceId: TEAM_WORKSPACE, role: 'owner' },
      {
        email: 'admin@team.example.test',
        name: 'Admin',
        workspaceId: TEAM_WORKSPACE,
        role: 'admin',
      },
    ],
  });
}

/** The real session principal the invitation handlers demand — never an API key. */
async function teamOwnerPrincipal(): Promise<Principal> {
  const token = await mintSessionToken(
    newSessionClaims(TEAM_OWNER_EMAIL, TEAM_WORKSPACE_SLUG),
    TEAM_SESSION_SECRET,
  );
  const verified = await verifySessionToken(token, TEAM_SESSION_SECRET);
  if (!verified.ok) throw new Error(`session could not be verified: ${verified.reason}`);
  const built = Principal.fromSession(
    verified.claims,
    { id: TEAM_WORKSPACE, slug: TEAM_WORKSPACE_SLUG },
    'owner',
    { principalId: 'membership-principal:owner', userId: 'owner-user', label: 'Owner' },
  );
  if (!built.ok) throw new Error(`principal could not be built: ${built.because}`);
  return built.principal;
}

function teamInvitationsRuntime(): InvitationsRuntime {
  return {
    recordAuditEvent: () => Promise.resolve(),
    sendInvitation: createManualLinkInvitationSender(),
  };
}

function parsedOrThrow<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success)
    throw new Error(`the server body does not satisfy the contract: ${JSON.stringify(result)}`);
  return result.data;
}

describe('team', () => {
  it('restates the same roles and API-key shape as the contract', () => {
    expect([...ROLES]).toEqual([...MEMBERSHIP_ROLES]);
    expect(SERVER_API_KEY_PREFIX).toBe(API_KEY_PREFIX);
    expect(SERVER_KEY_ID_LENGTH).toBe(API_KEY_ID_LENGTH);
    expect(SERVER_SECRET_LENGTH).toBe(API_KEY_SECRET_LENGTH);
  });

  it('answers the membership and user routes through the real handlers with bodies the contract accepts', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);

    const users = await listUsers(directory);
    expect(users.status).toBe(200);
    expect(UserListResponseSchema.safeParse(users.body).success).toBe(true);
    // The projection is typed as the server's own row type, so a field added there fails here.
    const projected: UserSummary = {
      id: 'u',
      email: 'x@y.test',
      name: 'X',
      createdAt: '2026-09-21T10:00:00.000Z',
    };
    expect(UserResourceSchema.safeParse(projected).success).toBe(true);

    const created = await createUser(directory, 'owner', {
      email: 'New.Person@team.example.test',
      name: 'New Person',
      role: 'builder',
    });
    expect(created.status).toBe(201);
    expect(CreatedUserResponseSchema.safeParse(created.body).success).toBe(true);

    const listed = await listMemberships(directory);
    expect(listed.status).toBe(200);
    const memberships = parsedOrThrow(MembershipListResponseSchema.safeParse(listed.body));
    expect(memberships.memberships.every((row) => row.principalId.length > 0)).toBe(true);

    const attached = await createMembership(
      teamDirectory().forWorkspace('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      'owner',
      { email: TEAM_OWNER_EMAIL, role: 'viewer' },
    );
    expect(attached.status).toBe(201);
    expect(MembershipResponseSchema.safeParse(attached.body).success).toBe(true);

    const target = memberships.memberships.find(
      (row) => row.email === 'new.person@team.example.test',
    );
    if (target === undefined) throw new Error('the created user was not listed');
    const changed = await changeMembershipRole(directory, 'owner', target.id, { role: 'admin' });
    expect(changed.status).toBe(200);
    expect(MembershipResponseSchema.safeParse(changed.body).success).toBe(true);

    const removed = await deleteMembership(directory, 'owner', target.id);
    expect(removed).toEqual({ status: 204, body: null });
  });
});

describe('team', () => {
  it('restates the name and email bounds the user routes apply', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);
    const longestName = 'n'.repeat(USER_NAME_MAX_LENGTH);
    const fits = await createUser(directory, 'owner', {
      email: 'fits@team.example.test',
      name: longestName,
      role: 'viewer',
    });
    expect(fits.status).toBe(201);
    const overflows = await createUser(directory, 'owner', {
      email: 'over@team.example.test',
      name: `${longestName}x`,
      role: 'viewer',
    });
    expect(overflows.status).toBe(400);

    const longestEmail = `${'e'.repeat(USER_EMAIL_MAX_LENGTH - '@team.example.test'.length)}@team.example.test`;
    expect(longestEmail).toHaveLength(USER_EMAIL_MAX_LENGTH);
    expect(
      (await createUser(directory, 'owner', { email: longestEmail, name: 'E', role: 'viewer' }))
        .status,
    ).toBe(201);
    expect(
      (
        await createUser(directory, 'owner', {
          email: `x${longestEmail}`,
          name: 'E',
          role: 'viewer',
        })
      ).status,
    ).toBe(400);
  });
});

describe('team', () => {
  it('answers the API-key routes through the real handlers, and the plaintext appears in exactly one body', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);

    const minted = await createApiKey(directory, 'owner', {
      name: 'ci-deploy',
      role: 'builder',
      expiresAt: null,
    });
    expect(minted.status).toBe(201);
    const mint = parsedOrThrow(MintedApiKeyResponseSchema.safeParse(minted.body));

    const expiring = await createApiKey(directory, 'owner', {
      name: 'expiring',
      role: 'viewer',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(expiring.status).toBe(201);
    expect(MintedApiKeyResponseSchema.safeParse(expiring.body).success).toBe(true);

    const listed = await listApiKeys(directory);
    expect(listed.status).toBe(200);
    expect(ApiKeyListResponseSchema.safeParse(listed.body).success).toBe(true);

    const revoked = await revokeApiKey(directory, mint.apiKey.id);
    expect(revoked.status).toBe(200);
    expect(ApiKeyResponseSchema.safeParse(revoked.body).success).toBe(true);
    const again = await revokeApiKey(directory, mint.apiKey.id);
    expect(again.status).toBe(200);
    expect(ApiKeyResponseSchema.safeParse(again.body).success).toBe(true);

    const bodies = [minted.body, expiring.body, listed.body, revoked.body, again.body].map((body) =>
      JSON.stringify(body),
    );
    expect(bodies.filter((text) => text.includes(mint.key))).toHaveLength(1);
    for (const text of bodies.slice(2)) expect(text).not.toContain('"key"');

    const projected: ApiKeySummary = mint.apiKey;
    expect(ApiKeyResourceSchema.safeParse(projected).success).toBe(true);
  });
});

describe('team', () => {
  it('restates the API-key name bound and the expiry rule', async () => {
    const directory = teamDirectory().forWorkspace(TEAM_WORKSPACE);
    const longest = 'k'.repeat(API_KEY_NAME_MAX_LENGTH);
    expect((await createApiKey(directory, 'owner', { name: longest, role: 'viewer' })).status).toBe(
      201,
    );
    expect(
      (await createApiKey(directory, 'owner', { name: `${longest}x`, role: 'viewer' })).status,
    ).toBe(400);
    const past = await createApiKey(directory, 'owner', {
      name: 'past',
      role: 'viewer',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    expect(past.status).toBe(400);
    const unparseable = await createApiKey(directory, 'owner', {
      name: 'soon',
      role: 'viewer',
      expiresAt: 'tomorrow',
    });
    expect(unparseable.status).toBe(400);
  });
});

type TeamInvitationsRuntime = ReturnType<typeof teamInvitationsRuntime>;

/** Accepts the invitation as the invitee and checks the membership the contract renders. */
async function expectInviteeJoins(
  root: ReturnType<typeof teamDirectory>,
  runtime: TeamInvitationsRuntime,
  invitation: { readonly id: string; readonly token: string },
): Promise<void> {
  const accepted = await acceptInvitation(
    root,
    {
      email: 'invitee@team.example.test',
      issuer: 'https://issuer.example.test',
      subject: 'subject:invitee',
      iat: 0,
      exp: 0,
    },
    invitation.id,
    { token: invitation.token },
    runtime,
  );
  expect(accepted.status).toBe(200);
  const joined = parsedOrThrow(AcceptedInvitationResponseSchema.safeParse(accepted.body));
  // The one route that renders the membership's principal id today.
  expect(joined.membership.principalId).toEqual(expect.any(String));
  expect(joined.workspaceId).toBe(TEAM_WORKSPACE);
}

describe('team', () => {
  it('answers the invitation lifecycle through the real handlers with bodies the contract accepts', async () => {
    const root = teamDirectory();
    const directory = root.forWorkspace(TEAM_WORKSPACE);
    const principal = await teamOwnerPrincipal();
    const runtime = teamInvitationsRuntime();

    const created = await createInvitation(
      directory,
      principal,
      { email: 'Invitee@team.example.test', role: 'builder' },
      runtime,
    );
    expect(created.status).toBe(201);
    const issued = parsedOrThrow(IssuedInvitationResponseSchema.safeParse(created.body));

    const resent = await resendInvitation(directory, principal, issued.invitation.id, runtime);
    expect(resent.status).toBe(200);
    const rotated = parsedOrThrow(IssuedInvitationResponseSchema.safeParse(resent.body));
    expect(rotated.token).not.toBe(issued.token);

    const listed = await listInvitations(directory, principal);
    expect(listed.status).toBe(200);
    expect(InvitationListResponseSchema.safeParse(listed.body).success).toBe(true);
    expect(JSON.stringify(listed.body)).not.toContain(rotated.token);

    await expectInviteeJoins(root, runtime, { id: issued.invitation.id, token: rotated.token });

    const second = await createInvitation(
      directory,
      principal,
      { email: 'other@team.example.test', role: 'viewer' },
      runtime,
    );
    const other = parsedOrThrow(IssuedInvitationResponseSchema.safeParse(second.body));
    const revoked = await revokeInvitation(directory, principal, other.invitation.id, runtime);
    expect(revoked.status).toBe(200);
    expect(InvitationResponseSchema.safeParse(revoked.body).success).toBe(true);
    expect(
      InvitationResourceSchema.parse(
        parsedOrThrow(InvitationResponseSchema.safeParse(revoked.body)).invitation,
      ).revokedAt,
    ).not.toBeNull();
  });
});
