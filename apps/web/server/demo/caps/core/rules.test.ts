import { describe, expect, it } from 'vitest';

import { admissionRefusal, admissionWindowStart, capsUnconfigured, utcDayEnd } from './rules';

const set = {
  runsPerPersonPerDay: 20,
  runsPerClientPerDay: 60,
  maxTurnsPerRun: 8,
  maxCostPerRunUsd: 0.5,
  siteMaxCostPerDayUsd: 30,
};

describe('capsUnconfigured', () => {
  it('is false when every cap is set', () => {
    expect(capsUnconfigured(set)).toBe(false);
  });
  it.each(['maxTurnsPerRun', 'maxCostPerRunUsd', 'siteMaxCostPerDayUsd'] as const)(
    'is true when %s is unset',
    (name) => {
      expect(capsUnconfigured({ ...set, [name]: null })).toBe(true);
    },
  );
});

describe('utcDayEnd', () => {
  it('is the next UTC midnight, whatever the time of day it is given', () => {
    expect(utcDayEnd(new Date('2026-11-16T23:59:59.999Z')).toISOString()).toBe(
      '2026-11-17T00:00:00.000Z',
    );
    expect(utcDayEnd(new Date('2026-11-16T00:00:00.000Z')).toISOString()).toBe(
      '2026-11-17T00:00:00.000Z',
    );
  });
});

describe('the admission window and refusals', () => {
  it('looks back 24 hours', () => {
    expect(admissionWindowStart(new Date('2026-11-16T10:00:00.000Z')).toISOString()).toBe(
      '2026-11-15T10:00:00.000Z',
    );
  });
  it('names the cap that was reached', () => {
    expect(admissionRefusal({ kind: 'person_limit' })).toBe('demo_person_runs_reached');
    expect(admissionRefusal({ kind: 'client_limit' })).toBe('demo_client_runs_reached');
  });
});
