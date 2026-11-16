import { createHash, createHmac, randomUUID } from 'node:crypto';

import { TRIGGER_MAX_BODY_BYTES } from '@indx-workspace/contracts/triggers';
import { describe, expect, it, vi } from 'vitest';

import { PATCH } from '../../app/api/triggers/[id]/route';
import { configureEngineImagesForTests } from '../engines/images';
import { counterIds } from '../ids';
import { MAX_PROMPT_CHARS } from '../runs/service';
import { log } from '../telemetry/logger';

import {
  adminCaller,
  builderCaller,
  installTriggerFixture,
  otherBuilderCaller,
} from './triggers.fixture.test-support';

const fixture = installTriggerFixture();
const { seed, fireRaw, jsonOf } = fixture;

const WRONG_SECRET = 'awcs_live_wrong';

describe('fire: the run it starts', () => {
  it('starts a run as the owner in a new session and answers 202 { run }', async () => {
    const created = await seed(builderCaller);
    const fired = await fireRaw(created.trigger.id, created.secret, { body: '{"a":1}' });
    expect(fired.status).toBe(202);
    const { run } = jsonOf(fired.text) as { run: { id: string } };
    expect(fixture.state.launches).toHaveLength(1);
    expect(fixture.state.launches[0]?.run.id).toBe(run.id);
    expect(fixture.state.launches[0]?.prompt).toBe('Handle this: {"a":1}');
    expect(fixture.state.launches[0]?.principal.ownerPrincipalId).toBe(
      fixture.principalIds[builderCaller.email],
    );
    expect(fixture.state.rows.get(created.trigger.id)?.lastFiredAt).not.toBeNull();
  });
});

describe('fire: run configuration', () => {
  it('starts the run with the trigger output schema, and with none when the trigger has none (ADR-0154)', async () => {
    const sheet = { type: 'object', properties: { verdict: { type: 'string' } } };
    const typed = await seed(builderCaller, { outputSchema: sheet });
    expect((await fireRaw(typed.trigger.id, typed.secret)).status).toBe(202);
    expect(fixture.state.launches[0]?.outputSchema).toEqual(sheet);

    const plain = await seed(builderCaller, { name: 'plain' });
    expect((await fireRaw(plain.trigger.id, plain.secret)).status).toBe(202);
    expect(fixture.state.launches[1]).not.toHaveProperty('outputSchema');
  });

  it('starts the run with the trigger subject, and none when it has none; a body never overrides it (ADR-0156)', async () => {
    const subject = await seed(adminCaller, { subject: 'planner' });
    expect(
      (await fireRaw(subject.trigger.id, subject.secret, { body: '{"subject":"mallory"}' })).status,
    ).toBe(202);
    expect(fixture.state.launches[0]?.subject).toBe('planner');

    const plain = await seed(builderCaller, { name: 'plain' });
    expect(
      (await fireRaw(plain.trigger.id, plain.secret, { body: '{"subject":"eve"}' })).status,
    ).toBe(202);
    expect(fixture.state.launches[1]).not.toHaveProperty('subject');
  });

  it('answers 422 engine_capability_unsupported when the engine cannot honour the schema, and frees the key', async () => {
    const typed = await seed(builderCaller, {
      outputSchema: { type: 'object', properties: { verdict: { type: 'string' } } },
    });
    const headers = { 'idempotency-key': 'needs-schema' };
    const image = (engine: string): string =>
      `registry.example/private-project/runtime-${engine}@sha256:${'c'.repeat(64)}`;
    configureEngineImagesForTests(
      new Map([
        ['claude-agent-sdk', image('claude-agent-sdk')],
        ['pi', image('pi')],
      ]),
    );
    fixture.state.agentEngine = 'pi';
    const refused = await fireRaw(typed.trigger.id, typed.secret, { headers });
    expect(refused.status).toBe(422);
    expect(jsonOf(refused.text)).toMatchObject({
      error: { code: 'engine_capability_unsupported' },
    });
    expect(fixture.state.launches).toHaveLength(0);
    expect(fixture.state.deliveries.has('needs-schema')).toBe(false);

    fixture.state.agentEngine = 'claude-agent-sdk';
    expect((await fireRaw(typed.trigger.id, typed.secret, { headers })).status).toBe(202);
    expect(fixture.state.launches).toHaveLength(1);
  });
});

