/**
 * The pure half of schedule triggers (issue #1294): `nextFireAt` across DST and a zone with none,
 * the validation `POST /api/triggers` runs, and which trigger owes a run now. Every expectation is
 * an exact UTC instant.
 */
import { describe, expect, it } from 'vitest';

import { dueSlot, findScheduleError, nextFireAt } from './schedule';

const next = (cron: string, timezone: string, after: string): string | undefined =>
  nextFireAt(cron, timezone, new Date(after))?.toISOString();

describe('nextFireAt', () => {
  it.each([
    // [name, cron, timezone, after, next]
    [
      'Tokyo has no DST: 09:00 on the 1st is 00:00Z',
      '0 9 1 * *',
      'Asia/Tokyo',
      '2026-10-18T00:00:00Z',
      '2026-11-01T00:00:00.000Z',
    ],
    [
      'Tokyo: the slot itself is excluded',
      '0 9 1 * *',
      'Asia/Tokyo',
      '2026-11-01T00:00:00Z',
      '2026-12-01T00:00:00.000Z',
    ],
    [
      'UTC: every five minutes',
      '*/5 * * * *',
      'UTC',
      '2026-10-18T00:07:30Z',
      '2026-10-18T00:10:00.000Z',
    ],
    [
      'New York, before spring forward: EST is UTC-5',
      '30 2 * * *',
      'America/New_York',
      '2026-03-07T12:00:00Z',
      '2026-03-08T07:30:00.000Z',
    ],
    [
      'New York, 02:30 does not exist on 2026-03-08: it runs at 03:30 EDT',
      '30 2 * * *',
      'America/New_York',
      '2026-03-08T00:00:00Z',
      '2026-03-08T07:30:00.000Z',
    ],
    [
      'New York, the day after spring forward: EDT is UTC-4',
      '30 2 * * *',
      'America/New_York',
      '2026-03-08T08:00:00Z',
      '2026-03-09T06:30:00.000Z',
    ],
    [
      'New York, 01:30 happens twice on 2026-11-01: the first is taken',
      '30 1 * * *',
      'America/New_York',
      '2026-11-01T00:00:00Z',
      '2026-11-01T05:30:00.000Z',
    ],
    [
      'New York, the repeated 01:30 EST is not a second slot',
      '30 1 * * *',
      'America/New_York',
      '2026-11-01T05:30:00Z',
      '2026-11-02T06:30:00.000Z',
    ],
    [
      'London, the day before clocks go forward: GMT',
      '0 1 * * *',
      'Europe/London',
      '2026-03-28T12:00:00Z',
      '2026-03-29T01:00:00.000Z',
    ],
    [
      'London, 01:00 does not exist on 2026-03-29: it runs at 02:00 BST',
      '0 1 * * *',
      'Europe/London',
      '2026-03-29T00:00:00Z',
      '2026-03-29T01:00:00.000Z',
    ],
    [
      'London, in summer: BST is UTC+1',
      '0 9 * * *',
      'Europe/London',
      '2026-07-01T00:00:00Z',
      '2026-07-01T08:00:00.000Z',
    ],
  ])('%s', (_name, cron, timezone, after, expected) => {
    expect(next(cron, timezone, after)).toBe(expected);
  });

  it('is null for a date that never exists', () => {
    expect(nextFireAt('0 0 31 2 *', 'UTC', new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('findScheduleError', () => {
  it.each([
    ['five fields', '0 9 1 * *', 'Asia/Tokyo'],
    ['a step and a list', '*/15 8-17 * * 1,3,5', 'America/New_York'],
    ['UTC', '0 0 * * *', 'UTC'],
  ])('accepts %s', (_name, cron, timezone) => {
    expect(findScheduleError(cron, timezone)).toBeNull();
  });

  it.each([
    ['six fields (seconds)', '0 0 9 1 * *', 'UTC'],
    ['four fields', '0 9 * *', 'UTC'],
    ['a nickname', '@daily', 'UTC'],
    ['an out-of-range minute', '61 * * * *', 'UTC'],
    ['a date that never exists', '0 0 31 2 *', 'UTC'],
    ['an unknown time zone', '0 0 * * *', 'Mars/Olympus'],
  ])('refuses %s', (_name, cron, timezone) => {
    expect(findScheduleError(cron, timezone)).toEqual(expect.any(String));
  });
});

describe('dueSlot', () => {
  const trigger = {
    kind: 'schedule',
    enabled: true,
    cron: '0 9 * * *',
    timezone: 'Asia/Tokyo',
    lastFiredAt: null,
    scheduleFrom: null,
    createdAt: new Date('2026-10-17T00:00:00Z'),
  } as const;

  it('is the first slot after the last firing once it has passed', () => {
    expect(dueSlot(trigger, new Date('2026-10-18T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-18T00:00:00.000Z',
    );
    expect(dueSlot(trigger, new Date('2026-10-17T23:59:59Z'))).toBeNull();
  });

  it('counts from the last firing rather than from creation', () => {
    const fired = { ...trigger, lastFiredAt: new Date('2026-10-18T00:03:00Z') };
    expect(dueSlot(fired, new Date('2026-10-18T12:00:00Z'))).toBeNull();
    expect(dueSlot(fired, new Date('2026-10-19T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-19T00:00:00.000Z',
    );
  });

  it('owes nothing for the windows before the schedule was re-enabled or re-timed', () => {
    // Disabled for ten days, enabled again at 12:00 UTC on the 27th: the next slot is the 28th's.
    const restarted = { ...trigger, scheduleFrom: new Date('2026-10-27T12:00:00Z') };
    expect(dueSlot(restarted, new Date('2026-10-27T12:01:00Z'))).toBeNull();
    expect(dueSlot(restarted, new Date('2026-10-28T00:00:00Z'))?.toISOString()).toBe(
      '2026-10-28T00:00:00.000Z',
    );
    // A later firing counts again once it is past the restart.
    const firedSince = { ...restarted, lastFiredAt: new Date('2026-10-28T00:01:00Z') };
    expect(dueSlot(firedSince, new Date('2026-10-28T12:00:00Z'))).toBeNull();
  });

  it('is null for a disabled trigger, a webhook and a schedule missing its cron', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    expect(dueSlot({ ...trigger, enabled: false }, now)).toBeNull();
    expect(dueSlot({ ...trigger, kind: 'webhook' }, now)).toBeNull();
    expect(dueSlot({ ...trigger, cron: null }, now)).toBeNull();
    expect(dueSlot({ ...trigger, timezone: null }, now)).toBeNull();
  });
});
