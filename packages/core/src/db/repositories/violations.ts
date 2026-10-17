/**
 * Reading a constraint violation out of whatever Drizzle threw.
 *
 * ## Why this is not one property access
 *
 * Drizzle wraps a driver error: what a repository catches is a `DrizzleQueryError` carrying the
 * SQL and the parameters, and the `pg` error with `code` and `constraint` on it is somewhere down
 * the `cause` chain. `packages/core/src/db/seed.test.ts` found the same thing and says so in the
 * doc comment of its own `expectConstraintViolation`; the first draft of this module did not, read
 * `error.constraint` on the wrapper, found `undefined`, classified nothing, and re-threw four
 * conformance assertions that were supposed to be named outcomes. Measured, not guessed — the
 * failing output is quoted in `docs/adr/W2-DB-02-constraint-violations-arrive-wrapped.md`.
 *
 * ## Why a generator and not "the first pg error"
 *
 * A caller asks "is any link in this chain the violation I know how to name". Yielding every link
 * that *looks like* a violation, and letting the caller decide which constraint names it
 * recognises, keeps the decision a positive assertion at the point where the constraint names are
 * known — rather than here, where a wrong guess about which link matters would be invisible.
 *
 * The depth is bounded because a `cause` chain can be cyclic, and an unbounded walk over a cycle
 * turns a failed insert into a hung request.
 */

/** How far down a `cause` chain to look before giving up. */
const MAX_CAUSE_DEPTH = 10;

/** One link of the chain that carries both fields a violation is identified by. */
export interface PostgresViolation {
  /** SQLSTATE, e.g. `23505` for a unique violation. */
  readonly code: string;
  /** The constraint or unique-index name PostgreSQL reported. */
  readonly constraint: string;
}

/**
 * Every link of `error`'s `cause` chain that carries a SQLSTATE and a constraint name, outermost
 * first.
 *
 * Yields nothing for a value that is not an error, for an error with no such link, and for one
 * whose chain is longer than {@link MAX_CAUSE_DEPTH}. A caller that receives nothing must re-throw:
 * "this module could not name the failure" is not "this failure is harmless".
 */
export function* postgresViolations(error: unknown): Generator<PostgresViolation> {
  let cursor: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof cursor !== 'object' || cursor === null) return;
    const { code, constraint } = cursor as { code?: unknown; constraint?: unknown };
    if (typeof code === 'string' && typeof constraint === 'string') yield { code, constraint };
    cursor = (cursor as { cause?: unknown }).cause;
  }
}
