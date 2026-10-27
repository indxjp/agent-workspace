import {
  CreateTriggerRequestSchema,
  TRIGGER_KINDS,
  UpdateTriggerRequestSchema,
} from '@indx-workspace/contracts/triggers';

import {
  command,
  enumValue,
  positional,
  readBody,
  readSecretOverlay,
  singleValue,
  value,
  type Command,
} from '../command.js';

const TRIGGER_COLUMNS = ['id', 'name', 'kind', 'agentId', 'subject', 'enabled', 'lastFiredAt'];

/**
 * `aw triggers` — issue #1295, ADR-0144. A trigger starts a run of one agent without a person at
 * the keyboard. `create` and `secret rotate` print the webhook secret and the fire path once, in
 * the answer of that one command and in no other output. The Zoom secret token is read from stdin
 * (`--value-stdin`), never from a flag; `cron`, `timezone`, `enabled` and `outputSchema` (ADR-0154)
 * go through `--file`. `--subject` names the caller its runs act for (ADR-0156); clear it with
 * `--file` and `{"subject": null}`.
 */
export const triggerCommands: readonly Command[] = [
  command(
    'triggers list',
    '',
    'Every trigger of the workspace; no secret is shown',
    async ({ client, signal }) => ({
      value: await client.triggers.list({ signal }),
      columns: TRIGGER_COLUMNS,
    }),
  ),
  command('triggers get', '<id>', 'One trigger', async (context) => ({
    value: await context.client.triggers.get(positional(context, 0, 'id'), {
      signal: context.signal,
    }),
  })),
  command(
    'triggers create',
    '[--file <json>] [--name <name>] [--kind <kind>] [--agent <id>] [--prompt <text>] [--subject <caller>] [--value-stdin]',
    'Create a trigger; the webhook secret is shown once (--value-stdin reads a Zoom secret token)',
    async (context) => ({
      value: await context.client.triggers.create(
        await readBody(context, CreateTriggerRequestSchema, {
          name: value(context, 'name'),
          kind: enumValue(context, 'kind', TRIGGER_KINDS),
          agentId: singleValue(context, 'agent'),
          prompt: value(context, 'prompt'),
          subject: value(context, 'subject'),
          ...(await readSecretOverlay(context, 'zoomSecretToken')),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'triggers update',
    '<id> [--file <json>] [--name <name>] [--prompt <text>] [--subject <caller>] [--value-stdin]',
    'Change the name, prompt, enabled flag, output schema, run subject or Zoom secret token of a trigger',
    async (context) => ({
      value: await context.client.triggers.update(
        positional(context, 0, 'id'),
        await readBody(context, UpdateTriggerRequestSchema, {
          name: value(context, 'name'),
          prompt: value(context, 'prompt'),
          subject: value(context, 'subject'),
          ...(await readSecretOverlay(context, 'zoomSecretToken')),
        }),
        { signal: context.signal },
      ),
    }),
  ),
  command(
    'triggers remove',
    '<id>',
    'Delete a trigger; its URL stops answering',
    async (context) => ({
      value: await context.client.triggers.remove(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
  command(
    'triggers secret rotate',
    '<id>',
    'Rotate the webhook secret; it is shown once and the old URL stops working',
    async (context) => ({
      value: await context.client.triggers.rotateSecret(positional(context, 0, 'id'), {
        signal: context.signal,
      }),
    }),
  ),
];
