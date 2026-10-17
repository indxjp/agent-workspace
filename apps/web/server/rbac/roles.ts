/**
 * Spec §21's four roles, and nothing else.
 *
 * §21 prints them in one fenced block — `Owner`, `Admin`, `Builder`, `Viewer` — and this module
 * is the lower-cased form of exactly that list. It is a tuple rather than a `type` alias so that
 * every table in `permissions.ts` can be keyed by it and a fifth role becomes a compile error in
 * each of them at once rather than a missing row somewhere.
 *
 * ## Why this list is written here rather than imported
 *
 * `packages/core/src/db/schema/memberships.ts` already declares the same tuple as
 * `membershipRoles`, and importing it would be the right thing to do. It is not reachable:
 * `packages/core/src/db/index.ts` is a deliberately narrow barrel that re-exports the repository
 * layer and nothing else (sub-wave 2a closed two tenant-isolation bypasses caused by it
 * re-exporting the schema), the schema has no other export path, and neither file is inside this
 * task's ownership. So the tuple is duplicated, and `roles.test.ts` reads the schema file as text
 * and fails if the two lists ever differ — a duplicated constant with a gate on it is a fact that
 * cannot drift silently, which a duplicated constant with a comment on it is not.
 */

/**
 * §21's four roles, in the order §21 prints them.
 *
 * The order is §21's presentation order and **not** a containment order. An earlier revision of
 * this comment claimed `owner` ⊃ `admin` ⊃ `builder` ⊃ `viewer`, and `permissions.ts` contradicts
 * it: §21's Admin clause is read literally where it is silent, so Admin has no grant over
 * `projects` and cannot run a connector while Builder holds both over its own rows (ADR-0116 gave
 * Admin `skills` and `files`, superseding Decision 2 of
 * `docs/adr/W2-CP-06-the-four-roles-and-their-permission-split.md`).
 * Nothing in this program may treat this tuple as a privilege ladder — `conferral.ts` compares
 * grants in `permissions.ts` instead, precisely because this list cannot answer the question.
 */
export const ROLES = ['owner', 'admin', 'builder', 'viewer'] as const;

/** One of §21's four roles. */
export type Role = (typeof ROLES)[number];

/**
 * A role, or `null`. Positive: the value has to *be* one of the four (ADR-0015). There is no
 * fall-through and no default role — a membership row carrying something else is not a Viewer,
 * it is a row this program refuses to authorise from.
 */
export function parseRole(value: unknown): Role | null {
  if (typeof value !== 'string') return null;
  const found = ROLES.find((role) => role === value);
  return found ?? null;
}

/** `parseRole`, for a call site that has no sensible `null` branch. Throws, naming the value. */
export function requireRole(value: unknown, where: string): Role {
  const role = parseRole(value);
  if (role === null) {
    throw new Error(
      `${where}: ${JSON.stringify(value)} is not one of spec §21's four roles ` +
        `(${ROLES.join(', ')}). An unrecognised role is refused, never downgraded to the least ` +
        `privileged one, because a downgrade would make a corrupt row look like a legitimate ` +
        `Viewer.`,
    );
  }
  return role;
}
