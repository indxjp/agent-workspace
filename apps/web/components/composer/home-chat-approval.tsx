import type { ReactNode } from 'react';
import type { RunApprovalCall, RunStatus } from '@indx-workspace/contracts/runs';
import { RunApproval } from '../run/run-approval';

/** The latest run's paused call remains visible until a decision or a new message retires it. */
export interface Paused {
  readonly runId: string;
  readonly call: RunApprovalCall;
  readonly closed?: boolean;
}

/** A caller-supplied approval card retains its own decision rules. */
export function approvalSlot(
  approval: ReactNode | undefined,
  paused: Paused | null,
  onContinued: (runId: string, status: RunStatus) => void,
  onPendingChange: (pending: boolean) => void,
  onClosed: () => void,
): ReactNode {
  if (approval !== undefined) return approval;
  if (paused === null) return null;
  return (
    <RunApproval
      key={paused.runId}
      runId={paused.runId}
      call={paused.call}
      onContinued={onContinued}
      onPendingChange={onPendingChange}
      onClosed={onClosed}
    />
  );
}

/** Hold a follow-up while this chat's card asks or a decision is in flight. */
export function followUpWhileDeciding(
  deciding: boolean,
  approval: ReactNode | undefined,
  paused: Paused | null,
  send: (text: string, attachments: readonly string[]) => void,
): { readonly onFollowUp?: (text: string, attachments: readonly string[]) => void } {
  // A caller's own prompt (the Builder's) keeps its own rules; only this chat's card holds here.
  const cardAsks = approval === undefined && paused !== null && paused.closed !== true;
  return deciding || cardAsks ? {} : { onFollowUp: send };
}
