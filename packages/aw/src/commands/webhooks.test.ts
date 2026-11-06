import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { IDS, json, runCli, stdoutJson } from '../testing.js';

const WEBHOOK_ID = '99999999-9999-4999-8999-999999999999';
const SECRET = `whsec_${'S'.repeat(43)}=`;
const RECEIVER = 'https://hooks.example.com/agent-workspace';

const WEBHOOK = {
  id: WEBHOOK_ID,
  workspaceId: IDS.workspace,
  url: RECEIVER,
  events: ['run.completed', 'run.failed', 'run.cancelled'],
  createdAt: '2026-10-31T00:00:00.000Z',
};

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function route(request: { readonly method: string; readonly url: URL }): Response {
  if (request.method === 'GET') return json(200, { webhooks: [WEBHOOK] });
  if (request.method === 'POST') return json(201, { webhook: WEBHOOK, secret: SECRET });
  return new Response(null, { status: 204 });
}

describe('aw webhooks', () => {
  it('lists the columns with GET /api/webhooks and shows no secret', async () => {
    const run = await runCli(['webhooks', 'list'], { route });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.calls[0]?.url.pathname).toBe('/api/webhooks');
    expect(run.stdout).toContain(RECEIVER);
    expect(run.stdout).toContain('createdAt');
    expect(run.stdout + run.stderr).not.toContain('whsec_');
  });

  it.each([[[]], [['--json']]])(
    'creates and prints the secret exactly once, with the warning on stderr (%j)',
    async (extra) => {
      const run = await runCli(
        [
          'webhooks',
          'create',
          '--webhook-url',
          RECEIVER,
          '--event',
          'run.completed',
          '--event',
          'run.failed',
          ...extra,
        ],
        { route },
      );
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.method).toBe('POST');
      expect(run.calls[0]?.url.pathname).toBe('/api/webhooks');
      expect(run.calls[0]?.json).toEqual({
        url: RECEIVER,
        events: ['run.completed', 'run.failed'],
      });
      expect(occurrences(run.stdout, SECRET)).toBe(1);
      expect(run.stderr).not.toContain(SECRET);
      expect(run.stderr).toContain('not shown again');
    },
  );

  it('carries the secret in --json and leaves events to the server when none is given', async () => {
    const run = await runCli(['webhooks', 'create', '--webhook-url', RECEIVER, '--json'], {
      route,
    });
    expect(run.calls[0]?.json).toEqual({ url: RECEIVER });
    expect(stdoutJson(run)).toEqual({ webhook: WEBHOOK, secret: SECRET });
  });

  it('takes the body from --file, and --quiet drops the warning but not the secret', async () => {
    const run = await runCli(['webhooks', 'create', '--file', '-', '--quiet'], {
      route,
      stdin: JSON.stringify({ url: RECEIVER, events: ['run.cancelled'] }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.json).toEqual({ url: RECEIVER, events: ['run.cancelled'] });
    expect(occurrences(run.stdout, SECRET)).toBe(1);
    expect(run.stderr).toBe('');
  });

  it('refuses an unknown event, a plain-http URL and a missing body before any request', async () => {
    for (const argv of [
      ['webhooks', 'create', '--webhook-url', RECEIVER, '--event', 'run.started'],
      ['webhooks', 'create', '--webhook-url', 'http://hooks.example.com/'],
      ['webhooks', 'create'],
      ['webhooks', 'create', '--url', RECEIVER],
    ]) {
      const run = await runCli(argv, { route });
      expect(run.code, argv.join(' ')).toBe(EXIT_CODE.usage);
      expect(run.calls).toHaveLength(0);
    }
  });

  it('removes with DELETE and exits 0 with nothing on stdout', async () => {
    const run = await runCli(['webhooks', 'remove', WEBHOOK_ID], { route });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('DELETE');
    expect(run.calls[0]?.url.pathname).toBe(`/api/webhooks/${WEBHOOK_ID}`);
    expect(run.stdout).toBe('');
  });

  it('maps a problem to exit 1 with its code, and a missing id to a usage error', async () => {
    const notFound = await runCli(['webhooks', 'remove', WEBHOOK_ID], {
      route: () => json(404, { error: { code: 'webhook_not_found', message: 'No.' } }),
    });
    expect(notFound.code).toBe(EXIT_CODE.problem);
    expect(notFound.stderr).toContain('webhook_not_found');
    const forbidden = await runCli(['webhooks', 'list'], {
      route: () => json(403, { error: { code: 'forbidden', message: 'No.' } }),
    });
    expect(forbidden.code).toBe(EXIT_CODE.problem);
    const missing = await runCli(['webhooks', 'remove'], { route });
    expect(missing.code).toBe(EXIT_CODE.usage);
    expect(missing.calls).toHaveLength(0);
  });

  it('maps a create answer that breaks the contract to exit 3', async () => {
    const run = await runCli(['webhooks', 'create', '--webhook-url', RECEIVER], {
      route: () => json(201, { webhook: WEBHOOK, secret: 'plain' }),
    });
    expect(run.code).toBe(EXIT_CODE.contract);
  });
});
