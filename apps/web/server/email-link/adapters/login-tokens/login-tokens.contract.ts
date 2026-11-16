import { describe, expect, it } from 'vitest';

import type { LoginTokenStore } from '../../ports';

const hex = (digit: string) => digit.repeat(64);
const NOW = new Date('2026-11-16T10:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`;

/** What a fresh store must start from; each test makes its own. */
export type MakeLoginTokenStore = () => Promise<LoginTokenStore>;

/** The behaviour the memory and the PostgreSQL store must share. */
export function describeLoginTokenStoreConformance(label: string, make: MakeLoginTokenStore): void {
  describe(`LoginTokenStore: ${label}`, () => {
    const record = (tokenHash: string, emailHash: string, created = NOW, ttl = 15) => ({
      id: nextId(),
      tokenHash,
      emailHash,
      createdAt: created,
      expiresAt: new Date(created.getTime() + ttl * 60_000),
    });
    const NO_LIMIT = { since: minutes(-24 * 60), limit: 1000 };
    const insert = async (store: LoginTokenStore, row: ReturnType<typeof record>) => {
      await expect(store.reserve(row, NO_LIMIT)).resolves.toBe(true);
    };
    const consume = (store: LoginTokenStore, tokenHash: string, emailHash: string, now = NOW) =>
      store.consume({ tokenHash, emailHash, now });

    it('consumes an inserted link once', async () => {
      const store = await make();
      await insert(store, record(hex('a'), hex('b')));
      await expect(consume(store, hex('a'), hex('b'))).resolves.toEqual({ kind: 'consumed' });
    });

    it('refuses a link that was already used', async () => {
      const store = await make();
      await insert(store, record(hex('a'), hex('b')));
      await consume(store, hex('a'), hex('b'));
      await expect(consume(store, hex('a'), hex('b'))).resolves.toEqual({ kind: 'refused' });
    });

    it('refuses an expired link, and accepts it just before it expires', async () => {
      const store = await make();
      await insert(store, record(hex('a'), hex('b')));
      await insert(store, record(hex('c'), hex('b')));
      await expect(consume(store, hex('a'), hex('b'), minutes(15))).resolves.toEqual({
        kind: 'refused',
      });
      await expect(consume(store, hex('c'), hex('b'), minutes(14))).resolves.toEqual({
        kind: 'consumed',
      });
    });

    it('refuses a tampered token and an unknown one', async () => {
      const store = await make();
      await insert(store, record(hex('a'), hex('b')));
      await expect(consume(store, hex('d'), hex('b'))).resolves.toEqual({ kind: 'refused' });
    });

    it('refuses a wrong address, and leaves the link usable by the right one', async () => {
      const store = await make();
      await insert(store, record(hex('a'), hex('b')));
      await expect(consume(store, hex('a'), hex('e'))).resolves.toEqual({ kind: 'refused' });
      await expect(consume(store, hex('a'), hex('b'))).resolves.toEqual({ kind: 'consumed' });
    });

    it('lets exactly one of two concurrent consumes win', async () => {
      const store = await make();
      await insert(store, record(hex('a'), hex('b')));
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => consume(store, hex('a'), hex('b'))),
      );
      expect(outcomes.filter((outcome) => outcome.kind === 'consumed')).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome.kind === 'refused')).toHaveLength(7);
    });

    const window = (limit: number, since = minutes(-15)) => ({ since, limit });

    it('reserves up to the limit for one address and then refuses, and no other address is affected', async () => {
      const store = await make();
      await expect(store.reserve(record(hex('1'), hex('b')), window(2))).resolves.toBe(true);
      await expect(store.reserve(record(hex('2'), hex('b')), window(2))).resolves.toBe(true);
      await expect(store.reserve(record(hex('3'), hex('b')), window(2))).resolves.toBe(false);
      await expect(store.reserve(record(hex('4'), hex('f')), window(2))).resolves.toBe(true);
    });

    it('counts only links at or after the start of the window', async () => {
      const store = await make();
      await insert(store, record(hex('1'), hex('b'), minutes(-20)));
      await insert(store, record(hex('2'), hex('b'), minutes(-10)));
      await expect(store.reserve(record(hex('3'), hex('b')), window(2))).resolves.toBe(true);
      await expect(store.reserve(record(hex('4'), hex('b')), window(2))).resolves.toBe(false);
      // A window that reaches back to the first link counts it too, inclusive of its start.
      await expect(
        store.reserve(record(hex('5'), hex('b')), window(3, minutes(-20))),
      ).resolves.toBe(false);
    });

    it('counts a used link too: the limit is on links sent', async () => {
      const store = await make();
      await insert(store, record(hex('1'), hex('b')));
      await consume(store, hex('1'), hex('b'));
      await expect(store.reserve(record(hex('2'), hex('b')), window(1))).resolves.toBe(false);
    });

    it('frees the slot of a released reservation and makes its link unusable', async () => {
      const store = await make();
      const first = record(hex('1'), hex('b'));
      await expect(store.reserve(first, window(1))).resolves.toBe(true);
      await expect(store.reserve(record(hex('2'), hex('b')), window(1))).resolves.toBe(false);
      await store.release(first.id);
      await expect(consume(store, hex('1'), hex('b'))).resolves.toEqual({ kind: 'refused' });
      await expect(store.reserve(record(hex('2'), hex('b')), window(1))).resolves.toBe(true);
    });

    it('stores at most the limit under concurrent reserves for one address', async () => {
      const store = await make();
      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          store.reserve(record(index.toString(16).padStart(64, '0'), hex('b')), window(3)),
        ),
      );
      expect(outcomes.filter(Boolean)).toHaveLength(3);
    });
  });
}
