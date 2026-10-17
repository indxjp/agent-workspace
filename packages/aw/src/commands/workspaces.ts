import {
  booleanWord,
  command,
  positional,
  readBody,
  value,
  type Command,
  type CommandContext,
} from '../command.js';
import { readStoredCredential, saveStoredCredential } from '../credentials.js';
import { CreateWorkspaceBody, UpdateWorkspaceBody } from '../inputs.js';

const WORKSPACE_COLUMNS = ['id', 'slug', 'name', 'role', 'archivedAt'];

function archivedFlag(context: CommandContext): boolean | undefined {
  const raw = value(context, 'archived');
  return raw === undefined ? undefined : booleanWord(raw, 'archived');
}

/**
 * §5.1 — `aw workspaces`. `list|get|create|update|select` are a person's operations: every
 * `/api/workspaces` route refuses an API key (`403 api_key_not_permitted`, ADR W9-WS-119), so they
 * run with the token `aw login` stored (issue #242, ADR-0083). `select` moves that token to
 * another of the person's workspaces and records the move in the credentials file.
 */
export const workspaceCommands: readonly Command[] = [
  command(
    'workspaces list',
    '',
    'Every workspace you belong to, with your role in each (after `aw login`)',
    async ({ client, signal }) => ({
      value: await client.workspaces.list({ signal }),
      columns: WORKSPACE_COLUMNS,
    }),
  ),
  command('workspaces get', '<id>', 'One of your workspaces', async (context) => ({
    value: await context.client.workspaces.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'workspaces create',
    '[--file <json>] [--name <name>] [--slug <slug>]',
    'Create a workspace; you become its first Owner',
    async (context) => ({
      value: await context.client.workspaces.create(
        await readBody(context, CreateWorkspaceBody, {
          name: value(context, 'name'),
          slug: value(context, 'slug'),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'workspaces update',
    '<id> [--file <json>] [--name <name>] [--archived true|false]',
    'Rename, archive or restore a workspace (Owner only)',
    async (context) => ({
      value: await context.client.workspaces.update(
        positional(context, 0, 'id'),
        await readBody(context, UpdateWorkspaceBody, {
          name: value(context, 'name'),
          archived: archivedFlag(context),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'workspaces select',
    '<id|slug>',
    'Act in another of your workspaces from now on (after `aw login`)',
    async (context) => {
      const workspace = await context.client.workspaces.select(positional(context, 0, 'id|slug'), {
        signal: context.signal,
      });
      const stored = await readStoredCredential(context.io.homeDir, context.baseUrl);
      if (stored !== null) {
        await saveStoredCredential(context.io.homeDir, context.baseUrl, {
          ...stored,
          workspaceId: workspace.id,
          workspaceSlug: workspace.slug,
        });
      }
      return { value: workspace };
    },
  ),
  command(
    'workspaces sharing-policy get',
    '',
    'Whether members may publish public shares',
    async ({ client, signal }) => ({
      value: await client.workspaces.sharingPolicy.get({ signal }),
    }),
  ),
  command(
    'workspaces sharing-policy set',
    '<true|false>',
    'Turn public sharing on or off (Owner only)',
    async (context) => ({
      value: await context.client.workspaces.sharingPolicy.set(
        { publicSharing: booleanWord(positional(context, 0, 'true|false'), 'true|false') },
        { signal: context.signal },
      ),
    }),
  ),
];
