import { SESSION_STATUSES } from '@indx-workspace/contracts/sessions';

import {
  command,
  enumValue,
  integerValue,
  isOn,
  positional,
  value,
  type Command,
  type CommandContext,
} from '../command.js';
import { notice } from '../output.js';

const SESSION_COLUMNS = [
  'id',
  'agentId',
  'projectId',
  'title',
  'status',
  'engineSessionId',
  'updatedAt',
];

async function setStatus(context: CommandContext, status: 'active' | 'archived'): Promise<unknown> {
  return context.client.sessions.update(
    positional(context, 0, 'id'),
    { status },
    { signal: context.signal },
  );
}

/** §5.11 — `aw sessions`. Transcript append and delete are the runtime's and have no command. */
export const sessionCommands: readonly Command[] = [
  command(
    'sessions list',
    '[--status active|archived] [--limit <1-200>] [--cursor <cursor>] [--all]',
    'Sessions the caller may see, newest first: one page, or every page with --all',
    async (context) => {
      const status = enumValue(context, 'status', SESSION_STATUSES);
      const limit = integerValue(context, 'limit');
      const cursor = value(context, 'cursor');
      const query = {
        ...(status === undefined ? {} : { status }),
        ...(limit === undefined ? {} : { limit }),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const { client, signal, mode, io } = context;
      if (isOn(context, 'all')) {
        const sessions = [];
        for await (const session of client.sessions.listAll(query, { signal })) {
          sessions.push(session);
        }
        return { value: sessions, columns: SESSION_COLUMNS };
      }
      const listed = await client.sessions.list(query, { signal });
      if (mode.json && !mode.jsonl) return { value: listed };
      if (listed.nextCursor !== null) notice(io, mode, `next page: --cursor ${listed.nextCursor}`);
      return { value: listed.sessions, columns: SESSION_COLUMNS };
    },
  ),
  command('sessions get', '<id>', 'One session', async (context) => ({
    value: await context.client.sessions.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command('sessions rename', '<id> <title>', 'Give a session a title', async (context) => ({
    value: await context.client.sessions.update(
      positional(context, 0, 'id'),
      { title: positional(context, 1, 'title') },
      { signal: context.signal },
    ),
  })),
  command('sessions archive', '<id>', 'Archive a session', async (context) => ({
    value: await setStatus(context, 'archived'),
  })),
  command('sessions restore', '<id>', 'Restore an archived session', async (context) => ({
    value: await setStatus(context, 'active'),
  })),
  command(
    'sessions transcript',
    '<provider-session-id> [--project-key <key>] [--subpath <key>]',
    'The stored transcript, one provider-native entry per line',
    async (context) => {
      // Issue #235 (S-21): `--project-key` is a pure override, defaulted server-side to the
      // caller's own workspace when omitted — no `sessions list` round trip to learn it.
      const projectKey = value(context, 'project-key');
      const subpath = value(context, 'subpath');
      const entries = await context.client.sessions.transcript.read(
        positional(context, 0, 'provider-session-id'),
        {
          ...(projectKey === undefined ? {} : { projectKey }),
          ...(subpath === undefined ? {} : { subpath }),
        },
        { signal: context.signal },
      );
      const { mode } = context;
      if (mode.json || mode.jsonl) return { value: entries };
      // Entries are provider-native objects of no fixed shape: one compact JSON line each.
      for (const entry of entries) context.io.stdout(`${JSON.stringify(entry)}\n`);
      return undefined;
    },
  ),
  command(
    'sessions subkeys',
    '<provider-session-id> [--project-key <key>]',
    'The subagent transcripts stored under the session',
    async (context) => {
      const projectKey = value(context, 'project-key');
      return {
        value: await context.client.sessions.transcript.subkeys(
          positional(context, 0, 'provider-session-id'),
          projectKey === undefined ? {} : { projectKey },
          { signal: context.signal },
        ),
      };
    },
  ),
];
