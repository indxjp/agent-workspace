import { createHash } from 'node:crypto';
import type { AgentPermissions } from '@agent-workspace/core/db';
import type { ShareRecord } from '@agent-workspace/core/db';
import type { WorkspaceSharing } from '../core/runtime';
import { DomainError, type DomainErrorCategory } from '../../errors';

export function publicPermissions(permissions: AgentPermissions): AgentPermissions {
  return { ...permissions, runCommands: false, writeFiles: false };
}
export interface PublicRunResult {
  readonly output: unknown;
  /** Durable run linked to this share before execution starts. */
  readonly runId: string;
}
export type RunnableShareErrorCode =
  | 'budget_exhausted'
  | 'message_required'
  | 'rate_limited'
  | 'share_busy'
  | 'share_unavailable'
  | 'share_not_runnable';

/** Expected public-message refusals. Infrastructure failures deliberately use ordinary errors. */
export class RunnableShareError extends DomainError {
  public constructor(code: RunnableShareErrorCode, message: string) {
    const category: DomainErrorCategory =
      code === 'message_required' || code === 'share_not_runnable'
        ? 'validation'
        : code === 'share_unavailable'
          ? 'not-found'
          : 'rate-limit';
    super({
      category,
      code,
      publicMessage: message,
      ...(code === 'rate_limited' ? { retryAfterSeconds: 3_600 } : {}),
    });
    this.name = 'RunnableShareError';
  }
}

export function visitorSessionId(shareId: string, visitorKey: string): string {
  const hex = createHash('sha256').update(`${shareId}\0${visitorKey}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
export class RunnableShareService {
  public constructor(
    private readonly sharing: WorkspaceSharing,
    private readonly run: (input: {
      share: ShareRecord;
      prompt: string;
      visitorKey: string;
      sessionId: string;
    }) => Promise<PublicRunResult>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async message(share: ShareRecord, prompt: string, visitorKey: string): Promise<PublicRunResult> {
    if (share.mode !== 'runnable') {
      throw new RunnableShareError(
        'share_not_runnable',
        'This share is a definition and cannot run.',
      );
    }
    if (!prompt.trim()) throw new RunnableShareError('message_required', 'A message is required.');
    const now = this.now();
    const reservation = await this.sharing.shares.reserveVisitorMessage({
      id: share.id,
      visitorKey,
      windowStartedAt: new Date(now.getTime() - 3_600_000),
      now,
      limit: 5,
    });
    if (reservation.kind === 'rate-limited') {
      throw new RunnableShareError(
        'rate_limited',
        'Per-visitor limit of 5 messages per hour reached.',
      );
    }
    if (reservation.kind === 'busy') {
      throw new RunnableShareError(
        'share_busy',
        'This share is answering other visitors; retry in a minute.',
      );
    }
    if (reservation.kind === 'budget-exhausted') {
      if (reservation.stoppedNow) await this.writeBudgetStop(share);
      throw new RunnableShareError('budget_exhausted', 'This share has exhausted its budget.');
    }
    if (reservation.kind === 'unavailable') {
      throw new RunnableShareError('share_unavailable', 'Public link is unavailable.');
    }
    const admittedShare = reservation.share;
    return this.run({
      share: admittedShare,
      prompt,
      visitorKey,
      sessionId: visitorSessionId(admittedShare.id, visitorKey),
    });
  }
  async stop(
    share: ShareRecord,
    actor: { principalId: string; userId: string | null; userLabel: string },
  ): Promise<boolean> {
    const stopped = await this.sharing.shares.stop(share.id);
    if (stopped)
      await this.sharing.audit.write({
        actorPrincipalId: actor.principalId,
        actorUserId: actor.userId,
        actorLabel: actor.userLabel,
        action: 'runnable-link-stopped',
        subjectId: share.id,
        subjectLabel: share.subjectLabel,
      });
    return stopped;
  }

  private async writeBudgetStop(share: ShareRecord): Promise<void> {
    await this.sharing.audit.write({
      actorPrincipalId: null,
      actorUserId: null,
      actorLabel: 'Budget guard',
      action: 'runnable-link-stopped',
      subjectId: share.id,
      subjectLabel: share.subjectLabel,
    });
  }
}
