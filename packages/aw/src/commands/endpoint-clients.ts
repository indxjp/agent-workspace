import {
  CreateEndpointClientRequestSchema,
  ENDPOINT_CLIENT_KINDS,
  MintEndpointKeyRequestSchema,
  UpdateEndpointClientRequestSchema,
} from '@indx-workspace/contracts/endpoint-clients';

import {
  command,
  enumValue,
  positional,
  readBody,
  value,
  values,
  type Command,
  type CommandContext,
} from '../command.js';
import { UsageError } from '../io.js';

const ENDPOINT_CLIENT_COLUMNS = [
  'id',
  'name',
  'kind',
  'agentIds',
  'toolNames',
  'revokedAt',
  'createdAt',
];

/** The agent ids behind `--agent <name>`, one `agents list` for all of them; an unknown name is a usage error. */
async function agentIdsNamed(
  context: CommandContext,
  names: readonly string[],
): Promise<readonly string[]> {
  const agents = await context.client.agents.list({ signal: context.signal });
  return names.map((name) => {
    const agent = agents.find((candidate) => candidate.name === name);
    if (agent === undefined) throw new UsageError(`no agent named ${JSON.stringify(name)}`);
    return agent.id;
  });
}

/** The `--agent` and `--tool` flags as body fields; a field is present only when its flag was given. */
async function agentAndToolFields(context: CommandContext): Promise<Record<string, unknown>> {
  const names = values(context, 'agent');
  const tools = values(context, 'tool');
  return {
    agentIds: names.length === 0 ? undefined : await agentIdsNamed(context, names),
    toolNames: tools.length === 0 ? undefined : tools,
  };
}

/**
 * `aw endpoint-clients` — issue #949, ADR-0134. An endpoint client names the one resource an
 * external platform may reach; `keys create` mints the static bearer it presents. The key is in the
 * answer of that one command and in no other output; `secret rotate` does the same for the OAuth
 * client secret (issue #971).
 */
export const endpointClientCommands: readonly Command[] = [
  command(
    'endpoint-clients list',
    '',
    'Every endpoint client of the workspace, revoked ones included',
    async ({ client, signal }) => ({
      value: await client.endpointClients.list({ signal }),
      columns: ENDPOINT_CLIENT_COLUMNS,
    }),
  ),
  command('endpoint-clients get', '<id>', 'One endpoint client', async (context) => ({
    value: await context.client.endpointClients.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'endpoint-clients create',
    '[--file <json>] [--name <name>] [--kind <kind>] [--agent <name>] [--tool <tool>]',
    'Create a client for an MCP project, one agent (a2a-agent takes exactly one --agent) or the Builder (no --agent)',
    async (context) => {
      const kind = enumValue(context, 'kind', ENDPOINT_CLIENT_KINDS);
      const fields = await agentAndToolFields(context);
      return {
        value: await context.client.endpointClients.create(
          await readBody(context, CreateEndpointClientRequestSchema, {
            name: value(context, 'name'),
            kind,
            ...fields,
            ...(kind === 'builder' && fields['agentIds'] === undefined ? { agentIds: [] } : {}),
          }),
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'endpoint-clients update',
    '<id> [--file <json>] [--agent <name>] [--tool <tool>] [--redirect-uri <uri> …]',
    'Replace the agents, the tool allow-list and/or the OAuth redirect URIs of a client',
    async (context) => {
      const redirectUris = values(context, 'redirect-uri');
      return {
        value: await context.client.endpointClients.update(
          positional(context, 0, 'id'),
          await readBody(context, UpdateEndpointClientRequestSchema, {
            ...(await agentAndToolFields(context)),
            redirectUris: redirectUris.length === 0 ? undefined : redirectUris,
          }),
          { signal: context.signal },
        ),
      };
    },
  ),
  command(
    'endpoint-clients revoke',
    '<id>',
    'Revoke a client and every key bound to it',
    async (context) => ({
      value: await context.client.endpointClients.revoke(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'endpoint-clients keys create',
    '<id> [--file <json>] [--name <name>] [--expires-at <iso>]',
    'Mint an endpoint-scoped key; the secret is shown once',
    async (context) => ({
      value: await context.client.endpointClients.mintKey(
        positional(context, 0, 'id'),
        await readBody(context, MintEndpointKeyRequestSchema, {
          name: value(context, 'name'),
          expiresAt: value(context, 'expires-at'),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'endpoint-clients secret rotate',
    '<id>',
    'Rotate the OAuth client secret; the secret is shown once and the old one stops working',
    async (context) => ({
      value: await context.client.endpointClients.rotateSecret(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
];
