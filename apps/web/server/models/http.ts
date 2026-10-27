import type { ModelsAuditEvent } from './runtime';
import { applicationContext } from '../application-context';
import { problem, type ApiResult } from '../http/result';
import type { DiscoverModelsResult } from './discovery';
import type { WorkspaceModelsStore } from './store';
import type { TestConnectionResult } from './probe';
// Read-only, per issue #149's card: `decide()` is the one place in the program that answers "may
// this role do this to this route?" and this file adds no second one. `apps/web/server/rbac/**`
// is not edited by this task — W9-WS-119 owns that directory this wave.
import { decide, type Ownership } from '../rbac/decide';
import type { Role } from '../rbac/roles';

export async function readJsonBody(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; result: ApiResult }> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return {
      ok: false,
      result: problem(415, 'unsupported_media_type', 'This endpoint accepts application/json.'),
    };
  }
  try {
    return { ok: true, value: await request.json() };
  } catch {
    return {
      ok: false,
      result: problem(400, 'malformed_body', 'The request body is not valid JSON.'),
    };
  }
}

export function toResponse(result: ApiResult): Response {
  return result.status === 204 || result.body === null
    ? new Response(null, { status: result.status })
    : Response.json(result.body, { status: result.status });
}

export type ModelsRequestContext = {
  readonly store: WorkspaceModelsStore;
  readonly actor: {
    readonly workspaceId: string;
    readonly userId: string | null;
    readonly userLabel: string;
    readonly role: Role;
  };
  readonly probe: (
    resolved: NonNullable<Awaited<ReturnType<WorkspaceModelsStore['resolve']>>>,
  ) => Promise<TestConnectionResult>;
  readonly discover: (
    resolved: NonNullable<Awaited<ReturnType<WorkspaceModelsStore['resolve']>>>,
  ) => Promise<DiscoverModelsResult>;
  audit(
    event: Omit<
      ModelsAuditEvent,
      'workspaceId' | 'actorPrincipalId' | 'actorUserId' | 'actorLabel' | 'action'
    >,
  ): Promise<void>;
  log(message: string): void;
};

/**
 * Issue #149's write gate keys on the request method, not on whether a caller happened to pass
 * this argument: `GET`/`HEAD` stay authorised by workspace membership alone (declared gap G-12 —
 * see `docs/adr/W9-SEC-149-*.md`), and every other method reaches `decide()` regardless. `POST
 * /api/model-connections`, `PATCH`/`DELETE /api/model-connections/:id`, `POST …/:id/credential`
 * and `POST …/:id/test` pass `write` explicitly (`ownership` is `'not-applicable'` for the
 * collection `POST`, `'unknown'` for the four item routes — the `model-connections` grants in play
 * are `any` for Owner/Admin and `none` for Builder/Viewer, and neither reads a row, so no
 * ownership resolver is built); a write route that omitted it would still reach `decide()`, with
 * `ownership` defaulting to `'unknown'` rather than the gate being skipped.
 */
export type ModelsWriteAuthorisation = { readonly ownership: Ownership };

export async function withModelsRuntime(
  request: Request,
  run: (context: ModelsRequestContext) => Promise<ApiResult>,
  write?: ModelsWriteAuthorisation,
): Promise<ApiResult> {
  const models = applicationContext()?.models;
  if (models?.kind !== 'serving')
    return problem(503, 'models_runtime_not_configured', 'The models API is not configured.');
  const runtime = models.runtime;
  const actor = await runtime.resolveActor(request);
  if (actor.kind === 'unauthenticated') return problem(401, 'unauthenticated', actor.reason);
  if (actor.kind === 'forbidden') return problem(403, 'forbidden', actor.reason);
  // Keyed on the request method (G-12: `GET`/`HEAD` are the reads this wave declares
  // membership-scoped), not on whether a caller happened to pass `write` — a positive assertion
  // rather than an opt-in one, so a write route added later that forgets its `write` argument
  // still reaches `decide()` (with `ownership: 'unknown'`, the honest "row not read yet" answer)
  // instead of silently falling back to membership-only. Every route this task edits already
  // passes an explicit `ownership`, so this changes no existing route's behaviour.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const decision = decide({
      role: actor.role,
      method: request.method,
      path: new URL(request.url).pathname,
      ownership: write?.ownership ?? 'unknown',
      scope: actor.scope,
    });
    // Exactly `authorise()`'s own mapping (`apps/web/server/rbac/http.ts`): `deny` is a rule
    // applied and failed, `refuse` is no rule found to apply, and only `allow` reaches `run`.
    switch (decision.effect) {
      case 'deny':
        return problem(403, decision.code ?? 'forbidden', decision.because);
      case 'refuse':
        return problem(
          500,
          'authorisation_undecidable',
          `${decision.because} No authorisation decision was made, so this request was neither ` +
            `allowed nor refused on its merits.`,
        );
      case 'allow':
        break;
      default: {
        const unreachable: never = decision;
        throw new Error(
          `unclassified decision ${JSON.stringify(unreachable)} — refusing to serve the request`,
        );
      }
    }
  }
  return run({
    store: runtime.models.forWorkspace(actor.workspaceId),
    actor,
    probe: (resolved) => runtime.probe(resolved),
    discover: (resolved) => runtime.discover(resolved),
    audit: (event) =>
      runtime.audit({
        ...event,
        workspaceId: actor.workspaceId,
        actorPrincipalId: actor.principalId,
        actorUserId: actor.userId,
        actorLabel: actor.userLabel,
        action: 'provider-credential-changed',
      }),
    log: (message) => runtime.log(message),
  });
}
