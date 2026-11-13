/**
 * `testClock` (ADR-0164 T4): a test moves time by hand, and a schedule recipe in `recipeHarness`
 * sees it through the slot it is fired at.
 */
import { describe, expect, it } from 'vitest';

import { enumOf, text } from '../fields/index.js';
import { defineRecipe, schedule, type ScheduleInput } from '../recipe.js';
import { defineResource } from '../resource.js';
import { fakePerson } from './fake-person.js';
import { completed, recipeHarness } from './recipe-harness.js';
import { testClock } from './test-clock.js';

const HOUR_MS = 60 * 60_000;

const tickets = defineResource({
  name: 'ticket',
  fields: {
    title: text({ max: 120 }),
    priority: enumOf(['p1', 'p0'], { default: 'p1' }),
  },
  access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
  agents: { read: true, write: ['priority'] },
});

describe('testClock', () => {
  it('stands still until it is set or advanced', () => {
    const clock = testClock('2026-05-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-05-01T00:00:00.000Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-05-01T00:00:01.500Z');
    clock.set(new Date('2026-04-30T23:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-04-30T23:00:00.000Z');
    expect(testClock().now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('refuses an invalid date and a backward or infinite advance', () => {
    expect(() => testClock('not a date')).toThrow(TypeError);
    const clock = testClock();
    expect(() => clock.set('nope')).toThrow(TypeError);
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('a harness with a clock escalates a breached p1 only after the clock is advanced', async () => {
    const clock = testClock('2026-06-01T09:00:00.000Z');
    let personId = '';
    const slaSweep = defineRecipe({
      name: 'sla-sweep',
      on: schedule('*/5 * * * *', 'UTC'),
      async run({ aw, input, step, store }) {
        const slot = Date.parse((input as ScheduleInput).slot);
        const breached = await step(
          'scan',
          async () =>
            (await store(tickets).list({ where: { priority: 'p1' } })).items
              .filter((row) => slot - Date.parse(row.created_at) > HOUR_MS)
              .map((row) => row.id),
          { actingFor: personId },
        );
        for (const id of breached) {
          await step(
            `escalate.${id}`,
            async () => {
              await aw.runs.start('triage', { prompt: `escalate ${id}` });
              await store(tickets).update(id, { priority: 'p0' });
              return id;
            },
            { actingFor: personId },
          );
        }
      },
    });
    const harness = recipeHarness(slaSweep, { agents: { triage: [completed('ok')] }, clock });
    personId = harness.personId;
    const person = fakePerson({ principalId: harness.personId });
    const ticket = await harness.storeOf(tickets).create(person, { title: 'Printer on fire' });

    expect(await harness.fireSlot()).toMatchObject({ status: 'completed' });
    expect((await harness.storeOf(tickets).get(person, ticket.id)).priority).toBe('p1');

    clock.advance(HOUR_MS + 5 * 60_000);
    expect(await harness.fireSlot()).toMatchObject({ status: 'completed' });
    expect((await harness.storeOf(tickets).get(person, ticket.id)).priority).toBe('p0');
    expect(harness.platformRuns()).toHaveLength(1);
  });
});
