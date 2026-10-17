import {
  command,
  positional,
  readBody,
  readSecretOverlay,
  value,
  type Command,
} from '../command.js';
import {
  CreateRuntimeConnectionBody,
  CreateRuntimeProfileBody,
  UpdateRuntimeProfileBody,
} from '../inputs.js';

const PROFILE_COLUMNS = [
  'id',
  'name',
  'driver',
  'networkPolicy',
  'filesystem',
  'runtimeConnectionId',
  'updatedAt',
];
const CONNECTION_COLUMNS = ['id', 'name', 'driver', 'createdAt'];

/** §5.4 — `aw runtimes`. `detect` and `test` wait for S-9 and S-4. */
export const runtimeCommands: readonly Command[] = [
  command('runtimes profiles list', '', 'Every runtime profile', async ({ client, signal }) => ({
    value: await client.runtimes.profiles.list({ signal }),
    columns: PROFILE_COLUMNS,
  })),
  command('runtimes profiles get', '<id>', 'One runtime profile', async (context) => ({
    value: await context.client.runtimes.profiles.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'runtimes profiles create',
    '--file <json> [--name <name>]',
    'Create a runtime profile',
    async (context) => ({
      value: await context.client.runtimes.profiles.create(
        await readBody(context, CreateRuntimeProfileBody, { name: value(context, 'name') }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'runtimes profiles update',
    '<id> [--file <json>] [--name <name>]',
    'Change a runtime profile',
    async (context) => ({
      value: await context.client.runtimes.profiles.update(
        positional(context, 0, 'id'),
        await readBody(context, UpdateRuntimeProfileBody, { name: value(context, 'name') }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'runtimes profiles remove',
    '<id>',
    'Delete a profile; agents that referenced it fall back to none',
    async (context) => {
      await context.client.runtimes.profiles.remove(positional(context, 0, 'id'), {
        signal: context.signal,
      });
      return { value: undefined };
    },
  ),
  command(
    'runtimes connections list',
    '',
    'Every runtime connection',
    async ({ client, signal }) => ({
      value: await client.runtimes.connections.list({ signal }),
      columns: CONNECTION_COLUMNS,
    }),
  ),
  command(
    'runtimes connections create',
    '--file <json> [--name <name>] [--value-stdin]',
    'Create a runtime connection (credential from --value-stdin or the body)',
    async (context) => ({
      value: await context.client.runtimes.connections.create(
        await readBody(context, CreateRuntimeConnectionBody, {
          name: value(context, 'name'),
          ...(await readSecretOverlay(context, 'credential')),
        }),
        { signal: context.signal },
      ),
    }),
  ),
];
