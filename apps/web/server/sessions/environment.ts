/**
 * The seam between the §20 session routes and the rest of the control plane.
 *
 * The shape is `apps/web/server/runs/environment.ts`'s, deliberately and line for line: an
 * interface the routes are written against, a `globalThis`-anchored registry, an installer a
 * composition root calls, and a refusal — not a stub — while nothing is installed. Everything
 * that file's header says about why applies here unchanged, including the measured reason the
 * registry is on `globalThis`: Next.js compiles `instrumentation.ts` and the route handlers into
 * separate module graphs, so a module-level `let` gives the two halves two registries
 * (`docs/adr/W1-CP-04-run-api-is-installed-not-imported.md`).
 *
 * ## The one thing this task cannot install
 *
 * `apps/web/instrumentation.ts` is the composition root, and it belongs to W2-DB-02. So this
 * task ships the seam, the store, the routes and the adapter, and **nothing installs them yet**:
 * every session route answers 503 in a deployment until one line is added there. That is not a
 * shortcut, it is the same 503 the run API answered for a whole wave, and it is declared on this
 * task's PR with the exact call the composition root has to make.
 */
import type { SessionStateStore } from './state';
import type { TranscriptStore } from './transcript';
import type { SessionRepositoryProvider, WorkspaceScopeResolver } from '@agent-workspace/core/db';

/**
 * Who is calling, already resolved to one workspace (spec §25).
 *
 * `workspaceId` **is** the tenant's `projectKey`: `apps/web/server/compose/run-request.ts` builds
 * every run's `TenantSessionScope` as `{ projectKey: workspaceId, … }`, so the key the SDK hands
 * a mirror and the key this API stores under are the same string by construction. The API checks
 * that they agree rather than assuming it — see `api.ts`.
 */
export type SessionPrincipal =
  | {
      readonly kind: 'user';
      readonly principalId: string;
      /**
       * The principal that owns what this caller writes and that own/other is decided against
       * (`rbac/principal.ts`'s `ownerPrincipalId`). Equal to `principalId` except for a local
       * runtime key, which writes for the member it acts for (issue #509, S1-24). Every
       * composition root sets it, so it is required (`rbac/owner-principal.ts`).
       */
      readonly ownerPrincipalId: string;
      readonly userId: string | null;
      readonly workspaceId: string;
      readonly role: 'owner' | 'admin' | 'builder' | 'viewer';
    }
  | {
      readonly kind: 'runner';
      readonly workspaceId: string;
      readonly runId: string;
      readonly sessionId: string;
    };

export interface SessionApiEnvironment {
  /**
   * Resolve the caller. `null` means unauthenticated and the route answers 401.
   *
   * Returning a principal must be a positive assertion that the request carried valid
   * credentials. An implementation that returns a default principal when it finds none has
   * turned this seam into an open endpoint.
   */
  authenticate(request: Request): Promise<SessionPrincipal | null>;
  /**
   * Positive ownership/RBAC assertion for one platform session. Implementations must allow a
   * browser user only for their own session (or owner/admin oversight), and a runner only for
   * the exact session in its signed per-run claim.
   */
  canAccessSession(principal: SessionPrincipal, sessionId: string): Promise<boolean>;
  /** Where the Claude Agent SDK's transcript lives. Engine-shaped; see `./transcript.ts`. */
  readonly store: TranscriptStore;
  /**
   * The engine-scoped session store of ENG-06 (#305).
   *
   * Optional, and its absence is a 503 from the `/state-*` routes rather than a fallback: an engine
   * whose state is silently not stored is spec §14.9's release blocker, and a store that answered
   * "nothing here" for a session it simply was not asked to keep would make a resume start a fresh
   * conversation with nothing saying so.
   */
  readonly stateStore?: SessionStateStore;
  /** Complete control-plane session rows, separate from transcript storage. */
  readonly sessions?: SessionRepositoryProvider;
  readonly scopes?: WorkspaceScopeResolver;
}

interface SessionApiRegistry {
  __agentWorkspaceSessionApiEnvironment__?: SessionApiEnvironment;
}

const registry = globalThis as typeof globalThis & SessionApiRegistry;

/** Install the adapters. Called once by whoever composes the application. */
export function installSessionApi(environment: SessionApiEnvironment): void {
  registry.__agentWorkspaceSessionApiEnvironment__ = environment;
}

/** Remove them. For tests, and for a harness that must not leak into the next case. */
export function resetSessionApi(): void {
  delete registry.__agentWorkspaceSessionApiEnvironment__;
}

export function getSessionApi(): SessionApiEnvironment | null {
  return registry.__agentWorkspaceSessionApiEnvironment__ ?? null;
}

/** The 503 every session route returns while nothing is installed. */
export const SESSION_API_NOT_CONFIGURED_MESSAGE =
  'the session API has no environment installed: call installSessionApi() with an authenticator ' +
  'and a durable TranscriptStore. This server will not guess either, and it will not fall back ' +
  'to an in-memory store — a session that does not survive a restart is spec §14.9’s release ' +
  'blocker, not a degraded mode.';
