import { describe, expect, it } from 'vitest';

import type { DemoRunAdmissions } from '../../ports';

const T0 = new Date('2026-11-16T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const since = (now: Date) => new Date(now.getTime() - DAY_MS);

export interface AdmissionsRig {
  readonly admissions: DemoRunAdmissions;
  /** A person known to the store (the table references users). */
  readonly person: () => Promise<string>;
}

const admit = (
  rig: AdmissionsRig,
  input: {
    readonly userId: string;
    readonly clientKey?: string;
    readonly now?: Date;
    readonly personLimit?: number;
    readonly clientLimit?: number;
  },
) =>
  rig.admissions.admit({
    userId: input.userId,
    clientKey: input.clientKey ?? 'client-a',
    now: input.now ?? T0,
    since: since(input.now ?? T0),
    personLimit: input.personLimit ?? 20,
    clientLimit: input.clientLimit ?? 60,
  });

/** The behaviour the memory and the PostgreSQL admissions must share. */
export function describeDemoRunAdmissionsConformance(
  label: string,
  make: () => Promise<AdmissionsRig>,
) {
  describe(`DemoRunAdmissions: ${label}`, () => {
    it('admits a person up to their limit and refuses the next, and the limit is the 20th and 21st', async () => {
      const rig = await make();
      const userId = await rig.person();
      for (let run = 1; run <= 20; run += 1) {
        expect(await admit(rig, { userId, clientKey: `c${String(run)}` })).toEqual({
          kind: 'admitted',
        });
      }
      expect(await admit(rig, { userId, clientKey: 'c21' })).toEqual({ kind: 'person_limit' });
    });

    it('counts a person across client addresses and a client across people', async () => {
      const rig = await make();
      const [a, b] = [await rig.person(), await rig.person()];
      expect(await admit(rig, { userId: a, clientKey: 'shared', clientLimit: 2 })).toEqual({
        kind: 'admitted',
      });
      expect(await admit(rig, { userId: b, clientKey: 'shared', clientLimit: 2 })).toEqual({
        kind: 'admitted',
      });
      expect(await admit(rig, { userId: a, clientKey: 'shared', clientLimit: 2 })).toEqual({
        kind: 'client_limit',
      });
      // The person's own count stands whichever address they come from.
      expect(await admit(rig, { userId: a, clientKey: 'other', personLimit: 1 })).toEqual({
        kind: 'person_limit',
      });
    });

    it('names the person limit first when both are reached', async () => {
      const rig = await make();
      const userId = await rig.person();
      await admit(rig, { userId });
      expect(await admit(rig, { userId, personLimit: 1, clientLimit: 1 })).toEqual({
        kind: 'person_limit',
      });
    });

    it('records nothing for a refused attempt', async () => {
      const rig = await make();
      const userId = await rig.person();
      await admit(rig, { userId, personLimit: 1 });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(await admit(rig, { userId, personLimit: 1 })).toEqual({ kind: 'person_limit' });
      }
      // Were refusals recorded, a raised limit of 2 would still be refused.
      expect(await admit(rig, { userId, personLimit: 2 })).toEqual({ kind: 'admitted' });
    });

    it('counts only the last 24 hours: an admission at the window start still counts, an older one does not', async () => {
      const rig = await make();
      const userId = await rig.person();
      await admit(rig, { userId, now: new Date(T0.getTime() - DAY_MS - 1) });
      const next = await admit(rig, { userId, personLimit: 1 });
      expect(next).toEqual({ kind: 'admitted' });
      const edge = await rig.person();
      await admit(rig, { userId: edge, now: new Date(T0.getTime() - DAY_MS) });
      expect(await admit(rig, { userId: edge, personLimit: 1 })).toEqual({ kind: 'person_limit' });
    });

    it('admits exactly one of many concurrent calls at the last place', async () => {
      const rig = await make();
      const userId = await rig.person();
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => admit(rig, { userId, clientKey: 'race', personLimit: 1 })),
      );
      expect(outcomes.filter((outcome) => outcome.kind === 'admitted')).toHaveLength(1);
    });

    it('counts what admit counts: the person own admissions in the window, refusals not included', async () => {
      const rig = await make();
      const [a, b] = [await rig.person(), await rig.person()];
      expect(await rig.admissions.countSince(a, since(T0))).toBe(0);
      await admit(rig, { userId: a, personLimit: 2 });
      await admit(rig, { userId: a, personLimit: 2 });
      await admit(rig, { userId: a, personLimit: 2 });
      await admit(rig, { userId: b });
      await admit(rig, { userId: a, now: new Date(T0.getTime() - DAY_MS - 1), personLimit: 9 });
      expect(await rig.admissions.countSince(a, since(T0))).toBe(2);
      expect(await rig.admissions.countSince(b, since(T0))).toBe(1);
    });
  });
}
