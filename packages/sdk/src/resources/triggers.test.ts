import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ApiProblemError, ContractViolationError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { TriggersClient } from './triggers.js';

const TRIGGER_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '22222222-2222-4222-8222-222222222222';
const SECRET = 'awts_live_AbCdEfGhIjKlMnOpQrStUv0123456789';

const trigger = {
  id: TRIGGER_ID,
  name: 'inbox-triage',
  kind: 'webhook',
  agentId: AGENT_ID,
  prompt: 'Triage this: {{body}}',
  cron: null,
  timezone: null,
  enabled: true,
  outputSchema: null,
  subject: null,
  ownerPrincipalId: '33333333-3333-4333-8333-333333333333',
  hasSecret: true,
  hasZoomSecretToken: false,
  lastFiredAt: null,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
};

const secretAnswer = {
  trigger,
  secret: SECRET,
  firePath: `/api/triggers/${TRIGGER_ID}/fire/${SECRET}`,
  warning: 'Store this URL now; the secret is not shown again.',
};

function client(route: (request: RecordedRequest) => Response | Promise<Response>): {
  readonly triggers: TriggersClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble(route);
  const http = new HttpClient({
    baseUrl: 'https://aw.example.com',
    auth: { kind: 'api-key', apiKey: 'ak_live_k' },
    fetch: api.fetch,
  });
  return { triggers: new TriggersClient(http), calls: api.calls };
}

describe('TriggersClient', () => {
  it('lists and unwraps the envelope', async () => {
    const { triggers, calls } = client(() => json(200, { triggers: [trigger] }));
    expect(await triggers.list()).toEqual([trigger]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url.href).toBe('https://aw.example.com/api/triggers');
  });

  it('gets one trigger by an encoded id', async () => {
    const { triggers, calls } = client(() => json(200, { trigger }));
    expect(await triggers.get('a/b')).toEqual(trigger);
    expect(calls[0]?.url.pathname).toBe('/api/triggers/a%2Fb');
  });

  it('creates with the body as given, expects 201 and returns the secret and fire path', async () => {
    const { triggers, calls } = client(() => json(201, secretAnswer));
    const input = {
      kind: 'webhook',
      name: 'inbox-triage',
      agentId: AGENT_ID,
      prompt: 'Triage this: {{body}}',
    } as const;
    const answer = await triggers.create(input);
    expect('secret' in answer && answer.secret).toBe(SECRET);
    expect('firePath' in answer && answer.firePath).toBe(
      `/api/triggers/${TRIGGER_ID}/fire/${SECRET}`,
    );
    expect(answer.trigger).toEqual(trigger);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe('/api/triggers');
    expect(calls[0]?.json).toEqual(input);
  });

  it('sends a Zod outputSchema as JSON Schema, a JSON Schema as given, and null to clear (ADR-0154)', async () => {
    const { triggers, calls } = client(() => json(201, secretAnswer));
    const base = {
      kind: 'webhook',
      name: 'inbox-triage',
      agentId: AGENT_ID,
      prompt: 'Triage this: {{body}}',
    } as const;
    await triggers.create({ ...base, outputSchema: z.object({ verdict: z.string() }) });
    expect(calls[0]?.json).toMatchObject({
      outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { verdict: { type: 'string' } },
      },
    });
    const sheet = { type: 'object', properties: { verdict: { type: 'string' } } };
    await triggers.create({ ...base, outputSchema: sheet });
    expect(calls[1]?.json).toEqual({ ...base, outputSchema: sheet });
    const patched = client(() => json(200, { trigger }));
    await patched.triggers.update(TRIGGER_ID, { outputSchema: null });
    expect(patched.calls[0]?.json).toEqual({ outputSchema: null });
  });

  it('sends the run subject on create and update, and null to clear it (ADR-0156)', async () => {
    const { triggers, calls } = client(() => json(201, secretAnswer));
    await triggers.create({
      kind: 'webhook',
      name: 'inbox-triage',
      agentId: AGENT_ID,
      prompt: 'Triage this: {{body}}',
      subject: 'planner',
    });
    expect(calls[0]?.json).toMatchObject({ subject: 'planner' });
    const patched = client(() => json(200, { trigger }));
    await patched.triggers.update(TRIGGER_ID, { subject: null });
    expect(patched.calls[0]?.json).toEqual({ subject: null });
  });

  it('updates with PATCH', async () => {
    const { triggers, calls } = client(() => json(200, { trigger }));
    expect(await triggers.update(TRIGGER_ID, { enabled: false })).toEqual(trigger);
    expect(calls[0]?.method).toBe('PATCH');
    expect(calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}`);
    expect(calls[0]?.json).toEqual({ enabled: false });
  });

  it('removes with DELETE and returns the trigger from the 200 body', async () => {
    const { triggers, calls } = client(() => json(200, { trigger }));
    expect(await triggers.remove(TRIGGER_ID)).toEqual(trigger);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}`);
  });

  it('rotates the secret with an empty POST and returns the whole answer', async () => {
    const { triggers, calls } = client(() => json(201, secretAnswer));
    expect(await triggers.rotateSecret(TRIGGER_ID)).toEqual(secretAnswer);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.pathname).toBe(`/api/triggers/${TRIGGER_ID}/secret`);
    expect(calls[0]?.json).toBeUndefined();
  });

  it('surfaces a 404 from get as trigger_not_found', async () => {
    const { triggers } = client(() =>
      json(404, { error: { code: 'trigger_not_found', message: 'No.' } }),
    );
    const failure = await triggers.get(TRIGGER_ID).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe('trigger_not_found');
  });

  it('creates a schedule trigger: the answer is just the trigger, with no secret', async () => {
    const schedule = { ...trigger, kind: 'schedule', cron: '0 9 1 * *', timezone: 'Asia/Tokyo' };
    const { triggers, calls } = client(() => json(201, { trigger: schedule }));
    const input = {
      kind: 'schedule',
      name: 'inbox-triage',
      agentId: AGENT_ID,
      prompt: 'Consolidate the month.',
      cron: '0 9 1 * *',
      timezone: 'Asia/Tokyo',
    } as const;
    const answer = await triggers.create(input);
    expect(answer).toEqual({ trigger: schedule });
    expect('secret' in answer).toBe(false);
    expect(calls[0]?.json).toEqual(input);
  });

  it('surfaces a 409 from create as trigger_name_taken', async () => {
    const code = 'trigger_name_taken';
    const { triggers } = client(() => json(409, { error: { code, message: 'No.' } }));
    const failure = await triggers
      .create({ kind: 'webhook', name: 'x', agentId: AGENT_ID, prompt: 'p' })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiProblemError);
    expect((failure as ApiProblemError).code).toBe(code);
  });

  it('rejects a trigger carrying an unknown key such as a leaked secret hash', async () => {
    const { triggers } = client(() =>
      json(200, { trigger: { ...trigger, secretHash: 'deadbeef' } }),
    );
    await expect(triggers.get(TRIGGER_ID)).rejects.toBeInstanceOf(ContractViolationError);
  });

  it('rejects a create answer carrying an unknown key', async () => {
    const { triggers } = client(() => json(201, { ...secretAnswer, secretHash: 'deadbeef' }));
    await expect(
      triggers.create({ kind: 'webhook', name: 'x', agentId: AGENT_ID, prompt: 'p' }),
    ).rejects.toBeInstanceOf(ContractViolationError);
  });
});
