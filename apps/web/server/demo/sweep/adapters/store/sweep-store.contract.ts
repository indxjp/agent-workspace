import { describe, expect, it } from 'vitest';

import type { DemoSweepStore } from '../../ports';

const HOUR_MS = 60 * 60 * 1000;
const T0 = new Date('2026-11-16T10:00:00.000Z');
const at = (hours: number) => new Date(T0.getTime() + hours * HOUR_MS);

/** A fresh store and the ways to put rows behind it and read back what is left, in either adapter's terms. */
export interface SweepStoreRig {
  readonly store: DemoSweepStore;
  /** A workspace; `demoExpiresAt: null` is a real one. Its usage rows are carried when it is deleted. */
  readonly addWorkspace: (input: {
    readonly demoExpiresAt: Date | null;
    readonly usage?: readonly {
      readonly at: Date;
      readonly costUsd: number;
      readonly unpriced?: boolean;
    }[];
  }) => Promise<string>;
  readonly hasWorkspace: (id: string) => Promise<boolean>;
  /** What deleted workspaces carried into the day totals: `[day, costUsd, unpriced]`. */
  readonly carried: () => Promise<readonly (readonly [string, number, boolean])[]>;
  readonly addLoginToken: (expiresAt: Date, usedAt?: Date) => Promise<void>;
  readonly loginTokenCount: () => Promise<number>;
  readonly addAdmission: (at: Date) => Promise<void>;
  readonly admissionCount: () => Promise<number>;
  /**
   * A guest user created at `createdAt`. `holds` is what still references it: a membership in a
   * workspace, or an admission made at `admittedAt`; nothing by default. `lead: false` makes a user
   * no email link signed in (its address is no lead), such as one an administrator created.
   */
  readonly addGuestUser: (input: {
    readonly createdAt: Date;
    readonly holds?: 'membership' | { readonly admittedAt: Date };
    readonly lead?: boolean;
  }) => Promise<string>;
  readonly hasUser: (id: string) => Promise<boolean>;
}

/** The behaviour the memory and the PostgreSQL sweep stores must share. */
export function describeDemoSweepStoreConformance(
  label: string,
  make: () => Promise<SweepStoreRig>,
) {
  describe(`DemoSweepStore: ${label}`, () => {
    it('lists the demo workspaces at or past their end, oldest first, and never a real one', async () => {
      const rig = await make();
      const later = await rig.addWorkspace({ demoExpiresAt: at(-1) });
      const earlier = await rig.addWorkspace({ demoExpiresAt: at(-2) });
      const atEnd = await rig.addWorkspace({ demoExpiresAt: T0 });
      const before = await rig.addWorkspace({ demoExpiresAt: at(1) });
      const real = await rig.addWorkspace({ demoExpiresAt: null });
      const ids = await rig.store.expiredWorkspaceIds(T0, 100);
      expect(ids).toEqual([earlier, later, atEnd]);
      expect(ids).not.toContain(before);
      expect(ids).not.toContain(real);
      expect(await rig.store.expiredWorkspaceIds(T0, 2)).toEqual([earlier, later]);
    });

    it('deletes a workspace at its end and after it, and keeps one before it', async () => {
      const rig = await make();
      const atEnd = await rig.addWorkspace({ demoExpiresAt: T0 });
      const after = await rig.addWorkspace({ demoExpiresAt: at(-5) });
      const before = await rig.addWorkspace({ demoExpiresAt: at(1) });
      expect(await rig.store.deleteExpiredWorkspace(atEnd, T0)).toBe(true);
      expect(await rig.store.deleteExpiredWorkspace(after, T0)).toBe(true);
      expect(await rig.store.deleteExpiredWorkspace(before, T0)).toBe(false);
      expect(await rig.hasWorkspace(atEnd)).toBe(false);
      expect(await rig.hasWorkspace(after)).toBe(false);
      expect(await rig.hasWorkspace(before)).toBe(true);
    });

    it('never deletes a real workspace, however late the clock says it is', async () => {
      const rig = await make();
      const real = await rig.addWorkspace({ demoExpiresAt: null });
      expect(await rig.store.deleteExpiredWorkspace(real, at(100_000))).toBe(false);
      expect(await rig.hasWorkspace(real)).toBe(true);
    });

    it('carries the workspace spend into the day totals, per UTC day, once', async () => {
      const rig = await make();
      const id = await rig.addWorkspace({
        demoExpiresAt: T0,
        usage: [
          { at: new Date('2026-11-15T23:59:59.000Z'), costUsd: 4 },
          { at: new Date('2026-11-16T01:00:00.000Z'), costUsd: 1.25 },
          { at: new Date('2026-11-16T09:00:00.000Z'), costUsd: 2, unpriced: true },
        ],
      });
      expect(await rig.store.deleteExpiredWorkspace(id, T0)).toBe(true);
      expect(await rig.store.deleteExpiredWorkspace(id, T0)).toBe(false);
      expect(await rig.carried()).toEqual([
        ['2026-11-15', 4, false],
        ['2026-11-16', 3.25, true],
      ]);
    });

    it('deletes login links that expired or were used before the cutoff, and no link after it', async () => {
      const rig = await make();
      await rig.addLoginToken(at(-30));
      await rig.addLoginToken(at(5), at(-30));
      await rig.addLoginToken(at(5));
      await rig.addLoginToken(at(-1));
      expect(await rig.store.deleteLoginTokensBefore(at(-24))).toBe(2);
      expect(await rig.loginTokenCount()).toBe(2);
    });

    it('deletes admissions made before the cutoff and keeps one made at it', async () => {
      const rig = await make();
      await rig.addAdmission(new Date(T0.getTime() - 1));
      await rig.addAdmission(T0);
      expect(await rig.store.deleteAdmissionsBefore(T0)).toBe(1);
      expect(await rig.admissionCount()).toBe(1);
    });

    it('deletes a guest user nothing holds, and keeps one a membership or an admission holds', async () => {
      const rig = await make();
      const idle = await rig.addGuestUser({ createdAt: at(-72) });
      const member = await rig.addGuestUser({ createdAt: at(-72), holds: 'membership' });
      const admitted = await rig.addGuestUser({
        createdAt: at(-72),
        holds: { admittedAt: at(-1) },
      });
      const recent = await rig.addGuestUser({ createdAt: at(-1) });
      expect(await rig.store.deleteIdleGuestUsersBefore(at(-24))).toBe(1);
      expect(await rig.hasUser(idle)).toBe(false);
      expect(await rig.hasUser(member)).toBe(true);
      expect(await rig.hasUser(admitted)).toBe(true);
      expect(await rig.hasUser(recent)).toBe(true);
      // The admission pruned, the person's cap has nothing left to lose: the user goes.
      expect(await rig.store.deleteAdmissionsBefore(at(0))).toBeGreaterThanOrEqual(1);
      expect(await rig.store.deleteIdleGuestUsersBefore(at(0))).toBe(2);
      expect(await rig.hasUser(admitted)).toBe(false);
      expect(await rig.hasUser(recent)).toBe(false);
      expect(await rig.hasUser(member)).toBe(true);
    });

    it('keeps a user no email link signed in, even with no membership and no identity', async () => {
      const rig = await make();
      // An administrator created this person and removed them before their first sign-in.
      const notAGuest = await rig.addGuestUser({ createdAt: at(-72), lead: false });
      expect(await rig.store.deleteIdleGuestUsersBefore(at(0))).toBe(0);
      expect(await rig.hasUser(notAGuest)).toBe(true);
    });
  });
}
