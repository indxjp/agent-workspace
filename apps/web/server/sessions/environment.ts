/**
 * What the §20 session routes are written against. The composition root builds it once
 * (`composition/session-rbac.ts`) and installs it as `ApplicationContext.sessions`; with no context
 * installed every session route refuses with a 503 — never a stub, and never an in-memory store
 * (`docs/adr/W1-CP-04-run-api-is-installed-not-imported.md` for why it is installed, not imported).
 */
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import type { SessionStateStore } from './state';
import type { TranscriptStore } from './transcript';
import type { SessionsStoreProvider } from './store';
import type { RetentionDriver } from './retention-cron';

/**
 * Who is calling, already resolved to one workspace (spec §25).
 *
 * `workspaceId` **is** the tenant's `projectKey`: `apps/web/server/compose/run-request.ts` builds
 * every run's `TenantSessionScope` as `{ projectKey: workspaceId, … }`, so the key the SDK hands
 * a mirror and the key this API stores under are the same string by construction. The API checks
 * that they agree rather than assuming it — see `api.ts`.
 */
export type SessionApiPrincipal =
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
      readonly role: MembershipRoleName;
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
  authenticate(request: Request): Promise<SessionApiPrincipal | null>;
  /**
   * Positive ownership/RBAC assertion for one platform session. Implementations must allow a
   * browser user only for their own session (or owner/admin oversight), and a runner only for
   * the exact session in its signed per-run claim.
   */
  canAccessSession(principal: SessionApiPrincipal, sessionId: string): Promise<boolean>;
  /**
   * The workspace file paths one run was granted (ADR-0147), snapshotted when it launched. `[]`
   * for an unknown run or one with no files.
   */
  runFileGrants(workspaceId: string, runId: string): Promise<readonly string[]>;
  /** Where the Claude Agent SDK's transcript lives. Engine-shaped; see `./transcript.ts`. */
  readonly store: TranscriptStore;
  /** The engine-scoped session store of ENG-06 (#305). */
  readonly stateStore: SessionStateStore;
  /** Complete control-plane session rows, separate from transcript storage. */
  readonly sessions: SessionsStoreProvider;
  /** Which session-retention driver this process runs; the cron route serves only `cron`. */
  readonly retention: RetentionDriver;
}

/** The 503 every session route returns while nothing is installed. */
export const SESSION_API_NOT_CONFIGURED_MESSAGE =
  'the session API has no environment installed: the composition root installs an authenticator ' +
  'and a durable TranscriptStore. This server will not guess either, and it will not fall back ' +
  'to an in-memory store — a session that does not survive a restart is spec §14.9’s release ' +
  'blocker, not a degraded mode.';
