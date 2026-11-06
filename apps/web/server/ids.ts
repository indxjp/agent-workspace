/**
 * The id port: how server code asks for a new identifier.
 *
 * Code that mints an id takes an `IdGenerator` instead of calling `crypto.randomUUID()` itself, and
 * passes the id into a domain's `core/` as a plain string argument. A test can then know the id in
 * advance instead of reading it back. Production uses {@link randomIds}; tests use
 * {@link counterIds}.
 *
 * This port mints identifiers, which must be unique but need not be secret. A token, a salt or a key
 * must be unguessable, so it stays with `node:crypto` in an adapter and never comes from here.
 */

/** Where new identifiers come from. */
export interface IdGenerator {
  /** A new UUID, in the canonical lowercase form every `uuid` column and `UuidSchema` accept. */
  newId(): string;
}

/** The real generator: a random (version 4) UUID each call. */
export const randomIds: IdGenerator = Object.freeze({ newId: () => crypto.randomUUID() });

/**
 * A generator for tests: `00000000-0000-4000-8000-000000000001`, then `…002`, and so on.
 *
 * Each id is a valid version 4 UUID, so it passes `UuidSchema` and a PostgreSQL `uuid` column, and
 * the order a test minted them in can be read off the ids. Two generators count independently.
 */
export function counterIds(): IdGenerator {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
    },
  };
}
