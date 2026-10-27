import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { IDS, json, runCli } from '../testing.js';

const TRIGGER_ID = '88888888-8888-4888-8888-888888888888';
const SECRET = 'awts_live_AbCdEfGhIjKlMnOpQrStUv0123456789';
const ROTATED_SECRET = 'awts_live_RotatedSecretForTheTest0123456789';
const ZOOM_TOKEN = 'zoom-app-secret-token';

const TRIGGER = {
  id: TRIGGER_ID,
  name: 'inbox-triage',
  kind: 'webhook',
  agentId: IDS.agent,
  prompt: 'Triage this: {{body}}',
  cron: null,
  timezone: null,
  enabled: true,
  outputSchema: null,
  subject: null,
  ownerPrincipalId: IDS.principal,
  hasSecret: true,
  hasZoomSecretToken: false,
  lastFiredAt: null,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
};

function secretAnswer(secret: string): unknown {
  return {
    trigger: TRIGGER,
    secret,
    firePath: `/api/triggers/${TRIGGER_ID}/fire/${secret}`,
    warning: 'Store this URL now; the secret is not shown again.',
  };
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function route(request: { readonly method: string; readonly url: URL }): Response {
  const { pathname } = request.url;
  if (pathname.endsWith('/secret')) return json(201, secretAnswer(ROTATED_SECRET));
  if (pathname === '/api/triggers' && request.method === 'GET') {
    return json(200, { triggers: [TRIGGER] });
  }
  if (pathname === '/api/triggers') return json(201, secretAnswer(SECRET));
  return json(200, { trigger: TRIGGER });
}

const CREATE = [
  'triggers',
  'create',
  '--name',
  'inbox-triage',
  '--kind',
  'webhook',
  '--agent',
  IDS.agent,
  '--prompt',
  'Triage this: {{body}}',
];

describe('aw triggers', () => {
  it('lists the columns and gets one without any secret in the output', async () => {
    const list = await runCli(['triggers', 'list'], { route });
    expect(list.code).toBe(EXIT_CODE.ok);
    expect(list.stdout).toContain('inbox-triage');
    expect(list.stdout).toContain('lastFiredAt');
    const get = await runCli(['triggers', 'get', TRIGGER_ID, '--json'], { route });
    expect(get.calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}`);
    for (const run of [list, get]) expect(run.stdout + run.stderr).not.toContain(SECRET);
  });

  it.each([[[]], [['--json']]])(
    'creates and prints the secret exactly once (%j)',
    async (extra) => {
      const run = await runCli([...CREATE, ...extra], { route });
      expect(run.code).toBe(EXIT_CODE.ok);
      expect(run.calls).toHaveLength(1);
      expect(run.calls[0]?.method).toBe('POST');
      expect(run.calls[0]?.url.pathname).toBe('/api/triggers');
      expect(run.calls[0]?.json).toEqual({
        name: 'inbox-triage',
        kind: 'webhook',
        agentId: IDS.agent,
        prompt: 'Triage this: {{body}}',
      });
      // `firePath` carries the secret, so the answer shows it in the `secret` field and once in the path.
      expect(occurrences(run.stdout, `/fire/${SECRET}`)).toBe(1);
      expect(run.stderr).not.toContain(SECRET);
    },
  );

  it('takes cron, timezone and enabled from --file, with flags laid over it', async () => {
    const run = await runCli(['triggers', 'create', '--file', '-', '--name', 'nightly'], {
      route,
      stdin: JSON.stringify({
        kind: 'schedule',
        name: 'ignored',
        agentId: IDS.agent,
        prompt: 'Run the nightly report.',
        cron: '0 3 * * *',
        timezone: 'Europe/Berlin',
        enabled: false,
      }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.json).toMatchObject({
      kind: 'schedule',
      name: 'nightly',
      cron: '0 3 * * *',
      timezone: 'Europe/Berlin',
      enabled: false,
    });
  });

  it('sends outputSchema from --file and refuses one over the ADR-0143 limits before any request', async () => {
    const body = {
      kind: 'webhook',
      name: 'typed',
      agentId: IDS.agent,
      prompt: 'Handle: {{body}}',
    };
    const typed = { type: 'object', properties: { verdict: { type: 'string' } } };
    const ok = await runCli(['triggers', 'create', '--file', '-'], {
      route,
      stdin: JSON.stringify({ ...body, outputSchema: typed }),
    });
    expect(ok.code).toBe(EXIT_CODE.ok);
    expect(ok.calls[0]?.json).toMatchObject({ outputSchema: typed });

    const bad = await runCli(['triggers', 'create', '--file', '-'], {
      route,
      stdin: JSON.stringify({ ...body, outputSchema: { type: 'array' } }),
    });
    expect(bad.code).toBe(EXIT_CODE.usage);
    expect(bad.calls).toHaveLength(0);
  });

  it('sends --subject on create and update, clears it from --file, and lists it (ADR-0156)', async () => {
    const created = await runCli([...CREATE, '--subject', 'planner'], { route });
    expect(created.code).toBe(EXIT_CODE.ok);
    expect(created.calls[0]?.json).toMatchObject({ subject: 'planner' });

    const updated = await runCli(['triggers', 'update', TRIGGER_ID, '--subject', 'organiser'], {
      route,
    });
    expect(updated.code).toBe(EXIT_CODE.ok);
    expect(updated.calls[0]?.json).toEqual({ subject: 'organiser' });

    const cleared = await runCli(['triggers', 'update', TRIGGER_ID, '--file', '-'], {
      route,
      stdin: JSON.stringify({ subject: null }),
    });
    expect(cleared.code).toBe(EXIT_CODE.ok);
    expect(cleared.calls[0]?.json).toEqual({ subject: null });

    const refused = await runCli([...CREATE, '--subject', 'a'.repeat(257)], { route });
    expect(refused.code).toBe(EXIT_CODE.usage);
    expect(refused.calls).toHaveLength(0);

    const listed = await runCli(['triggers', 'list'], { route });
    expect(listed.stdout).toContain('subject');
  });

  it('reads the Zoom secret token from stdin and never from argv', async () => {
    const run = await runCli([...CREATE, '--value-stdin'], { route, stdin: `${ZOOM_TOKEN}\n` });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.json).toMatchObject({ zoomSecretToken: ZOOM_TOKEN });
    expect(run.stdout + run.stderr).not.toContain(ZOOM_TOKEN);
  });

  it('refuses a bad --kind before anything is sent', async () => {
    const run = await runCli(['triggers', 'create', '--kind', 'bogus'], { route });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--kind must be one of webhook, schedule');
    expect(run.calls).toHaveLength(0);
  });

  it('refuses a create without a body, and an invalid one, before anything is sent', async () => {
    const empty = await runCli(['triggers', 'create'], { route });
    expect(empty.code).toBe(EXIT_CODE.usage);
    const invalid = await runCli(['triggers', 'create', '--name', 'x', '--kind', 'webhook'], {
      route,
    });
    expect(invalid.code).toBe(EXIT_CODE.usage);
    expect(invalid.stderr).toContain('invalid body');
    expect([...empty.calls, ...invalid.calls]).toHaveLength(0);
  });

  it('updates only what was given, and refuses an empty update', async () => {
    const update = await runCli(['triggers', 'update', TRIGGER_ID, '--prompt', 'New: {{body}}'], {
      route,
    });
    expect(update.code).toBe(EXIT_CODE.ok);
    expect(update.calls).toHaveLength(1);
    expect(update.calls[0]?.method).toBe('PATCH');
    expect(update.calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}`);
    expect(update.calls[0]?.json).toEqual({ prompt: 'New: {{body}}' });
    const empty = await runCli(['triggers', 'update', TRIGGER_ID], { route });
    expect(empty.code).toBe(EXIT_CODE.usage);
    expect(empty.calls).toHaveLength(0);
  });

  it('disables a trigger through --file', async () => {
    const run = await runCli(['triggers', 'update', TRIGGER_ID, '--file', '-'], {
      route,
      stdin: '{"enabled":false}',
    });
    expect(run.calls[0]?.json).toEqual({ enabled: false });
  });

  it('removes with DELETE', async () => {
    const run = await runCli(['triggers', 'remove', TRIGGER_ID], { route });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('DELETE');
    expect(run.calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}`);
  });

  it.each([[[]], [['--json']]])('prints a rotated secret exactly once (%j)', async (extra) => {
    const run = await runCli(['triggers', 'secret', 'rotate', TRIGGER_ID, ...extra], { route });
    expect(run.stderr).toBe('');
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('POST');
    expect(run.calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}/secret`);
    expect(occurrences(run.stdout, `/fire/${ROTATED_SECRET}`)).toBe(1);
    for (const later of [
      ['triggers', 'get', TRIGGER_ID],
      ['triggers', 'list'],
    ]) {
      const output = await runCli(later, { route });
      expect(output.stdout + output.stderr).not.toContain(ROTATED_SECRET);
    }
  });

  it('exits with the problem code when the server answers trigger_kind_unavailable', async () => {
    const run = await runCli(['triggers', 'create', '--file', '-'], {
      stdin: JSON.stringify({
        kind: 'schedule',
        name: 'nightly',
        agentId: IDS.agent,
        prompt: 'Run it.',
        cron: '0 3 * * *',
        timezone: 'UTC',
      }),
      route: () =>
        json(422, {
          error: { code: 'trigger_kind_unavailable', message: 'Schedules are not available.' },
        }),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('trigger_kind_unavailable');
  });
});
