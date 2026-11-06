import { CreateWebhookRequestSchema } from '@indx-workspace/contracts/webhooks';

import { command, positional, readBody, value, values, type Command } from '../command.js';

const WEBHOOK_COLUMNS = ['id', 'url', 'events', 'createdAt'];

const SECRET_WARNING =
  'Store the signing secret now: it is not shown again. Verify each delivery with ' +
  'verifyWebhookSignature from @indx-workspace/sdk.\n';

/**
 * `aw webhooks` — issue #250 (N-3), ADR-SDK-18-N3-250, spec §5.17. The endpoints a run's outcome is
 * posted to. `create` prints the signing secret once, in its own answer (and `--json` carries it),
 * with a warning on stderr; no other command shows it. The receiver's URL is `--webhook-url`,
 * because `--url` names the control plane.
 */
export const webhookCommands: readonly Command[] = [
  command(
    'webhooks list',
    '',
    'Every webhook of the workspace; no secret is shown',
    async ({ client, signal }) => ({
      value: await client.webhooks.list({ signal }),
      columns: WEBHOOK_COLUMNS,
    }),
  ),
  command(
    'webhooks create',
    '[--file <json>] [--webhook-url <url>] [--event <type> …]',
    'Register an endpoint for run outcomes; the signing secret is shown once',
    async (context) => {
      const events = values(context, 'event');
      const created = await context.client.webhooks.create(
        await readBody(context, CreateWebhookRequestSchema, {
          url: value(context, 'webhook-url'),
          events: events.length === 0 ? undefined : events,
        }),
        { signal: context.signal },
      );
      if (!context.mode.quiet) context.io.stderr(SECRET_WARNING);
      return { value: created };
    },
  ),
  command(
    'webhooks remove',
    '<id>',
    'Delete a webhook and its signing secret; nothing more is sent to it',
    async (context) => {
      await context.client.webhooks.remove(positional(context, 0, 'id'), {
        signal: context.signal,
      });
      return { value: undefined };
    },
  ),
];
