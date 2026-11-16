import { DEMO_RUN_START_PROBLEM_CODES, demoFallbackReason } from '@indx-workspace/contracts/demo';
import { describe, expect, it } from 'vitest';

import { fixedClock } from '../../../clock';
import { MemoryDemoRunAdmissions } from '../adapters/admissions/memory';
import { MemoryDemoSpend } from '../adapters/spend/memory';
import type { DemoCapSettings } from '../core/rules';
import { createDemoRunGate } from './gate';

const T0 = '2026-11-16T10:00:00.000Z';
const DEMO_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const NEW_DEMO_WORKSPACE = '22222222-2222-4222-8222-222222222222';
const REAL_WORKSPACE = '33333333-3333-4333-8333-333333333333';
const PERSON = '44444444-4444-4444-8444-444444444444';
const OTHER_PERSON = '55555555-5555-4555-8555-555555555555';
const DAY_MS = 24 * 60 * 60 * 1000;

const SETTINGS: DemoCapSettings = {
  runsPerPersonPerDay: 20,
  runsPerClientPerDay: 60,
  maxTurnsPerRun: 8,
  maxCostPerRunUsd: 0.5,
  siteMaxCostPerDayUsd: 30,
};

function rig(overrides: Partial<DemoCapSettings> = {}, siteSpendTtlMs = 0, endsInMs = DAY_MS) {
  const clock = fixedClock(T0);
  const admissions = new MemoryDemoRunAdmissions();
  const spend = new MemoryDemoSpend();
  const gate = createDemoRunGate({
    settings: { ...SETTINGS, ...overrides },
    admissions,
    spend,
    clock,
    siteSpendTtlMs,
    demoExpiresAt: (workspaceId) =>
      Promise.resolve(
        workspaceId === REAL_WORKSPACE ? null : new Date(clock.now().getTime() + endsInMs),
      ),
    // The client is the `x-client` header; no header is the shared bucket.
    clientOf: (headers, limit) => ({ key: headers?.get('x-client') ?? 'shared', limit }),
  });
  const start = (
    input: { workspaceId?: string; userId?: string | null; client?: string; newRun?: boolean } = {},
  ) =>
    gate.refusal({
      workspaceId: input.workspaceId ?? DEMO_WORKSPACE,
      userId: input.userId === undefined ? PERSON : input.userId,
      clientHeaders: new Headers(input.client === undefined ? {} : { 'x-client': input.client }),
      newRun: input.newRun ?? true,
    });
  return { clock, admissions, spend, start };
}

