import { MEMBERSHIP_ROLES } from '@indx-workspace/contracts/team';

import { command, enumValue, positional, readBody, value, type Command } from '../command.js';
import { UsageError } from '../io.js';
import { CreateApiKeyBody, CreateUserBody, EmailRoleBody } from '../inputs.js';

const MEMBER_COLUMNS = ['id', 'email', 'name', 'role', 'createdAt'];
const USER_COLUMNS = ['id', 'email', 'name', 'createdAt'];
const INVITATION_COLUMNS = ['id', 'email', 'role', 'expiresAt', 'acceptedAt', 'revokedAt'];
const API_KEY_COLUMNS = ['id', 'name', 'role', 'keyPrefix', 'lastUsedAt', 'expiresAt', 'revokedAt'];

function roleWord(word: string): (typeof MEMBERSHIP_ROLES)[number] {
  const role = MEMBERSHIP_ROLES.find((candidate) => candidate === word);
  if (role === undefined)
    throw new UsageError(`<role> must be one of ${MEMBERSHIP_ROLES.join(', ')}`);
  return role;
}

/**
 * §5.2 — `aw team`. `me` waits for S-8. `invitations list|create|resend|revoke` are a person's
 * operations: every `/api/invitations` route refuses an API key (`403 api_key_not_permitted`, ADR
 * W9-WS-119), so they run with the token `aw login` stored (issue #242, ADR-0083), under the same
 * role checks a browser session gets. `accept` stays a browser step: the route proves the
 * invitee through the OIDC invitation-identity cookie, which a CLI token is not.
 */
export const teamCommands: readonly Command[] = [
  command(
    'team members list',
    '',
    "The workspace's members and their roles",
    async ({ client, signal }) => ({
      value: await client.team.members.list({ signal }),
      columns: MEMBER_COLUMNS,
    }),
  ),
  command(
    'team members add',
    '[--file <json>] [--email <email>] [--role <role>]',
    'Attach an existing user to the workspace',
    async (context) => ({
      value: await context.client.team.members.add(
        await readBody(context, EmailRoleBody, {
          email: value(context, 'email'),
          role: enumValue(context, 'role', MEMBERSHIP_ROLES),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'team members set-role',
    '<id> <role>',
    'Move a member to another role',
    async (context) => ({
      value: await context.client.team.members.setRole(
        positional(context, 0, 'id'),
        roleWord(positional(context, 1, 'role')),
        { signal: context.signal },
      ),
    }),
  ),
  command('team members remove', '<id>', 'Remove a member', async (context) => {
    await context.client.team.members.remove(positional(context, 0, 'id'), {
      signal: context.signal,
    });
    return { value: undefined };
  }),
  command(
    'team users list',
    '',
    'The users who are members of the workspace',
    async ({ client, signal }) => ({
      value: await client.team.users.list({ signal }),
      columns: USER_COLUMNS,
    }),
  ),
  command(
    'team users create',
    '[--file <json>] [--email <email>] [--name <name>] [--role <role>]',
    'Create a user and make it a member',
    async (context) => ({
      value: await context.client.team.users.create(
        await readBody(context, CreateUserBody, {
          email: value(context, 'email'),
          name: value(context, 'name'),
          role: enumValue(context, 'role', MEMBERSHIP_ROLES),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'team invitations list',
    '',
    'Every invitation the workspace has sent, newest first (after `aw login`)',
    async ({ client, signal }) => ({
      value: await client.team.invitations.list({ signal }),
      columns: INVITATION_COLUMNS,
    }),
  ),
  command(
    'team invitations create',
    '[--file <json>] [--email <email>] [--role <role>]',
    'Invite an address; the link is shown once',
    async (context) => ({
      value: await context.client.team.invitations.create(
        await readBody(context, EmailRoleBody, {
          email: value(context, 'email'),
          role: enumValue(context, 'role', MEMBERSHIP_ROLES),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'team invitations resend',
    '<id>',
    'Rotate an invitation link and extend its expiry',
    async (context) => ({
      value: await context.client.team.invitations.resend(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command('team invitations revoke', '<id>', 'Revoke an invitation', async (context) => ({
    value: await context.client.team.invitations.revoke(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'team api-keys list',
    '',
    'Every API key of the workspace, revoked ones included',
    async ({ client, signal }) => ({
      value: await client.team.apiKeys.list({ signal }),
      columns: API_KEY_COLUMNS,
    }),
  ),
  command(
    'team api-keys create',
    '[--file <json>] [--name <name>] [--role <role>]',
    'Mint a key; the secret is shown once',
    async (context) => ({
      value: await context.client.team.apiKeys.create(
        await readBody(context, CreateApiKeyBody, {
          name: value(context, 'name'),
          role: enumValue(context, 'role', MEMBERSHIP_ROLES),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command('team api-keys revoke', '<id>', 'Revoke a key', async (context) => ({
    value: await context.client.team.apiKeys.revoke(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
];