describe('fire: authorization', () => {
  it('answers the one 404 for a wrong secret, an unknown id, a malformed secret and a disabled trigger', async () => {
    const created = await seed(builderCaller);
    const wrong = await fireRaw(created.trigger.id, WRONG_SECRET);
    const unknown = await fireRaw(randomUUID(), created.secret);
    const malformed = await fireRaw(created.trigger.id, 'x');
    await fixture.harness.call(PATCH, {
      method: 'PATCH',
      path: `/api/triggers/${created.trigger.id}`,
      as: builderCaller,
      id: created.trigger.id,
      body: { enabled: false },
    });
    const disabled = await fireRaw(created.trigger.id, created.secret);
    for (const miss of [wrong, unknown, malformed, disabled]) {
      expect(miss.status).toBe(404);
      expect(jsonOf(miss.text)).toMatchObject({ error: { code: 'trigger_not_found' } });
    }
    expect(wrong.text.replaceAll(created.trigger.id, '')).toBe(
      unknown.text.replaceAll(created.trigger.id, ''),
    );
    expect(fixture.state.deliveries.size).toBe(0);
  });

  it('answers 403 once the owner is revoked, and when the role no longer runs the agent', async () => {
    const created = await seed(builderCaller);
    fixture.state.revoked.add(fixture.principalIds[builderCaller.email] ?? '');
    const revoked = await fireRaw(created.trigger.id, created.secret);
    expect(revoked.status).toBe(403);
    expect(jsonOf(revoked.text)).toMatchObject({ error: { code: 'trigger_owner_not_allowed' } });
    expect(fixture.state.deliveries.size).toBe(0);

    fixture.state.revoked.clear();
    fixture.state.agentOwners.set(
      created.trigger.agentId,
      fixture.principalIds[otherBuilderCaller.email] ?? '',
    );
    const lostAgent = await fireRaw(created.trigger.id, created.secret);
    expect(lostAgent.status).toBe(403);
  });
});

describe('fire: delivery idempotency', () => {
  it('returns the same run for a repeated Idempotency-Key and starts one run', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'delivery-1' };
    const first = await fireRaw(created.trigger.id, created.secret, { body: 'a', headers });
    const again = await fireRaw(created.trigger.id, created.secret, { body: 'a', headers });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(jsonOf(again.text)).toEqual(jsonOf(first.text));
    expect(fixture.state.deliveries.size).toBe(1);
    expect(fixture.state.launches).toHaveLength(1);
  });

  it('dedupes a redelivered body without an Idempotency-Key, as Graph and Zoom retry', async () => {
    const created = await seed(builderCaller);
    const body = '{"value":[{"subscriptionId":"s-1","changeType":"created"}]}';
    const first = await fireRaw(created.trigger.id, created.secret, { body });
    const retry = await fireRaw(created.trigger.id, created.secret, { body });
    expect(retry.status).toBe(202);
    expect(jsonOf(retry.text)).toEqual(jsonOf(first.text));
    expect(fixture.state.launches).toHaveLength(1);
    expect([...fixture.state.deliveries.keys()]).toEqual([
      `body:${createHash('sha256').update(body).digest('hex')}`,
    ]);

    const other = await fireRaw(created.trigger.id, created.secret, { body: '{"value":[]}' });
    expect(jsonOf(other.text)).not.toEqual(jsonOf(first.text));
    const explicit = await fireRaw(created.trigger.id, created.secret, {
      body,
      headers: { 'idempotency-key': 'explicit' },
    });
    expect(jsonOf(explicit.text)).not.toEqual(jsonOf(first.text));
    expect(fixture.state.launches).toHaveLength(3);
  });
});

