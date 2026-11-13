/**
 * The fixture types and helpers shared by the RBAC directory conformance suite
 * (`directory.conformance.test-support.ts`), its two invocations (`directory.test.ts`) and the older
 * in-memory-only checks (`directory.memory-checks.test.ts`).
 */
import crypto from 'node:crypto';

import { conferredBy, type ConferredRole } from './core/conferral';
import type { Role } from './core/roles';
import type { DirectoryRoot } from './directory';

/**
 * A role an Owner may confer, for the fixture rows below.
 *
 * The directory port takes a `ConferredRole` rather than a `Role` — the type-level half of
 * `conferral.ts`'s rule, and what makes a route that never asked *"may this caller confer this
 * role?"* a compile error rather than a review comment. A test that writes a role into a row
 * therefore has to say who is conferring it. An Owner may confer all four; `conferredBy` runs the
 * same comparison every route runs and throws if that ever stops being true.
 */
export function asOwner(role: Role): ConferredRole {
  return conferredBy('owner', role, 'the fixture in this test file');
}

/** One workspace that really exists in the implementation, with its only member, an Owner. */
export interface SeededWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly owner: { readonly userId: string; readonly email: string; readonly name: string };
}

/** One set-up for one test. `a` sorts before `b` by name. */
export interface DirectoryFixture {
  readonly root: DirectoryRoot;
  readonly a: SeededWorkspace;
  readonly b: SeededWorkspace;
  /** An email no other test uses: `users.email` is global, and the database outlives one test. */
  email(local: string): string;
}

export type MakeDirectoryFixture = () => Promise<DirectoryFixture>;

/** A fresh workspace description named after `prefix` and `tag`; the caller makes it exist. */
export function seededWorkspace(prefix: string, tag: string): SeededWorkspace {
  return {
    id: crypto.randomUUID(),
    slug: `${prefix}-${tag}`,
    name: `${prefix} ${tag}`,
    owner: {
      userId: crypto.randomUUID(),
      email: `${prefix}-owner-${tag}@example.test`,
      name: `${prefix} Owner`,
    },
  };
}
