/**
 * The one seam `apps/web/server/invitations/handlers.ts` needs beyond `RbacRuntime`
 * (`apps/web/server/rbac/runtime.ts`): where an audit row goes, and how a link is sent.
 *
 * Kept separate from `RbacRuntime` rather than added to it: that file's own header states its
 * scope as "who the caller is" and "where users, memberships and API keys are stored", and neither
 * an audit sink nor a mail-sending seam is either of those. The same module-global-plus-accessors
 * shape as `apps/web/server/rbac/runtime.ts` and `apps/web/server/audit/runtime.ts`, for the
 * reason both of those give: Next.js compiles `instrumentation.ts` and the route handlers into
 * separate module graphs, so the registry has to live on `globalThis`.
 *
 * Unconfigured fails, the same way: until `configureInvitationsRuntime` runs, every route under
 * `/api/invitations` answers `503 invitations_runtime_not_configured` rather than silently
 * skipping the audit write §36 and this task's own card require.
 */
import type { SendInvitation } from './send-invitation';

/** One row `apps/web/server/invitations/handlers.ts` asks to be written. Never carries a token. */
export interface InvitationAuditEvent {
  readonly workspaceId: string;
  readonly actorPrincipalId: string | null;
  /** `null` only when the actor could not be resolved to a `users` row — never an API key's name. */
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly action:
    'invitation-created' | 'invitation-resent' | 'invitation-revoked' | 'invitation-accepted';
  readonly subjectId: string;
  readonly subjectLabel: string;
}

export interface InvitationsRuntime {
  recordAuditEvent(event: InvitationAuditEvent): Promise<void>;
  sendInvitation: SendInvitation;
}

interface InvitationsRuntimeRegistry {
  __agentWorkspaceInvitationsRuntime__?: InvitationsRuntime;
}

const registry = globalThis as typeof globalThis & InvitationsRuntimeRegistry;

/** Install the runtime. Called from application wiring, never from a request handler. */
export function configureInvitationsRuntime(runtime: InvitationsRuntime): void {
  registry.__agentWorkspaceInvitationsRuntime__ = runtime;
}

/** Remove it. Exists so a test can assert that the unconfigured path really fails. */
export function clearInvitationsRuntime(): void {
  delete registry.__agentWorkspaceInvitationsRuntime__;
}

/** The installed runtime, or `null` when nothing has been wired yet. Never throws. */
export function currentInvitationsRuntime(): InvitationsRuntime | null {
  return registry.__agentWorkspaceInvitationsRuntime__ ?? null;
}
