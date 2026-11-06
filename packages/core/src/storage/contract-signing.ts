import { describe, expect, it } from 'vitest';
import {
  utf8,
  WORKSPACE_A,
  type ObjectStoreContractFixture,
  type WithObjectStore,
} from './contract-fixture.js';
import { SignedUrlUnsupportedError, type ObjectStore } from './object-store.js';
export function defineSigningContract(
  withStore: WithObjectStore,
  setup: () => Promise<ObjectStoreContractFixture>,
): void {
  describe('signing', () => {
    async function withSigning(
      run: (store: ObjectStore, fetchable: boolean, refusesExpired: boolean) => Promise<void>,
    ): Promise<void> {
      const { provider, teardown, signedUrlsFetchable, refusesExpiredSigning } = await setup();
      try {
        await run(
          provider.forWorkspace(WORKSPACE_A),
          signedUrlsFetchable === true,
          refusesExpiredSigning === true,
        );
      } finally {
        await teardown();
      }
    }

    it('is offered exactly when the backend declares it', async () => {
      await withStore((store) => {
        expect(store.createSignedUrl !== undefined).toBe(store.capabilities.sign);
        return Promise.resolve();
      });
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] expiry above 900 s is refused before any I/O', async () => {
      await withSigning(async (store) => {
        if (store.createSignedUrl === undefined) {
          expect(store.capabilities.sign).toBe(false);
          return;
        }
        await expect(
          store.createSignedUrl('a.txt', { method: 'GET', expiresInSeconds: 901 }),
        ).rejects.toThrow(SignedUrlUnsupportedError);
        // The "no backend call" half is proven by the recording backend in object-store.test.ts.
      });
    });

    // @story US-STO-05
    it('[US-STO-05][contract][sdk] a signed GET serves exactly one key and expires', async () => {
      await withSigning(async (store, fetchable, refusesExpired) => {
        if (store.createSignedUrl === undefined) return;
        await store.write('a.txt', utf8('alpha'), { contentType: 'text/plain' });
        await store.write('b.txt', utf8('bravo'), { contentType: 'text/plain' });
        const signed = await store.createSignedUrl('a.txt', { method: 'GET' });
        expect(() => new URL(signed.url)).not.toThrow();
        if (!fetchable) return;

        const served = await fetch(signed.url, { headers: signed.headers });
        expect(await served.text()).toBe('alpha');

        const other = new URL(signed.url);
        other.pathname = other.pathname.replace(/a\.txt$/, 'b.txt');
        expect((await fetch(other, { headers: signed.headers })).ok).toBe(false);

        const past = new Date(Date.now() - 120_000);
        const expiredRequest = { method: 'GET', expiresInSeconds: 60, now: past } as const;
        if (refusesExpired) {
          await expect(store.createSignedUrl('a.txt', expiredRequest)).rejects.toThrow(
            SignedUrlUnsupportedError,
          );
          return;
        }
        const expired = await store.createSignedUrl('a.txt', expiredRequest);
        expect((await fetch(expired.url, { headers: expired.headers })).ok).toBe(false);
      });
    });

    // @story US-STO-02
    it('[US-STO-02][contract][sdk] a signed PUT with a bound length refuses a different length', async () => {
      await withSigning(async (store, fetchable) => {
        if (store.createSignedUrl === undefined) return;
        const request = {
          method: 'PUT',
          contentLength: 3,
          requireBoundContentLength: true,
        } as const;
        if (!store.capabilities.boundLengthSign) {
          await expect(store.createSignedUrl('up.bin', request)).rejects.toThrow(
            SignedUrlUnsupportedError,
          );
          return;
        }
        const signed = await store.createSignedUrl('up.bin', request);
        expect(() => new URL(signed.url)).not.toThrow();
        if (!fetchable) return;

        const longer = await fetch(signed.url, {
          method: 'PUT',
          headers: signed.headers,
          body: utf8('four'),
        });
        expect(longer.ok).toBe(false);
        expect(await store.head('up.bin')).toBeNull();

        const exact = await fetch(signed.url, {
          method: 'PUT',
          headers: signed.headers,
          body: utf8('abc'),
        });
        expect(exact.ok).toBe(true);
        expect((await store.head('up.bin'))?.sizeBytes).toBe(3);
      });
    });
  });
}
