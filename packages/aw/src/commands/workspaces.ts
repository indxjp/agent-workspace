import {
  FEATURE_DEPENDENCIES,
  FeatureIdSchema,
  type FeatureId,
} from '@indx-workspace/contracts/features';

import {
  booleanWord,
  command,
  positional,
  readBody,
  value,
  type Command,
  type CommandContext,
} from '../command.js';
import { UsageError } from '../io.js';
import { readStoredCredential, saveStoredCredential } from '../credentials.js';
import { CreateWorkspaceBody, UpdateWorkspaceBody } from '../inputs.js';

const WORKSPACE_COLUMNS = ['id', 'slug', 'name', 'role', 'archivedAt'];

const FEATURE_COLUMNS = ['id', 'installed', 'enabled', 'needs'];

async function featureRows(context: CommandContext, workspaceId: string) {
  const { features } = await context.client.workspaces.features.list(workspaceId, {
    signal: context.signal,
  });
  const needs: Partial<Record<FeatureId, readonly FeatureId[]>> = FEATURE_DEPENDENCIES;
  return features.map((row) => ({ ...row, needs: (needs[row.id] ?? []).join(',') }));
}

async function workspaceIdFlag(context: CommandContext): Promise<string> {
  return (
    value(context, 'workspace') ?? (await context.client.me({ signal: context.signal })).workspaceId
  );
}

/** `disable <id>` / `enable <id>`: read the off set, edit it, write it back (ADR-0160 D6). */
async function switchFeature(context: CommandContext, verb: 'disable' | 'enable') {
  const feature = FeatureIdSchema.safeParse(positional(context, 0, 'id'));
  if (!feature.success) {
    throw new UsageError(`<id> must be one of ${FeatureIdSchema.options.join(', ')}`);
  }
  const workspaceId = await workspaceIdFlag(context);
  const current = await context.client.workspaces.features.list(workspaceId, {
    signal: context.signal,
  });
  // Every row that is not on, installed or not: the server requires each uninstalled feature in
  // `disabled`, so dropping one here would make every switch a `409 feature_not_installed`.
  const off = current.features
    .filter((row) => !row.enabled)
    .map((row) => row.id)
    .filter((id) => id !== feature.data);
  const { features } = await context.client.workspaces.features.set(
    workspaceId,
    { disabled: verb === 'disable' ? [...off, feature.data] : off },
    { signal: context.signal },
  );
  return { value: features.filter((row) => row.id === feature.data), columns: FEATURE_COLUMNS };
}

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
    'workspaces features list',
    '[--workspace <id>]',
    'Which features are on for a workspace (default: the one you act in)',
    async (context) => ({
      value: await featureRows(context, await workspaceIdFlag(context)),
      columns: FEATURE_COLUMNS,
    }),
  ),
  command(
    'workspaces features disable',
    '<id> [--workspace <id>]',
    'Switch a feature off for a workspace (Owner only)',
    (context) => switchFeature(context, 'disable'),
  ),
  command(
    'workspaces features enable',
    '<id> [--workspace <id>]',
    'Switch a feature back on for a workspace (Owner only)',
    (context) => switchFeature(context, 'enable'),
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
