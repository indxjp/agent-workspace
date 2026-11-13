import { describe, expect, it } from 'vitest';
import { keysOf, textAt, utf8, type WithObjectStore } from './contract-fixture.js';
import { OBJECT_METADATA_SUFFIX, UnsafeObjectKeyError } from './key-safety.js';
export function defineKeySafetyContract(withStore: WithObjectStore): void {
  // ── The key a write() was given is the key it wrote to (verification round 1, F2) ─────────

  describe('a key is stored literally, never under some transformed form of itself', () => {
    it('write() writes to the key it was handed, and read()/listPage() name that same key', async () => {
      await withStore(async (store) => {
        await store.write('a/b', utf8('VICTIM BYTES'), {});
        expect(await textAt(store, 'a/b')).toBe('VICTIM BYTES');
        expect(await keysOf(store, 'a')).toEqual(['a/b']);
      });
    });

    it('write() refuses a key that would mean a different key once decoded, and leaves that other key alone', async () => {
      // The counter-example that failed verification round 1: `a%252fb` was accepted, decoded a
      // second and a third time on its way down, and the bytes landed on `a/b` while the API
      // reported writing `a%2fb`. This asserts the consequence, so it holds for any backend.
      await withStore(async (store) => {
        await store.write('a/b', utf8('VICTIM BYTES'), {});
        await expect(store.write('a%252fb', utf8('ATTACKER BYTES'), {})).rejects.toThrow(
          UnsafeObjectKeyError,
        );
        expect(await textAt(store, 'a/b')).toBe('VICTIM BYTES');
        expect(await keysOf(store, '')).toEqual(['a']);
      });
    });
  });

  // ── The reserved metadata name is not a legal key (round 1 F3; round 3 F3/U2) ──────────────
  //
  // Written over a *class* of spellings rather than one constant: every backend refuses all of
  // them identically, including one with no sidecar at all, because "which keys are legal" is one
  // answer for every backend. That a backend's own metadata is out of reach is a structural
  // property of where it puts things, asserted for the local filesystem in its own test file.

  describe('a key containing the reserved metadata marker is refused, however it is spelled', () => {
    const spellings: ReadonlyArray<readonly [label: string, key: string]> = [
      ['the exact-case name round 1 forged with', 'note.txt.__objectstore_meta__.json'],
      ['an upper-case extension', 'note.txt.__objectstore_meta__.JSON'],
      ['a mixed-case marker', 'note.txt.__ObjectStore_Meta__.json'],
      ['an all-upper-case name', 'NOTE.TXT.__OBJECTSTORE_META__.JSON'],
      ['an NTFS default-stream suffix', 'note.txt.__objectstore_meta__.json::$DATA'],
      ['a trailing dot', 'note.txt.__objectstore_meta__.json.'],
      ['the marker alone', '__objectstore_meta__'],
      ['the marker embedded mid-name', `x${OBJECT_METADATA_SUFFIX}y.txt`],
    ];

    for (const [label, poison] of spellings) {
      it(`write() refuses ${label}, and the object it would have shadowed is untouched`, async () => {
        await withStore(async (store) => {
          await store.write('note.txt', utf8('hello'), { contentType: 'text/plain' });
          await expect(
            store.write(poison, utf8('{"contentType":"text/html"}'), {}),
          ).rejects.toThrow(UnsafeObjectKeyError);
          // F3's evidence lines, asserted as consequences rather than as a rule firing: the
          // victim's content type, its bytes, and a listing with nothing extra or hidden in it.
          expect((await store.head('note.txt'))?.contentType).toBe('text/plain');
          expect(await textAt(store, 'note.txt')).toBe('hello');
          expect(await keysOf(store, '')).toEqual(['note.txt']);
        });
      });

      it(`read(), head(), delete() and listPage() refuse ${label} too, so it is unrepresentable`, async () => {
        await withStore(async (store) => {
          await expect(store.read(poison)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.head(poison)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.delete(poison)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.listPage(poison)).rejects.toThrow(UnsafeObjectKeyError);
        });
      });

      it(`refuses ${label} in a non-final segment as well, which a listing would also have hidden`, async () => {
        await withStore(async (store) => {
          await expect(store.write(`${poison}/inner.txt`, utf8('x'), {})).rejects.toThrow(
            UnsafeObjectKeyError,
          );
        });
      });
    }
  });

  // ── W2-plan.md's second acceptance criterion: refused BY CONSTRUCTION ─────────────────────

  describe('a key that would escape its workspace prefix is refused before any byte moves', () => {
    const attacks: ReadonlyArray<{ readonly label: string; readonly key: string }> = [
      { label: 'a ".." segment', key: '../../etc/passwd' },
      { label: 'an absolute path', key: '/etc/passwd' },
      { label: 'a percent-encoded ".." segment', key: '..%2f..%2fetc%2fpasswd' },
    ];

    for (const attack of attacks) {
      it(`write(), read(), head(), delete() and listPage() refuse ${attack.label}`, async () => {
        await withStore(async (store) => {
          await expect(store.write(attack.key, utf8('pwned'), {})).rejects.toThrow(
            UnsafeObjectKeyError,
          );
          await expect(store.read(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.head(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.delete(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.listPage(attack.key)).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.listPage(attack.key, { recursive: true })).rejects.toThrow(
            UnsafeObjectKeyError,
          );
        });
      });
    }

    it('refuses to copy an object over the same attack keys, as source and as destination', async () => {
      await withStore(async (store) => {
        await store.write('victim.txt', utf8('victim bytes'), {});
        for (const attack of attacks) {
          await expect(store.copy(attack.key, 'dest.txt')).rejects.toThrow(UnsafeObjectKeyError);
          await expect(store.copy('victim.txt', attack.key)).rejects.toThrow(UnsafeObjectKeyError);
        }
        expect(await store.head('dest.txt')).toBeNull();
        expect(await textAt(store, 'victim.txt')).toBe('victim bytes');
      });
    });

    it('refusing the attack keys leaves no trace outside the workspace prefix', async () => {
      // The positive half of the proof: a backend that "refused" by silently writing somewhere
      // else would still be caught here.
      await withStore(async (store) => {
        for (const attack of attacks) {
          await store.write(attack.key, utf8('pwned'), {}).catch(() => undefined);
        }
        expect(await keysOf(store, '', true)).toEqual([]);
      });
    });
  });
}
