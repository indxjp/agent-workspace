/**
 * `apps/runner/src/http-contract.ts` — the declared route table for spec §14.3, one entry per
 * path this server knows about at all.
 *
 * This module holds no handler logic — `server.ts` still dispatches each path with its own
 * `if` branch, because the five endpoints do not share a signature (`/run` reads a body and
 * streams; `/healthz` does neither) and a generic dispatcher over that mix would hide more than
 * it removes. What this module gives both `server.ts` and its tests is the one list neither may
 * duplicate by hand: which paths exist, and whether this build actually answers each one or
 * declares it and stops at 501.
 *
 * `apps/runner/src/http-contract.test.ts` parses `docs/spec.md` §14.3 itself — the fenced
 * ```text block's five lines and **every row of the alias table**, not one row picked out by
 * name — and asserts that parsed, derived set against this file's `RUNTIME_HTTP_CONTRACT`, in
 * both directions (W3-RT-01's lesson: a hand-typed comparison list goes stale three ways, so the
 * *expected* side must come from the source, never be retyped here). `server.ts` imports this
 * table only to keep its own "no such endpoint" and "not implemented" messages generated from
 * one place rather than transcribed twice.
 *
 * §14.3's own text:
 *
 * ```text
 * GET  /healthz            liveness / readiness
 * POST /run                start a run, respond with an SSE stream of SDK events
 * POST /interrupt          cancel the current run
 * POST /files              hydrate the workspace from a tar stream
 * GET  /files              collect persistent files as a tar stream
 * ```
 *
 * plus every row of the aliases table that names concrete routes — today that is the AgentCore
 * row alone: *"`POST /invocations` and `GET /ping` on port `8080`"*. The other two rows
 * (`Azure Container Apps sessions`, `Kubernetes / Docker / ECS`) are prose that names no route of
 * its own and contributes nothing to this set; see `http-contract.test.ts`'s row classifier.
 *
 * `/files` (both directions) is implemented by W3-CP-07 through `apps/runner/src/files.ts`; the
 * runtime-side POSIX ustar implementation lives in `packages/runtime/src/transfer.ts`.
 */

/** Every path §14.3 (plus the AgentCore aliases) declares gets exactly one of these. */
type ContractRouteStatus =
  /** The server actually dispatches this request to a real handler. */
  | 'implemented'
  /** The path is declared — it does not 404 — but this build answers 501 by name. */
  | 'not_implemented';

export interface ContractRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly status: ContractRouteStatus;
  /**
   * For an alias, the §14.3 path it is required to behave identically to. `undefined` for a
   * primary §14.3 endpoint.
   */
  readonly aliasOf?: string;
}

/**
 * §14.3's five endpoints, in the order the spec prints them, followed by the two AgentCore
 * aliases the alias table adds. Seven entries, and exactly seven — this task's Accept criterion
 * is that the served paths equal this set, no more and no fewer.
 */
export const RUNTIME_HTTP_CONTRACT: readonly ContractRoute[] = [
  { method: 'GET', path: '/healthz', status: 'implemented' },
  { method: 'POST', path: '/run', status: 'implemented' },
  { method: 'POST', path: '/interrupt', status: 'implemented' },
  { method: 'POST', path: '/files', status: 'implemented' },
  { method: 'GET', path: '/files', status: 'implemented' },
  { method: 'POST', path: '/invocations', status: 'implemented', aliasOf: '/run' },
  { method: 'GET', path: '/ping', status: 'implemented', aliasOf: '/healthz' },
];

/** The declared paths that answer 501 in this build, deduplicated. */
function notImplementedPaths(): readonly string[] {
  return [
    ...new Set(
      RUNTIME_HTTP_CONTRACT.filter((route) => route.status === 'not_implemented').map(
        (route) => route.path,
      ),
    ),
  ];
}

/** A human-readable summary of what this build serves, generated rather than retyped by hand. */
export function contractSummary(): string {
  const implemented = RUNTIME_HTTP_CONTRACT.filter((route) => route.status === 'implemented')
    .map((route) => `${route.method} ${route.path}`)
    .join(', ');
  const notImplemented = notImplementedPaths().join(', ');
  return `This runtime serves ${implemented}; ${notImplemented} are declared by §14.3 and answer 501 in this build.`;
}
