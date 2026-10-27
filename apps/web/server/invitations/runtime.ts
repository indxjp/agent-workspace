/**
 * The one seam `apps/web/server/invitations/handlers.ts` needs beyond `RbacRuntime`
 * (`apps/web/server/rbac/runtime.ts`): where an audit row goes, and how a link is sent.
 *
 * Kept separate from `RbacRuntime` rather than added to it: that file's own header states its
 * scope as "who the caller is" and "where users, memberships and API keys are stored", and neither
 * an audit sink nor a mail-sending seam is either of those. The composition root builds it once
 * and installs it as `ApplicationContext.invitations`.
 *
 * Unconfigured fails: with no context installed, every route under `/api/invitations` answers
 * `503 invitations_runtime_not_configured` rather than silently skipping the audit write §36 and
 * this task's own card require.
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
