import {
  command,
  positional,
  readBody,
  readSecretOverlay,
  requireSecretFromStdin,
  value,
  type Command,
} from '../command.js';
import { CreateModelConnectionBody, UpdateModelConnectionBody } from '../inputs.js';
import { notice } from '../output.js';

const CONNECTION_COLUMNS = ['id', 'name', 'provider', 'hasCredential', 'ready', 'updatedAt'];
const MODEL_COLUMNS = ['connectionId', 'providerModelId', 'displayName'];

/** §5.3 — `aw models`. The credential arrives through `--value-stdin` or the body, never a flag. */
export const modelCommands: readonly Command[] = [
  command('models connections list', '', 'Every model connection', async ({ client, signal }) => ({
    value: await client.models.connections.list({ signal }),
    columns: CONNECTION_COLUMNS,
  })),
  command('models connections get', '<id>', 'One model connection', async (context) => ({
    value: await context.client.models.connections.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'models connections create',
    '--file <json> [--name <name>] [--value-stdin]',
    'Store a connection and its credential (apiKey from --value-stdin or the body)',
    async (context) => ({
      value: await context.client.models.connections.create(
        await readBody(context, CreateModelConnectionBody, {
          name: value(context, 'name'),
          ...(await readSecretOverlay(context, 'apiKey')),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'models connections update',
    '<id> [--file <json>] [--name <name>]',
    'Rename or reconfigure a connection',
    async (context) => ({
      value: await context.client.models.connections.update(
        positional(context, 0, 'id'),
        await readBody(context, UpdateModelConnectionBody, { name: value(context, 'name') }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'models connections remove',
    '<id>',
    'Delete a connection; agents that referenced it are named',
    async (context) => ({
      value: await context.client.models.connections.remove(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'models connections rotate-credential',
    '<id> --value-stdin',
    'Replace the stored credential',
    async (context) => {
      await context.client.models.connections.rotateCredential(
        positional(context, 0, 'id'),
        await requireSecretFromStdin(context),
        { signal: context.signal },
      );
      return { value: undefined };
    },
  ),
  command(
    'models connections test',
    '<id>',
    'Probe the provider with the stored credential',
    async (context) => ({
      value: await context.client.models.connections.test(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'models discover',
    '',
    'Every model every ready connection offers',
    async ({ client, signal, mode, io }) => {
      const discovered = await client.models.discover({ signal });
      if (mode.json && !mode.jsonl) return { value: discovered };
      for (const failed of discovered.unavailable ?? []) {
        notice(io, mode, `unavailable: ${failed.connectionName} (${failed.reason})`);
      }
      return { value: discovered.models, columns: MODEL_COLUMNS };
    },
  ),
];
