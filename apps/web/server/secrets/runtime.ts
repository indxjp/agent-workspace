/**
 * The single seam between the secrets routes and the rest of the application — who the caller is,
 * and where secrets are stored.
 *
 * ## The unconfigured case fails, it does not fall through (ADR-0015)
 *
 * The composition root installs it as `ApplicationContext.secrets`. Until it is `serving` — no
 * context installed, or `unavailable` — every secrets route answers
 * `503 secrets_runtime_not_configured`: not `401`, because nothing checked anything yet, and not
 * `200` with an empty list, which would claim a capability nobody configured.
 *
 * `unavailable` is what `createSecretsService` (`@agent-workspace/core/secrets`) throwing leaves
 * behind: no master key, a malformed one, or a store it cannot reach. The composition root logs
 * which, and never substitutes an in-memory service.
 */
import type { SecretsStoreProvider } from './store';

/**
 * Who the caller is, as far as the secrets routes need to know.
 *
 * The same shape `apps/web/server/agents/runtime.ts` declares as `WorkspaceResolution`, duplicated
 * here rather than imported. `apps/web/server/agents/**` is a sibling task's `Owns:` glob, not
 * this one's, and this task has no business depending on a file it cannot change; the shape is
 * three lines and worth keeping this module self-contained over.
 */
export type WorkspaceResolution =
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'unauthenticated'; readonly reason: string }
  | { readonly kind: 'forbidden'; readonly reason: string };

/** Everything the secrets routes need from the rest of the application, and nothing more. */
export interface SecretsRuntime {
  /** Decide which workspace this request acts in (spec §25). Never derived from caller input. */
  resolveWorkspace(request: Request): Promise<WorkspaceResolution>;
  /** Secret metadata persistence, scoped to one workspace. Cannot produce a value — see `store.ts`. */
  secrets: SecretsStoreProvider;
}

/** The secrets routes as the application context holds them. */
export type Secrets =
  | { readonly kind: 'serving'; readonly runtime: SecretsRuntime }
  | {
      readonly kind: 'unavailable';
      /**
       * Present only when the deployment meant to configure secrets and got it wrong: a
       * `MASTER_ENCRYPTION_KEY` that is set but malformed (issue #1562, owner decision D9). The
       * readiness probe reports it; an unset key carries no reason and leaves readiness alone.
       */
      readonly reason?: 'malformed-master-key';
    };
