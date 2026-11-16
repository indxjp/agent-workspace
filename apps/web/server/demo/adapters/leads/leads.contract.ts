import { describe, expect, it } from 'vitest';

import type { LeadStore, StoreEnquiryDetail } from '../../ports';

const T0 = new Date('2026-11-16T10:00:00.000Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

/** One lead as the rigs read it back. */
interface LeadRow {
  readonly email: string;
  readonly entries: readonly string[];
  readonly enquiry: string | null;
  readonly enquirySetup: StoreEnquiryDetail | null;
  readonly launchNotices: readonly string[];
  readonly lastContactAt: Date;
}

/** A fresh store and a way to read back each address it keeps, with its entries. */
export interface LeadStoreRig {
  readonly store: LeadStore;
  readonly read: () => Promise<readonly LeadRow[]>;
}

/** The behaviour the memory and the PostgreSQL lead store must share. */
export function describeLeadStoreConformance(label: string, make: () => Promise<LeadStoreRig>) {
  describe(`LeadStore: ${label}`, () => {
    it('keeps one lead per address, each entry once, in the order first opened', async () => {
      const { store, read } = await make();
      await store.recordContact({ email: 'v@example.test', entry: 'ringi-review', now: T0 });
      await store.recordContact({ email: 'v@example.test', entry: 'crm-sales', now: days(1) });
      await store.recordContact({ email: 'v@example.test', entry: 'ringi-review', now: days(2) });
      await store.recordContact({ email: 'v@example.test', entry: null, now: days(3) });
      const [lead] = await read();
      expect(lead?.entries).toEqual(['ringi-review', 'crm-sales']);
    });

    it('deletes a lead last contacted before the cutoff and keeps one contacted at it', async () => {
      const { store, read } = await make();
      await store.recordContact({ email: 'old@example.test', entry: null, now: T0 });
      await store.recordContact({ email: 'edge@example.test', entry: null, now: days(10) });
      expect(await store.deleteLastContactBefore(days(10))).toBe(1);
      expect((await read()).map((lead) => lead.email)).toEqual(['edge@example.test']);
    });

    it('counts a later contact from the newest time, never an older one', async () => {
      const { store, read } = await make();
      await store.recordContact({ email: 'v@example.test', entry: null, now: days(10) });
      await store.recordContact({ email: 'v@example.test', entry: null, now: T0 });
      expect(await store.deleteLastContactBefore(days(5))).toBe(0);
      expect(await read()).toHaveLength(1);
    });

    it('keeps the enquiry with what it was about, replaces it with a later one, and moves the last contact', async () => {
      const { store, read } = await make();
      await store.recordContact({ email: 'v@example.test', entry: 'ringi-review', now: T0 });
      await store.recordEnquiry({
        email: 'v@example.test',
        message: 'First',
        detail: { entry: 'ringi-review', setup: { tone: 'formal' } },
        now: days(1),
      });
      await store.recordEnquiry({
        email: 'v@example.test',
        message: 'Second',
        detail: null,
        now: days(2),
      });
      const [lead] = await read();
      expect(lead).toMatchObject({
        enquiry: 'Second',
        enquirySetup: null,
        entries: ['ringi-review'],
        lastContactAt: days(2),
      });
      await store.recordEnquiry({
        email: 'v@example.test',
        message: 'Third',
        detail: { entry: 'crm-sales', setup: { language: 'ja' } },
        now: days(3),
      });
      expect((await read())[0]?.enquirySetup).toEqual({
        entry: 'crm-sales',
        setup: { language: 'ja' },
      });
    });

    it('makes a lead from an enquiry alone, and a later sign-in keeps the enquiry', async () => {
      const { store, read } = await make();
      await store.recordEnquiry({
        email: 'n@example.test',
        message: 'Hello',
        detail: null,
        now: T0,
      });
      await store.recordContact({ email: 'n@example.test', entry: 'crm-sales', now: days(1) });
      expect(await read()).toMatchObject([
        {
          email: 'n@example.test',
          enquiry: 'Hello',
          entries: ['crm-sales'],
          lastContactAt: days(1),
        },
      ]);
    });

    it('adds each launch notice once, keeps the order, and moves the last contact', async () => {
      const { store, read } = await make();
      await store.recordLaunchNotice({ email: 'v@example.test', entry: 'wiki', now: T0 });
      await store.recordLaunchNotice({ email: 'v@example.test', entry: 'quotation', now: days(1) });
      await store.recordLaunchNotice({ email: 'v@example.test', entry: 'wiki', now: days(2) });
      expect(await read()).toMatchObject([
        { launchNotices: ['wiki', 'quotation'], lastContactAt: days(2), entries: [] },
      ]);
    });

    it('never moves the last contact back for an enquiry or a launch notice', async () => {
      const { store, read } = await make();
      await store.recordContact({ email: 'v@example.test', entry: null, now: days(10) });
      await store.recordEnquiry({ email: 'v@example.test', message: 'x', detail: null, now: T0 });
      await store.recordLaunchNotice({ email: 'v@example.test', entry: 'wiki', now: T0 });
      expect((await read())[0]?.lastContactAt).toEqual(days(10));
    });
  });
}
