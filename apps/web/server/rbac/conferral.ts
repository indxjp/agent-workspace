/**
 * `conferRole` — the one place in the program that answers *"may THIS caller confer THAT role?"*.
 *
 * ## The defect this file exists for
 *
 * Round 1 shipped four routes that take a `role` from the request body — `POST /api/users`,
 * `POST /api/memberships`, `PATCH /api/memberships/:id` and `POST /api/api-keys` — and validated it
 * with `parseRole`, which asks only whether the value *is* one of §21's four roles. Nothing asked
 * whether the caller was entitled to hand it out. Both halves of the counter-example the verifier
 * built and ran therefore worked:
 *
 * ```text
 * POST /api/api-keys {role:"owner"} as ADMIN -> 201 ; the key authenticates with role -> owner
 * PATCH /api/memberships/<own id> {role:"owner"} as ADMIN -> 200 ; role now -> owner
 * ```
 *
 * An Admin minted itself an Owner and thereby took `secrets`, which this task's own table denies
 * to Admin. Two independent shipping routes had the identical hole, which is the signal that the
 * check belongs *below* both of them rather than in each. It is here, and the type system — not a
 * convention — is what makes every one of the four pass through it: {@link ConferredRole} is a
 * branded `Role` that only this module produces, and it is what `WorkspaceDirectory` demands
 * wherever a role is written to a row.
 *
 * ## The rule, and why it is derived rather than written down
 *
 * **A caller may confer a role only if the caller's own grants dominate that role's grants, over
 * every resource and every operation.**
 *
 * The obvious alternative is a privilege ordering — `owner > admin > builder > viewer`. ADR-0152
 * made the table monotonic in that order (`permissions.test.ts` asserts it over every cell), so
 * today the two answers agree. Domination still asks the table rather than the order, so the
 * table stays the one place a grant is written (ADR-0016) and a cell that broke monotonicity
 * would change the conferral matrix instead of being silently contradicted by it.
 *
 * Domination is computed over {@link RESOURCES} × the three operations, and per cell it is the
 * formal model's breadth order `Grant.le` (`formal/AgentWorkspace/Authz/Permissions.lean`):
 * `none` ⊆ `own` ⊆ `permitted` ⊆ `any`, where `permitted` is "own or granted" (ADR-0152). The
 * order is total over the four widths, so every cell is either dominated or not; a caller or
 * requested role that is not one of the four is **refused** (ADR-0015, ADR-0031), which is why
 * {@link Conferral} has three effects rather than two.
 *
 * ## What this rule costs, stated rather than discovered later
 *
 * `conferral.test.ts` derives the whole matrix from {@link ROLES} and asserts it: a role may confer
 * itself and every role below it, and no role above it. An **Admin may not confer Owner** — that is
 * the fix — because Owner holds `secrets` and Admin does not.
 */
import { grantsFor, RESOURCES, type Grant, type Resource } from './permissions';
import { parseRole, ROLES, type Role } from './roles';

/**
 * A role that {@link conferRole} has decided this caller may hand out.
 *
 * A branded `Role`: assignable wherever a `Role` is wanted, and impossible to produce from a
 * `Role` without going through this module, because the brand is a `unique symbol` no other file
 * can name. `WorkspaceDirectory`'s role-writing inputs are typed with it, so a route that takes a
 * role from a request body and reaches a row without passing this check is a compile error rather
 * than a review comment. `conferral.test.ts` also asserts that no tracked file outside this one
 * writes the cast that would defeat it.
 */
declare const CONFERRED: unique symbol;
export type ConferredRole = Role & { readonly [CONFERRED]: true };

/** Whether one grant is at least as wide as another. */
export type Domination = 'dominates' | 'does-not';

/** Each width's rank in the formal model's `Grant.le` chain: `none` ⊆ `own` ⊆ `permitted` ⊆ `any`. */
const BREADTH: Readonly<Record<Grant, number>> = { none: 0, own: 1, permitted: 2, any: 3 };

/**
 * Does a caller holding `held` hold at least everything `conferred` would grant? Exactly
 * `Grant.le conferred held` in the formal model: `permitted` is "own or granted" (ADR-0152), so it
 * contains `own`, and `own` does not contain a granted row.
 */
export function dominates(held: Grant, conferred: Grant): Domination {
  return BREADTH[conferred] <= BREADTH[held] ? 'dominates' : 'does-not';
}

