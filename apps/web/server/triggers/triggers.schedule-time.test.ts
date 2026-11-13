import { type TriggerResource } from '@indx-workspace/contracts/triggers';
import { describe, expect, it } from 'vitest';

import { PATCH } from '../../app/api/triggers/[id]/route';

import {
  builderCaller,
  installTriggerFixture,
  viewerCaller,
} from './triggers.fixture.test-support';

const fixture = installTriggerFixture();

const patchAs = (caller: { email: string }, id: string, body: unknown) =>
  fixture.harness.call(PATCH, {
    method: 'PATCH',
    path: `/api/triggers/${id}`,
    as: caller,
    id,
    body,
  });

async function schedule(): Promise<TriggerResource> {
  const { trigger } = await fixture.seed(builderCaller, {
    kind: 'schedule',
    name: 'morning-brief',
    prompt: 'Brief me on what changed overnight.',
    cron: '0 9 * * *',
    timezone: 'UTC',
  });
  return trigger;
}

const stored = (id: string) => fixture.state.rows.get(id);

describe("changing a schedule's time (ADR-0144 D5)", () => {
  it('re-times a schedule in place: cron, time zone, or both', async () => {
    const trigger = await schedule();
    expect((await patchAs(builderCaller, trigger.id, { cron: '30 8 * * 1-5' })).body).toMatchObject(
      {
        trigger: { cron: '30 8 * * 1-5', timezone: 'UTC' },
      },
    );
    expect(
      (await patchAs(builderCaller, trigger.id, { timezone: 'Asia/Tokyo' })).body,
    ).toMatchObject({ trigger: { cron: '30 8 * * 1-5', timezone: 'Asia/Tokyo' } });
    expect(
      (await patchAs(builderCaller, trigger.id, { cron: '0 7 * * *', timezone: 'Europe/Paris' }))
        .body,
    ).toMatchObject({ trigger: { cron: '0 7 * * *', timezone: 'Europe/Paris' } });
  });

  it('restarts counting on a new time, and not on a change that keeps the time', async () => {
    const trigger = await schedule();
    expect(stored(trigger.id)?.scheduleFrom).toBeNull();
    await patchAs(builderCaller, trigger.id, { prompt: 'Brief me, please.' });
    expect(stored(trigger.id)?.scheduleFrom).toBeNull();
    await patchAs(builderCaller, trigger.id, { cron: '0 9 * * *' });
    expect(stored(trigger.id)?.scheduleFrom).toBeNull();
    await patchAs(builderCaller, trigger.id, { cron: '15 9 * * *' });
    expect(stored(trigger.id)?.scheduleFrom).toBeInstanceOf(Date);
  });

  it('refuses an expression or time zone the scheduler cannot use, changing nothing', async () => {
    const trigger = await schedule();
    for (const body of [
      { cron: '0 9 * *' },
      { cron: '0 9 * * * *' },
      { cron: 'every morning at nine' },
      { timezone: 'Mars/Olympus' },
      { cron: '0 0 31 2 *' },
    ]) {
      const response = await patchAs(builderCaller, trigger.id, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'invalid_field' } });
    }
    expect(stored(trigger.id)).toMatchObject({ cron: '0 9 * * *', timezone: 'UTC' });
  });

  it('refuses a cron or time zone on a webhook trigger with a typed 400', async () => {
    const { trigger } = await fixture.seed(builderCaller, { name: 'inbox' });
    for (const body of [{ cron: '0 9 * * *' }, { timezone: 'UTC' }]) {
      const response = await patchAs(builderCaller, trigger.id, body);
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ error: { code: 'invalid_field' } });
      expect(JSON.stringify(response.body)).toContain('only a schedule trigger');
    }
    expect(stored(trigger.id)).toMatchObject({ cron: null, timezone: null });
  });

  it('keeps the same access rule as every other field: a Viewer cannot re-time a schedule', async () => {
    const trigger = await schedule();
    const response = await patchAs(viewerCaller, trigger.id, { cron: '0 10 * * *' });
    expect(response.status).toBe(403);
    expect(stored(trigger.id)).toMatchObject({ cron: '0 9 * * *' });
  });
});
