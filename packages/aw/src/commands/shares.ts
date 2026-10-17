import { command, positional, type Command } from '../command.js';

const SHARE_COLUMNS = [
  'id',
  'subjectType',
  'subjectLabel',
  'visibility',
  'mode',
  'expiresAt',
  'revokedAt',
  'viewCount',
  'url',
];

/** §5.13 — `aw shares`. `publish` waits for RF-103 (server-authored share content). */
export const shareCommands: readonly Command[] = [
  command(
    'shares list',
    '',
    "The caller's shares, or every share for an Owner or Admin",
    async ({ client, signal }) => ({
      value: await client.shares.list({ signal }),
      columns: SHARE_COLUMNS,
    }),
  ),
  command(
    'shares revoke',
    '<id>',
    'Revoke a share; its link stops resolving at once',
    async (context) => {
      await context.client.shares.revoke(positional(context, 0, 'id'), { signal: context.signal });
      return { value: undefined };
    },
  ),
];
