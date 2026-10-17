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
 * The obvious alternative is a privilege ordering — `owner > admin > builder > viewer` — and it is
 * wrong here: `permissions.ts` reads §21's Admin clause literally where §21 is silent, so Admin
 * has *no* grant over `projects` and cannot run a connector, while Builder holds both over its own
 * rows (ADR-0116 closed the earlier `skills` and `files` gap; these two remain).
 * The four roles are therefore **not** a total order under this table, and an ordering asserted in
 * code would be asserting something the table contradicts (ADR-0016). Domination asks the table
 * instead, so the day §21's reading changes, the conferral matrix changes with it and there is no
 * second place to edit.
 *
 * Domination is computed over {@link RESOURCES} × the three operations. There is no fifth answer
 * and no default: where the two grants cannot be compared the conferral is **refused**, not
 * allowed (ADR-0015, ADR-0031). That happens for exactly one grant width — `permitted`, whose
 * extent §21 leaves undefined — and it is why {@link Conferral} has three effects rather than two.
 *
 * ## What this rule costs, stated rather than discovered later
 *
 * `conferral.test.ts` derives the whole matrix from {@link ROLES} and asserts these two cells by
 * name, because they are product consequences and not only code ones:
 *
 *   * an **Admin may not confer Owner** — that is the fix;
 *   * an **Admin may not confer Builder** either, because Builder holds its own `projects` and
 *     runs its own `connectors` while §21's Admin clause grants neither, so an Admin conferring
 *     Builder would be handing out a capability the Admin does not hold. Admin may confer Admin
 *     and Viewer.
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

/**
 * Whether one grant is at least as wide as another.
 *
 * `undecidable` is not "probably fine". It is the answer for `permitted`, which §21 uses once —
 * Viewer's *"Run **permitted** agents"* — and for which neither §21 nor §27 defines a mechanism,
 * so its extent is unknown in both directions.
 */
export type Domination = 'dominates' | 'does-not' | 'undecidable';

/**
 * Does a caller holding `held` hold at least everything `conferred` would grant?
 *
 * Positive by construction: every `dominates` answer names the reason it is one, and the final
 * `else` is a refusal rather than a fall-through (ADR-0015).
 */
export function dominates(held: Grant, conferred: Grant): Domination {
  // `any` is the widest grant there is, so it covers every other.
  if (held === 'any') return 'dominates';
  // `none` is the narrowest, so every grant covers it — including `none` itself.
  if (conferred === 'none') return 'dominates';
  // The same width on both sides is the same set of rows.
  if (held === conferred) return 'dominates';
  // One side is `permitted` and the other is not. `permitted` denies today, but its *extent* is
  // what this comparison needs and §21 defines none, so neither containment can be asserted.
  if (held === 'permitted' || conferred === 'permitted') return 'undecidable';
  // What is left is `none` or `own` on the left against a strictly wider grant on the right.
  if (held === 'none' || held === 'own') return 'does-not';
  const unreachable: never = held;
  throw new Error(`unclassified grant ${JSON.stringify(unreachable)} — refusing to confer`);
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
        case 'undecidable':
          return {
            effect: 'refuse',
            because:
              `Whether "${caller}" holds everything "${conferred}" would be granted cannot be ` +
              `decided at ${operation} on "${resource}": one side is "permitted", a width spec ` +
              `§21 uses without defining a mechanism, so its extent is unknown in both ` +
              `directions. An undecidable conferral is refused, never allowed ` +
              `(ADR-0015, ADR-0031).`,
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