describe('the demo run gate', () => {
  it('never gates a workspace that is not a demo workspace, even with every cap unset', async () => {
    const { start, admissions } = rig({
      maxTurnsPerRun: null,
      maxCostPerRunUsd: null,
      siteMaxCostPerDayUsd: null,
      runsPerPersonPerDay: 1,
    });
    for (let run = 0; run < 5; run += 1) {
      expect(await start({ workspaceId: REAL_WORKSPACE })).toBeNull();
    }
    expect(admissions.count).toBe(0);
  });

  describe('a demo that has ended', () => {
    it.each([
      ['one minute ago', -60_000],
      ['exactly now', 0],
    ])(
      'refuses a new run and a continuation with demo_expired (409) when it ended %s, and records nothing',
      async (_when, endsInMs) => {
        const { start, admissions } = rig({}, 0, endsInMs);
        expect(await start()).toEqual({ code: 'demo_expired' });
        expect(await start({ newRun: false })).toEqual({ code: 'demo_expired' });
        expect(DEMO_RUN_START_PROBLEM_CODES.demo_expired).toBe(409);
        expect(admissions.count).toBe(0);
      },
    );

    it('still admits a run one second before the end', async () => {
      const { start, admissions } = rig({}, 0, 1_000);
      expect(await start()).toBeNull();
      expect(admissions.count).toBe(1);
    });

    it('refuses an ended demo before any cap, even one left unset', async () => {
      const { start } = rig({ maxTurnsPerRun: null }, 0, -1);
      expect(await start()).toEqual({ code: 'demo_expired' });
    });
  });

  describe('a cap left to configuration', () => {
    it.each(['maxTurnsPerRun', 'maxCostPerRunUsd', 'siteMaxCostPerDayUsd'] as const)(
      'refuses every start with demo_caps_unconfigured (503) while %s is unset, and records nothing',
      async (name) => {
        const { start, admissions } = rig({ [name]: null });
        expect(await start()).toEqual({ code: 'demo_caps_unconfigured' });
        expect(DEMO_RUN_START_PROBLEM_CODES.demo_caps_unconfigured).toBe(503);
        expect(admissions.count).toBe(0);
      },
    );
  });

  describe('the site cost of the UTC day', () => {
    it('admits under the cap and refuses at it with demo_site_cost_reached', async () => {
      const { start, spend } = rig();
      spend.addLive(new Date(T0), 29.99);
      expect(await start()).toBeNull();
      spend.addLive(new Date(T0), 0.01);
      expect(await start()).toEqual({ code: 'demo_site_cost_reached' });
    });

    it('counts spend carried from a deleted workspace', async () => {
      const { start, spend } = rig();
      spend.carry('2026-11-16', 30);
      expect(await start()).toEqual({ code: 'demo_site_cost_reached' });
    });

    it("does not count yesterday's spend, and admits again after the UTC midnight", async () => {
      const { start, spend, clock } = rig();
      spend.addLive(new Date('2026-11-16T09:00:00.000Z'), 30);
      expect(await start()).toEqual({ code: 'demo_site_cost_reached' });
      clock.set('2026-11-17T00:00:00.000Z');
      expect(await start()).toBeNull();
    });

    it('refuses when some of the day spend has no price', async () => {
      const { start, spend } = rig();
      spend.addLive(new Date(T0), 0, true);
      expect(await start()).toEqual({ code: 'demo_site_cost_reached' });
    });

    it('fails closed on a sum that is not a number', async () => {
      const { start, spend } = rig();
      spend.addLive(new Date(T0), Number.NaN);
      expect(await start()).toEqual({ code: 'demo_site_cost_reached' });
    });

    it('reads the site spend once for the starts of one minute, not once per start', async () => {
      const { start, spend } = rig({}, 60_000);
      let reads = 0;
      const read = spend.spentOn.bind(spend);
      spend.spentOn = (dayStart) => {
        reads += 1;
        return read(dayStart);
      };
      for (let run = 1; run <= 3; run += 1) await start({ client: `c${String(run)}` });
      expect(reads).toBe(1);
    });

    it('refuses before it counts the start against the person', async () => {
      const { start, spend, admissions } = rig();
      spend.carry('2026-11-16', 30);
      await start();
      expect(admissions.count).toBe(0);
    });

    it('fails closed when the spend cannot be read: the start rejects and records nothing', async () => {
      const { start, spend, admissions } = rig();
      spend.spentOn = () => Promise.reject(new Error('db down'));
      await expect(start()).rejects.toThrow('db down');
      expect(admissions.count).toBe(0);
    });
  });

  describe('a start that is not a new run (an approval continuation, a team child run)', () => {
    it('is not counted, and passes for a person at the cap and a client at its limit', async () => {
      const { start, admissions } = rig({ runsPerPersonPerDay: 1 });
      expect(await start()).toBeNull();
      expect(await start()).toEqual({ code: 'demo_person_runs_reached' });
      expect(await start({ newRun: false })).toBeNull();
      expect(admissions.count).toBe(1);
    });

    it('still meets the site cost', async () => {
      const { start, spend } = rig();
      spend.carry('2026-11-16', 30);
      expect(await start({ newRun: false })).toEqual({ code: 'demo_site_cost_reached' });
    });

    it('is still not gated in a workspace that is not a demo', async () => {
      const { start } = rig();
      expect(await start({ workspaceId: REAL_WORKSPACE, newRun: false })).toBeNull();
    });
  });

  describe('runs per person', () => {
    it('admits the 20th run in 24 hours and refuses the 21st with demo_person_runs_reached', async () => {
      const { start } = rig();
      for (let run = 1; run <= 20; run += 1) {
        expect(await start({ client: `c${String(run)}` })).toBeNull();
      }
      expect(await start({ client: 'c21' })).toEqual({ code: 'demo_person_runs_reached' });
    });

    it('keeps the count when the person comes back in a new demo workspace', async () => {
      const { start } = rig();
      for (let run = 1; run <= 20; run += 1) {
        await start({ client: `c${String(run)}` });
      }
      expect(await start({ workspaceId: NEW_DEMO_WORKSPACE, client: 'c22' })).toEqual({
        code: 'demo_person_runs_reached',
      });
    });

    it('lets the person start again once the oldest run is more than 24 hours old', async () => {
      const { start, clock } = rig({ runsPerPersonPerDay: 1 });
      expect(await start()).toBeNull();
      clock.advance(DAY_MS - 1);
      expect(await start()).toEqual({ code: 'demo_person_runs_reached' });
      // A run exactly 24 hours old still counts; one millisecond older does not.
      clock.advance(1);
      expect(await start()).toEqual({ code: 'demo_person_runs_reached' });
      clock.advance(1);
      expect(await start()).toBeNull();
    });

    it('refuses a start with no person as the person cap and records nothing', async () => {
      const { start, admissions } = rig();
      expect(await start({ userId: null })).toEqual({ code: 'demo_person_runs_reached' });
      expect(admissions.count).toBe(0);
    });
  });

  describe('runs per client address', () => {
    it('counts one address across two accounts and refuses with demo_client_runs_reached', async () => {
      const { start } = rig({ runsPerClientPerDay: 2 });
      expect(await start({ userId: PERSON, client: 'one-address' })).toBeNull();
      expect(await start({ userId: OTHER_PERSON, client: 'one-address' })).toBeNull();
      expect(await start({ userId: PERSON, client: 'one-address' })).toEqual({
        code: 'demo_client_runs_reached',
      });
      expect(await start({ userId: PERSON, client: 'another-address' })).toBeNull();
    });
  });

  it('maps a run stopped at its own per-run cap to the reason the store shows', () => {
    expect(demoFallbackReason('run_budget_reached')).toBe('cost');
    expect(demoFallbackReason('max_turns')).toBe('count');
    expect(demoFallbackReason('completed')).toBeNull();
  });

  it('maps every refusal to the reason the store shows', () => {
    for (const code of Object.keys(DEMO_RUN_START_PROBLEM_CODES)) {
      expect(demoFallbackReason(code)).not.toBeNull();
    }
  });
});
