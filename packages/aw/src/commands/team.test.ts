import {
  ApiKeyResourceSchema,
  MintedApiKeyResponseSchema,
} from '@indx-workspace/contracts/api-keys';
import {
  CreatedUserResponseSchema,
  MembershipResourceSchema,
  UserResourceSchema,
} from '@indx-workspace/contracts/team';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson } from '../testing.js';

const INVITATION = {
  id: 'i-1',
  email: 'bob@example.com',
  role: 'builder',
  invitedBy: 'u-1',
  expiresAt: '2026-09-28T10:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-09-21T10:00:00.000Z',
};

describe('aw team members', () => {
  it('list, add with scalar flags, set-role and remove', async () => {
    const list = await runCli(['team', 'members', 'list', '--json'], {
      route: () => json(200, { memberships: [FIXTURES.membership] }),
    });
    expect(MembershipResourceSchema.array().parse(stdoutJson(list))).toEqual([FIXTURES.membership]);

    const add = await runCli(
      ['team', 'members', 'add', '--email', 'ada@example.com', '--role', 'admin'],
      {
        route: () => json(201, { membership: FIXTURES.membership }),
      },
    );
    expect(add.code).toBe(EXIT_CODE.ok);
    expect(add.calls[0]?.json).toEqual({ email: 'ada@example.com', role: 'admin' });
    expect(add.stdout).toContain('ada@example.com');

    const badRole = await runCli([
      'team',
      'members',
      'add',
      '--email',
      'x@example.com',
      '--role',
      'god',
    ]);
    expect(badRole.code).toBe(EXIT_CODE.usage);
    expect(badRole.stderr).toContain('--role must be one of');

    const setRole = await runCli(['team', 'members', 'set-role', 'm-1', 'viewer'], {
      route: () => json(200, { membership: { ...FIXTURES.membership, role: 'viewer' } }),
    });
    expect(setRole.calls[0]?.method).toBe('PATCH');
    expect(setRole.calls[0]?.json).toEqual({ role: 'viewer' });

    const remove = await runCli(['team', 'members', 'remove', 'm-1'], {
      route: () => json(204, null),
    });
    expect(remove.code).toBe(EXIT_CODE.ok);
    expect(remove.calls[0]?.method).toBe('DELETE');
    expect(remove.stdout).toBe('');
  });
});

describe('aw team users / api-keys', () => {
  it('lists and creates users', async () => {
    const list = await runCli(['team', 'users', 'list', '--json'], {
      route: () => json(200, { users: [FIXTURES.user] }),
    });
    expect(UserResourceSchema.array().parse(stdoutJson(list))).toEqual([FIXTURES.user]);
    const create = await runCli(
      [
        'team',
        'users',
        'create',
        '--email',
        'ada@example.com',
        '--name',
        'Ada',
        '--role',
        'admin',
        '--json',
      ],
      { route: () => json(201, { user: FIXTURES.user, membership: FIXTURES.membership }) },
    );
    expect(create.calls[0]?.json).toEqual({ email: 'ada@example.com', name: 'Ada', role: 'admin' });
    expect(CreatedUserResponseSchema.parse(stdoutJson(create))).toBeDefined();
  });

  it('lists, creates, resends and revokes invitations', async () => {
    const list = await runCli(['team', 'invitations', 'list', '--json'], {
      route: () => json(200, { invitations: [INVITATION] }),
    });
    expect(list.calls[0]?.url.pathname).toBe('/api/invitations');
    expect(stdoutJson(list)).toEqual([INVITATION]);
    const issued = { invitation: INVITATION, token: 't', link: 'https://x/i', warning: 'once' };
    const create = await runCli(
      ['team', 'invitations', 'create', '--email', 'bob@example.com', '--role', 'builder'],
      { route: () => json(201, issued) },
    );
    expect(create.calls[0]?.json).toEqual({ email: 'bob@example.com', role: 'builder' });
    const resend = await runCli(['team', 'invitations', 'resend', 'i-1'], {
      route: () => json(200, issued),
    });
    expect(resend.calls[0]?.url.pathname).toBe('/api/invitations/i-1/resend');
    const revoke = await runCli(['team', 'invitations', 'revoke', 'i-1'], {
      route: () => json(200, { invitation: INVITATION }),
    });
    expect(revoke.calls[0]?.method).toBe('DELETE');
  });

  it('exits non-zero with the server’s 403 for a role that may not invite', async () => {
    const run = await runCli(
      ['team', 'invitations', 'create', '--email', 'bob@example.com', '--role', 'owner'],
      {
        route: () => json(403, { error: { code: 'forbidden', message: 'Viewers cannot invite.' } }),
      },
    );
    expect(run.code).not.toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('forbidden');
  });

  it('lists, mints and revokes API keys', async () => {
    const list = await runCli(['team', 'api-keys', 'list'], {
      route: () => json(200, { apiKeys: [FIXTURES.apiKey] }),
    });
    expect(list.stdout).toContain('ak_live_AAAAAAAAAAAAAAAAAAAAAA');
    const minted = { apiKey: FIXTURES.apiKey, key: FIXTURES.mintedKey, warning: 'Store it now.' };
    const create = await runCli(
      ['team', 'api-keys', 'create', '--name', 'ci', '--role', 'builder', '--json'],
      {
        route: () => json(201, minted),
      },
    );
    expect(create.calls[0]?.json).toEqual({ name: 'ci', role: 'builder', expiresAt: null });
    expect(MintedApiKeyResponseSchema.parse(stdoutJson(create))).toEqual(minted);
    const revoke = await runCli(['team', 'api-keys', 'revoke', 'k-1', '--json'], {
      route: () => json(200, { apiKey: FIXTURES.apiKey }),
    });
    expect(ApiKeyResourceSchema.parse(stdoutJson(revoke))).toEqual(FIXTURES.apiKey);
  });
});
