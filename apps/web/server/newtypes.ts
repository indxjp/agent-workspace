/**
 * NewTypes: ids and units the type checker tells apart.
 *
 * Every id on the server is a plain `string` today, so `remember(workspaceId, runId)` compiles as
 * happily as `remember(runId, workspaceId)`. A branded id is still a string at runtime, but the type
 * checker refuses to pass a `WorkspaceId` where a `RunId` is expected, and refuses a bare `string`
 * where either is.
 *
 * Each id has two ways in, and only two:
 *
 * - `parse(value)` checks the value once, where it enters the server (a route, a message), and
 *   throws a `ZodError` when it is not a UUID.
 * - `fromStore(value)` brands a value the database has confirmed: read from a PostgreSQL `uuid`
 *   column, or a caller's id the database has just found a row for. It does not check again, and it
 *   takes a plain string only: an id that already has a brand cannot be re-branded as another.
 *
 * The brand protects a value from where it is branded on. Ids read from the published contracts
 * types (`RunRecord`) are plain strings, so a call site that brands two of them at once still
 * relies on naming them right; branding at the source comes with step 5 of part 02.
 *
 * These types are internal to `apps/web` on purpose (refactoring part 02, step 1): the published
 * types in `@indx-workspace/contracts` do not change, so no API report and no SDK user is affected.
 * A domain adopts them when it is refactored, and adds the ids it needs here (`SessionId`, `AgentId`,
 * `PrincipalId`, …) at that point.
 *
 * Units (step 3) work the same way for numbers: `Bytes` and `Milliseconds` are whole, non-negative
 * numbers, still plain numbers at runtime, but a size cannot be passed where a duration is
 * expected. They have one way in, `parse`, which checks the value; a limit written in code is parsed
 * once where it is declared. Arithmetic gives back a plain `number`, so a computed value is parsed
 * again before it is used as a unit. `TokenCount` joins them when the run usage is refactored
 * (part 09).
 *
 * Money (step 4) has one form: `Usd`, a decimal string with exactly six places, the form the
 * `numeric(14,6)` money columns hold and PostgreSQL prints. A float cannot hold a micro-dollar
 * exactly (`0.1 + 0.2`), so arithmetic and comparison go through whole micro-dollars as a `bigint`
 * (`Usd.toMicros`, `Usd.fromMicros`). Fields on the published wire keep their shapes: some are
 * numbers (`maxBudgetUsd`, the start's `spendCeilingUsd`), some decimal strings (`RunRecord`'s
 * `spendCeilingUsd`, a share's `spentUsd`), and changing one is step 5's published-contract change.
 */
import { UuidSchema } from '@indx-workspace/contracts';
import { z } from 'zod';

/** The two ways to get one kind of id. */
interface IdType<Id extends string> {
  /** Checks that `value` is a UUID and brands it. Throws a `ZodError` when it is not. */
  parse(value: unknown): Id;
  /** Brands a value the database has confirmed, without checking it again. Refuses a branded id. */
  fromStore<Value extends string>(value: Value extends z.core.$brand ? never : Value): Id;
}

/** Takes the branded schema itself: inferring `Id` from `ZodType<Id>` would widen it to `string`. */
function idType<Schema extends z.ZodType<string, string>>(
  schema: Schema,
): IdType<z.output<Schema>> {
  return Object.freeze({
    parse: (value: unknown) => schema.parse(value),
    fromStore: <Value extends string>(value: Value extends z.core.$brand ? never : Value) =>
      value as z.output<Schema>,
  });
}

export const WorkspaceId = idType(UuidSchema.brand<'WorkspaceId'>());
export type WorkspaceId = ReturnType<typeof WorkspaceId.parse>;

export const RunId = idType(UuidSchema.brand<'RunId'>());
export type RunId = ReturnType<typeof RunId.parse>;

/** The one way to get one kind of unit. */
interface UnitType<Unit extends number> {
  /** Checks that `value` is a whole, non-negative, safe number and brands it. Throws a `ZodError` when not. */
  parse(value: unknown): Unit;
}

function unitType<Schema extends z.ZodType<number, number>>(
  schema: Schema,
): UnitType<z.output<Schema>> {
  return Object.freeze({ parse: (value: unknown) => schema.parse(value) });
}

const WholeNumber = z.number().int().nonnegative();

/** A size in bytes: storage and request limits. */
export const Bytes = unitType(WholeNumber.brand<'Bytes'>());
export type Bytes = ReturnType<typeof Bytes.parse>;

/** A duration in milliseconds: timeouts and windows. Not an instant (`Date.now()`). */
export const Milliseconds = unitType(WholeNumber.brand<'Milliseconds'>());
export type Milliseconds = ReturnType<typeof Milliseconds.parse>;

/** The largest amount a `numeric(14,6)` money column holds, in micro-dollars. */
const MAX_USD_MICROS = 99_999_999_999_999n;
const MICROS_PER_USD = 1_000_000n;

/** Whole micro-dollars as `<whole>.<six digits>`. */
function sixPlaces(micros: bigint): string {
  const whole = micros / MICROS_PER_USD;
  const fraction = micros % MICROS_PER_USD;
  return `${whole.toString()}.${fraction.toString().padStart(6, '0')}`;
}

const UsdSchema = z
  .string()
  .regex(/^\d{1,8}(?:\.\d{1,6})?$/u, 'must be a decimal USD amount with at most six places')
  .transform((value) => {
    const [whole = '0', fraction = ''] = value.split('.');
    return sixPlaces(BigInt(whole) * MICROS_PER_USD + BigInt(fraction.padEnd(6, '0')));
  })
  .brand<'Usd'>();

/** An amount of US dollars, as a six-place decimal string (`'0.250000'`). Never negative. */
export type Usd = z.output<typeof UsdSchema>;

export const Usd = Object.freeze({
  /**
   * Checks that `value` is a non-negative decimal string with at most eight whole digits and six
   * places (what `numeric(14,6)` holds), and gives it back in the six-place form. Throws a
   * `ZodError` when it is not; a number is refused too, since it may already have lost precision.
   */
  parse: (value: unknown): Usd => UsdSchema.parse(value),
  /** The amount for whole micro-dollars. Throws a `RangeError` below zero or above the column's range. */
  fromMicros: (micros: bigint): Usd => {
    if (micros < 0n || micros > MAX_USD_MICROS) {
      throw new RangeError(
        `${micros.toString()} micro-dollars is outside 0 to ${MAX_USD_MICROS.toString()}`,
      );
    }
    return sixPlaces(micros) as Usd;
  },
  /** The amount in whole micro-dollars, exact. */
  toMicros: (usd: Usd): bigint => {
    const [whole = '0', fraction = '0'] = usd.split('.');
    return BigInt(whole) * MICROS_PER_USD + BigInt(fraction);
  },
});
