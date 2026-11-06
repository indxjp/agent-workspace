/**
 * NewTypes: ids the type checker tells apart.
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
