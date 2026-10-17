import {
  ConnectorUpdateRequestSchema,
  type CreateConnectorInput,
} from '@indx-workspace/contracts/connectors';

import {
  command,
  positional,
  readBody,
  readSecretOverlay,
  requireSecretFromStdin,
  value,
  type Command,
  type CommandResult,
  type CommandContext,
} from '../command.js';
import { CreateConnectorBody } from '../inputs.js';

const CONNECTOR_COLUMNS = [
  'id',
  'name',
  'transport',
  'authType',
  'hasCredential',
  'enabled',
  'updatedAt',
];

/** The create body, with `--name` and a `--value-stdin` credential laid over the file. */
async function connectorBody(context: CommandContext): Promise<CreateConnectorInput> {
  return readBody(context, CreateConnectorBody, {
    name: value(context, 'name'),
    ...(await readSecretOverlay(context, 'credential')),
  });
}

/** A connection test's outcome, printed either way; `ok: false` exits 1 (BH061-067). */
function probeResult(outcome: { readonly ok: boolean }): CommandResult {
  return { value: outcome, failed: !outcome.ok };
}

/** §5.8 — `aw connectors`. `update` changes fields; the owner and the transport never change. */
export const connectorCommands: readonly Command[] = [
  command('connectors list', '', 'Every MCP connector', async ({ client, signal }) => ({
    value: await client.connectors.list({ signal }),
    columns: CONNECTOR_COLUMNS,
  })),
  command('connectors get', '<id>', 'One connector', async (context) => ({
    value: await context.client.connectors.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'connectors create',
    '--file <json> [--name <name>] [--value-stdin]',
    'Save a connector (credential from --value-stdin or the body)',
    async (context) => ({
      value: await context.client.connectors.create(await connectorBody(context), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'connectors update',
    '<id> --file <json> [--name <name>] [--value-stdin]',
    "Change a connector's fields (credential from --value-stdin or the body)",
    async (context) => ({
      value: await context.client.connectors.update(
        positional(context, 0, 'id'),
        await readBody(context, ConnectorUpdateRequestSchema, {
          name: value(context, 'name'),
          ...(await readSecretOverlay(context, 'credential')),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command('connectors remove', '<id>', 'Delete a connector', async (context) => {
    await context.client.connectors.remove(positional(context, 0, 'id'), {
      signal: context.signal,
    });
    return { value: undefined };
  }),
  command(
    'connectors rotate-credential',
    '<id> --value-stdin',
    'Replace the saved credential',
    async (context) => ({
      value: await context.client.connectors.rotateCredential(
        positional(context, 0, 'id'),
        await requireSecretFromStdin(context),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'connectors test',
    '<id>',
    'Run the MCP handshake against a saved connector',
    async (context) =>
      probeResult(
        await context.client.connectors.test(positional(context, 0, 'id'), {
          signal: context.signal,
        }),
      ),
  ),
  command(
    'connectors test-draft',
    '--file <json> [--name <name>] [--value-stdin]',
    'Test a connector before saving it',
    async (context) =>
      probeResult(
        await context.client.connectors.testDraft(await connectorBody(context), {
          signal: context.signal,
        }),
      ),
  ),
];