/** One (resource, operation) pair at which a conferral was decided. */
export interface ConferralWitness {
  readonly resource: Resource;
  readonly operation: 'read' | 'write' | 'run';
  readonly held: Grant;
  readonly conferred: Grant;
}

/**
 * The answer. `allow` carries the branded role; `deny` and `refuse` carry the reason and the
 * (resource, operation) pair that produced it, so a `403` body names a fact rather than a mood.
 */
export type Conferral =
  | { readonly effect: 'allow'; readonly role: ConferredRole; readonly because: string }
  | {
      readonly effect: 'deny';
      readonly because: string;
      readonly witness: ConferralWitness;
    }
  | {
      readonly effect: 'refuse';
      readonly because: string;
      readonly witness: ConferralWitness | null;
    };

const OPERATIONS = ['read', 'write', 'run'] as const;

/**
 * May a caller holding `callerRole` confer `requested`?
 *
 * Both arguments are `unknown` on purpose. This is the function that must not be wrong, and a
 * `role` that arrived from a database row or a request body through an `as` is exactly the value a
 * type annotation is no evidence about — the same reasoning `decide` gives for re-parsing its own
 * role argument.
 */
export function conferRole(callerRole: unknown, requested: unknown): Conferral {
  const caller = parseRole(callerRole);
  if (caller === null) {
    return {
      effect: 'refuse',
      because:
        `${JSON.stringify(callerRole)} is not one of spec §21's four roles (${ROLES.join(', ')}), ` +
        `so what this caller holds cannot be established and nothing can be compared against it.`,
      witness: null,
    };
  }
  const conferred = parseRole(requested);
  if (conferred === null) {
    return {
      effect: 'refuse',
      because:
        `${JSON.stringify(requested)} is not one of spec §21's four roles (${ROLES.join(', ')}), ` +
        `so there is no row of the permission table to compare against the caller's own.`,
      witness: null,
    };
  }

  for (const resource of RESOURCES) {
    const held = grantsFor(caller, resource);
    const wanted = grantsFor(conferred, resource);
    for (const operation of OPERATIONS) {
      const witness: ConferralWitness = {
        resource,
        operation,
        held: held[operation],
        conferred: wanted[operation],
      };
      const verdict = dominates(held[operation], wanted[operation]);
      switch (verdict) {
        case 'dominates':
          continue;
        case 'does-not':
          return {
            effect: 'deny',
            because:
              `A caller may not confer a role it does not itself hold. Spec §21 grants ` +
              `"${conferred}" ${operation} on "${resource}" with width "${wanted[operation]}", ` +
              `and grants the caller's own role "${caller}" only "${held[operation]}" there. ` +
              `Conferring it would hand out a capability the caller has not got.`,
            witness,
          };
        default: {
          const unreachable: never = verdict;
          throw new Error(`unclassified domination ${JSON.stringify(unreachable)}`);
        }
      }
    }
  }

  return {
    effect: 'allow',
    role: conferred as ConferredRole,
    because:
      `"${caller}" holds at least everything spec §21 grants "${conferred}", over every ` +
      `resource and every operation in apps/web/server/rbac/permissions.ts.`,
  };
}

/**
 * {@link conferRole} for a call site with no sensible failure branch. Throws, naming the pair.
 *
 * This is not a way around the rule and it cannot be used as one: it runs the same comparison and
 * raises on anything but `allow`. It exists for the seeding and fixture code that needs a role a
 * given caller demonstrably may confer — a directory test writing a row as the Owner — where a
 * `403` result object would only be unwrapped and thrown anyway.
 */
export function conferredBy(callerRole: Role, requested: Role, where: string): ConferredRole {
  const conferral = conferRole(callerRole, requested);
  if (conferral.effect !== 'allow') {
    throw new Error(
      `${where}: ${JSON.stringify(callerRole)} may not confer ${JSON.stringify(requested)} — ` +
        conferral.because,
    );
  }
  return conferral.role;
}

/**
 * Every (caller, requested) pair and what {@link conferRole} answers, so a test and an ADR can
 * quantify over the matrix without rebuilding it by hand (ADR-0016: derive, do not type).
 */
export function conferralMatrix(): {
  caller: Role;
  requested: Role;
  effect: Conferral['effect'];
}[] {
  return ROLES.flatMap((caller) =>
    ROLES.map((requested) => ({
      caller,
      requested,
      effect: conferRole(caller, requested).effect,
    })),
  );
}
