/**
 * `oneOf` — the project's way of constraining a `text` column to a closed set of values.
 *
 * Why not `text(name, { enum: [...] })` alone: R-15 §4 verified that Drizzle's `enum` option
 * emits **no database constraint at all** — the DDL is a plain `"role" text NOT NULL`, and an
 * insert of `'NOT_A_VALID_TYPE'` succeeds. The option is a TypeScript narrowing and nothing
 * more. Every column in this schema that names a closed set therefore carries BOTH: the `enum`
 * option, so the TypeScript type is the string-literal union, and a `CHECK` built by this
 * helper, so the database enforces it.
 *
 * Why not `pgEnum`: R-15 §4 again — adding a value to a PostgreSQL enum type is a migration
 * with lock implications, whereas widening a `CHECK` is a one-line `ALTER`. Spec §20.6 will
 * grow subject types and §10 will grow providers, so the cheap-to-widen form wins.
 *
 * The values are inlined into DDL text rather than bound as parameters, because a `CHECK`
 * constraint is DDL and a bound parameter would be emitted as a literal `$1`. Inlining is only
 * safe for values that cannot carry quoting, so `oneOf` REJECTS anything that is not a short
 * lower-case slug rather than escaping it. That is deliberate: this helper is a gate, and a
 * gate decides on a positive assertion (ADR-0015). A value it cannot prove safe is a
 * throw at module load — i.e. at `drizzle-kit generate` time and at process start — not a
 * silently escaped string.
 */
import { sql, type SQL } from 'drizzle-orm';
import { check, type AnyPgColumn, type PgTableExtraConfigValue } from 'drizzle-orm/pg-core';

/**
 * The only shape a value in a closed set may take: a lower-case slug of 1–64 characters,
 * starting with a letter, containing letters, digits and single hyphens.
 */
const SAFE_VALUE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_VALUE_LENGTH = 64;

/**
 * Render `('a', 'b', 'c')` for DDL inlining, rejecting anything that is not provably safe.
 *
 * Exported for the unit test: the rejection behaviour is the point of this module, and a
 * rejection path that is never exercised is not a rejection path.
 *
 * @throws if the list is empty, holds duplicates, or holds any value outside {@link SAFE_VALUE}.
 */
export function renderValueList(values: readonly string[]): string {
  if (values.length === 0) {
    throw new Error('oneOf: the value list is empty; a CHECK over no values can never be true.');
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !SAFE_VALUE.test(value) || value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `oneOf: ${JSON.stringify(value)} is not a lower-case slug of at most ${String(MAX_VALUE_LENGTH)} ` +
          'characters, so it cannot be inlined into DDL safely. Rename the value.',
      );
    }
    if (seen.has(value)) {
      throw new Error(`oneOf: ${JSON.stringify(value)} appears twice in the value list.`);
    }
    seen.add(value);
  }
  return `(${values.map((value) => `'${value}'`).join(', ')})`;
}

/**
 * A named `CHECK (<column> IN (...))` constraint over a closed set of string values.
 *
 * @param name   the constraint name, which is what a violation reports — make it readable.
 * @param column the column being constrained.
 * @param values the closed set, normally the same `as const` array passed to `text`'s `enum`.
 */
export function oneOf(
  name: string,
  column: AnyPgColumn,
  values: readonly string[],
): PgTableExtraConfigValue {
  const list: SQL = sql.raw(renderValueList(values));
  return check(name, sql`${column} in ${list}`);
}
