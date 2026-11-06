/**
 * Build the {@link OwnershipResolver} every item route of this task (`agents`, `files`, `skills`,
 * `connectors`) needs: load the row **within the caller's workspace**, answer an indistinguishable
 * 404 when it is absent, and otherwise compare its `createdBy` against the caller's own resolved
 * id — issue #117's "load the row first, then call decide() with own, other or permitted".
 *
 * This is the one place that comparison is written. Every item route builds its resolver by
 * calling {@link resolverForRow} with its own row-loader and its own 404 {@link ApiResult}; neither
 * argument is guessed by this module, so a route's existing "row not found" wording is unchanged.
 */
import { problemWithDetail as problem } from '../http/result';
import type { OwnershipOutcome, OwnershipResolver } from '../rbac/http';
import type { Principal } from '../rbac/principal';

/** The ownership facts accepted during the principal migration window. */
export interface OwnedRow {
  /** Persisted tenant identity, checked even though production loaders are workspace-scoped. */
  readonly workspaceId: string;
  /** Authoritative once populated. Own/other authorization compares only this principal id. */
  readonly ownerPrincipalId?: string | null;
  /** Legacy human attribution, used only for an exact Membership compatibility read. */
  readonly createdBy?: string | null;
}

/** A status and a body, before either becomes an HTTP response — the shape every handlers.ts uses. */
export interface ApiResultLike {
  readonly status: number;
  readonly body: unknown;
}

/**
 * `load` reads the row **scoped to the caller's workspace already** (the store every route of this
 * task holds is workspace-bound by construction — see `agents/store.ts`'s own header) — this
 * function does not re-scope it, only decides what the row's presence or absence means for
 * authorisation. `notFound` is the route's own 404 builder, called only when `load` answers `null`.
 * `refuse`, when given, answers a refusal for a row the caller may not touch whatever their role
 * (a built-in agent's writes, #1848); it runs before the role decision, once the row is known.
 */
export function resolverForRow<Row extends OwnedRow>(
  load: () => Promise<Row | null>,
  notFound: () => ApiResultLike,
  refuse?: (row: Row, principal: Principal) => ApiResultLike | null,
): OwnershipResolver {
  return async (principal): Promise<OwnershipOutcome> => {
    const row = await load();
    if (row === null) {
      return { kind: 'refuse', result: notFound() };
    }
    // Workspace-scoped stores remain the primary isolation boundary. This explicit comparison is
    // defense in depth at the authorization boundary: even a miswired loader cannot turn a
    // same-valued principal UUID from another tenant into ownership, including for an `any` grant.
    if (row.workspaceId !== principal.workspaceId) {
      return { kind: 'refuse', result: notFound() };
    }
    const refusal = refuse?.(row, principal) ?? null;
    if (refusal !== null) return { kind: 'refuse', result: refusal };
    if (row.ownerPrincipalId !== undefined && row.ownerPrincipalId !== null) {
      return {
        kind: 'ownership',
        ownership: principal.ownerPrincipalId === row.ownerPrincipalId ? 'own' : 'other',
      };
    }
    // A legacy human creator can be matched to the exact verified Membership. A machine has no
    // human compatibility id; borrowing one would recreate RF-101's oldest-Owner vulnerability.
    if (principal.kind === 'api_key') {
      return {
        kind: 'refuse',
        result: problem(
          403,
          'machine_ownership_unsupported',
          'This legacy resource has no machine principal owner.',
        ),
      };
    }
    return {
      kind: 'ownership',
      ownership: principal.userId !== null && principal.userId === row.createdBy ? 'own' : 'other',
    };
  };
}