describe('fire: delivery keys', () => {
  it('gives each empty body without an Idempotency-Key its own auto key, so each starts a run', async () => {
    const created = await seed(builderCaller);
    const first = await fireRaw(created.trigger.id, created.secret, { body: '' });
    const second = await fireRaw(created.trigger.id, created.secret, { body: '' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(fixture.state.launches).toHaveLength(2);
    const keys = [...fixture.state.deliveries.keys()];
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).toMatch(
        /^auto:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("takes an empty body's auto key from the runtime's id generator", async () => {
    fixture.state.ids = counterIds();
    const created = await seed(builderCaller);
    const fired = await fireRaw(created.trigger.id, created.secret, { body: '' });
    expect(fired.status).toBe(202);
    expect([...fixture.state.deliveries.keys()]).toEqual([
      'auto:00000000-0000-4000-8000-000000000001',
    ]);
  });

  it('answers 409 with Retry-After while the first delivery is still starting', async () => {
    const created = await seed(builderCaller);
    fixture.state.deliveries.set('delivery-2', null);
    const pending = await fireRaw(created.trigger.id, created.secret, {
      headers: { 'idempotency-key': 'delivery-2' },
    });
    expect(pending.status).toBe(409);
    expect(pending.headers.get('retry-after')).toBe('1');
  });

  it('rejects an Idempotency-Key longer than 255 characters', async () => {
    const created = await seed(builderCaller);
    const response = await fireRaw(created.trigger.id, created.secret, {
      headers: { 'idempotency-key': 'k'.repeat(256) },
    });
    expect(response.status).toBe(400);
  });
});

describe('fire: provider handshakes', () => {
  it('echoes a Graph validationToken as 200 text/plain without starting a run', async () => {
    const created = await seed(builderCaller);
    const echoed = await fireRaw(created.trigger.id, created.secret, {
      query: '?validationToken=abc%20123',
    });
    expect(echoed.status).toBe(200);
    expect(echoed.text).toBe('abc 123');
    expect(echoed.headers.get('content-type')).toContain('text/plain');
    expect(fixture.state.deliveries.size).toBe(0);
    const wrongSecret = await fireRaw(created.trigger.id, WRONG_SECRET, {
      query: '?validationToken=abc',
    });
    expect(wrongSecret.status).toBe(404);
  });

  it('answers a Zoom endpoint.url_validation with the HMAC of the plain token', async () => {
    const created = await seed(builderCaller, { zoomSecretToken: 'zoom-app-secret' });
    const answered = await fireRaw(created.trigger.id, created.secret, {
      body: JSON.stringify({
        event: 'endpoint.url_validation',
        payload: { plainToken: 'plain-1' },
      }),
    });
    expect(answered.status).toBe(200);
    expect(jsonOf(answered.text)).toEqual({
      plainToken: 'plain-1',
      encryptedToken: createHmac('sha256', 'zoom-app-secret').update('plain-1').digest('hex'),
    });
    expect(fixture.state.deliveries.size).toBe(0);
  });

  it('answers 422 to a Zoom validation when no Zoom token is stored', async () => {
    const created = await seed(builderCaller);
    const answered = await fireRaw(created.trigger.id, created.secret, {
      body: JSON.stringify({ event: 'endpoint.url_validation', payload: { plainToken: 'p' } }),
    });
    expect(answered.status).toBe(422);
    expect(jsonOf(answered.text)).toMatchObject({ error: { code: 'trigger_zoom_not_configured' } });
  });
});

describe('fire: limits', () => {
  it('refuses a body over 256 KiB with 413', async () => {
    const created = await seed(builderCaller);
    const response = await fireRaw(created.trigger.id, created.secret, {
      body: 'x'.repeat(TRIGGER_MAX_BODY_BYTES + 1),
    });
    expect(response.status).toBe(413);
    expect(fixture.state.deliveries.size).toBe(0);
  });

  it('answers 429 over 30 firings a minute and frees the claim so the key can retry', async () => {
    const created = await seed(builderCaller);
    fixture.state.recentDeliveries = 31;
    const limited = await fireRaw(created.trigger.id, created.secret, {
      headers: { 'idempotency-key': 'burst' },
    });
    expect(limited.status).toBe(429);
    expect(jsonOf(limited.text)).toMatchObject({ error: { code: 'trigger_rate_limited' } });
    expect(limited.headers.get('retry-after')).toBe('60');
    expect(fixture.state.deliveries.has('burst')).toBe(false);
  });

  it('answers 429 with three runs unfinished', async () => {
    const created = await seed(builderCaller);
    fixture.state.unfinishedRuns = 3;
    const limited = await fireRaw(created.trigger.id, created.secret);
    expect(limited.status).toBe(429);
    expect(jsonOf(limited.text)).toMatchObject({ error: { code: 'trigger_concurrency_limited' } });
    expect(fixture.state.deliveries.size).toBe(0);
  });

  it('answers 413 when the prompt with the body exceeds the run prompt limit, starting no run', async () => {
    const created = await seed(builderCaller);
    const response = await fireRaw(created.trigger.id, created.secret, {
      body: 'x'.repeat(MAX_PROMPT_CHARS),
    });
    expect(response.status).toBe(413);
    expect(jsonOf(response.text)).toMatchObject({ error: { code: 'trigger_prompt_too_long' } });
    expect(fixture.state.deliveries.size).toBe(0);
    expect(fixture.state.launches).toHaveLength(0);
  });
});

describe('fire: start failure recovery', () => {
  it('frees the claim when the run start is refused or the agent is gone, so the key can fire again', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'refused' };
    fixture.state.refuseStart = true;
    const refused = await fireRaw(created.trigger.id, created.secret, { headers });
    expect(refused.status).toBe(422);
    expect(jsonOf(refused.text)).toMatchObject({
      error: { code: 'agent_runtime_profile_missing' },
    });
    expect(fixture.state.deliveries.has('refused')).toBe(false);

    fixture.state.refuseStart = false;
    fixture.state.agentGone = true;
    const gone = await fireRaw(created.trigger.id, created.secret, { headers });
    expect(gone.status).toBe(403);
    expect(jsonOf(gone.text)).toMatchObject({ error: { code: 'trigger_owner_not_allowed' } });
    expect(fixture.state.deliveries.has('refused')).toBe(false);

    fixture.state.agentGone = false;
    expect((await fireRaw(created.trigger.id, created.secret, { headers })).status).toBe(202);
    expect(fixture.state.launches).toHaveLength(1);
  });

  it('keeps the claim when recording a started run fails, so a retry starts no second run', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'recorded' };
    fixture.state.failRecordRun = true;
    await expect(fireRaw(created.trigger.id, created.secret, { headers })).rejects.toThrow(
      'database unavailable',
    );
    expect(fixture.state.launches).toHaveLength(1);
    expect(fixture.state.deliveries.has('recorded')).toBe(true);

    fixture.state.failRecordRun = false;
    const retry = await fireRaw(created.trigger.id, created.secret, { headers });
    expect(retry.status).toBe(409);
    expect(fixture.state.launches).toHaveLength(1);
  });

  it('logs a failed claim release with its cause and still throws the start failure', async () => {
    const created = await seed(builderCaller);
    const headers = { 'idempotency-key': 'stuck' };
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    fixture.state.failStart = true;
    fixture.state.failRelease = true;
    await expect(fireRaw(created.trigger.id, created.secret, { headers })).rejects.toThrow(
      'start unavailable',
    );
    expect(fixture.state.deliveries.get('stuck')).toBeNull();
    expect(logged).toHaveBeenCalledWith(
      expect.stringContaining('could not release its delivery claim'),
      expect.objectContaining({
        error: expect.objectContaining({ message: 'release unavailable' }) as unknown,
      }),
    );
    logged.mockRestore();
  });
});
