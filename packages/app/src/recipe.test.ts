import { DefinitionError } from '@indx-workspace/sdk/define';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  defineRecipe,
  isDefinedRecipe,
  resourceEvent,
  schedule,
  STEP_KEY_PATTERN,
  type RecipeInput,
} from './index.js';

/** Calls `defineRecipe` with a value the types would refuse, returning what it threw. */
function refusal(input: unknown): DefinitionError {
  try {
    defineRecipe(input as RecipeInput<unknown>);
  } catch (error) {
    if (error instanceof DefinitionError) return error;
    throw error;
  }
  throw new Error('defineRecipe accepted the input');
}

const run = (): Promise<void> => Promise.resolve();

describe('defineRecipe', () => {
  it('lists every reason at once: the name, the cron, the time zone and run', () => {
    const error = refusal({
      name: 'Triage Incident',
      on: schedule('every minute', 'Mars/Olympus'),
      run: 'not a function',
    });
    expect(error.code).toBe('invalid_definition');
    expect(error.issues.map((issue) => issue.path).sort()).toEqual([
      'name',
      'on.cron',
      'on.timezone',
      'run',
    ]);
  });

  it('refuses a cron croner rejects, one with six fields, and an unknown key', () => {
    expect(refusal({ name: 'a', on: schedule('61 * * * *'), run }).issues[0]?.path).toBe('on.cron');
    expect(refusal({ name: 'a', on: schedule('0 0 * * * *'), run }).issues[0]?.message).toContain(
      'five fields',
    );
    expect(
      refusal({ name: 'a', on: resourceEvent('ticket', 'created'), run, inputs: z.object({}) })
        .issues[0]?.message,
    ).toContain('did you mean "input"?');
  });

  it('refuses an event that is not created, updated or deleted, and a non-Zod input', () => {
    const error = refusal({
      name: 'a',
      on: { kind: 'resourceEvent', resource: 'ticket', event: 'archived' },
      input: { parse: () => ({}) },
      run,
    });
    expect(error.issues.map((issue) => issue.path).sort()).toEqual(['input', 'on.event']);
  });

  it('builds the trigger shapes, the schedule in UTC unless told otherwise', () => {
    expect(resourceEvent('ticket', 'updated')).toEqual({
      kind: 'resourceEvent',
      resource: 'ticket',
      event: 'updated',
    });
    expect(schedule('0 9 * * 1')).toEqual({ kind: 'schedule', cron: '0 9 * * 1', timezone: 'UTC' });
    expect(schedule('0 9 * * 1', 'Asia/Tokyo').timezone).toBe('Asia/Tokyo');
  });

  it('returns a frozen, branded recipe that keeps its input schema', () => {
    const input = z.object({ ticketId: z.string() });
    const recipe = defineRecipe({
      name: 'triage-incident',
      on: resourceEvent('ticket', 'created'),
      input,
      run,
    });
    expect(isDefinedRecipe(recipe)).toBe(true);
    expect(isDefinedRecipe({ ...recipe })).toBe(false);
    expect(Object.isFrozen(recipe)).toBe(true);
    expect(recipe.input).toBe(input);
    expect(defineRecipe({ name: 'digest', on: schedule('0 9 * * *'), run }).input).toBeNull();
  });

  it('documents the step key grammar', () => {
    expect(STEP_KEY_PATTERN.test('triage.1')).toBe(true);
    expect(STEP_KEY_PATTERN.test('Triage')).toBe(false);
    expect(STEP_KEY_PATTERN.test('a'.repeat(65))).toBe(false);
  });
});
