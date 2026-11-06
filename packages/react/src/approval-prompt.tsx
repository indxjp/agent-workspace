'use client';

/**
 * The approval prompt of a run paused on a tool call (issue #1490, ADR-0145). Its own file, marked
 * for the client, because it keeps the comment's state and `./parts.tsx` is also imported by server
 * components (the hosted surface page).
 */
import { useState, type ReactNode } from 'react';

import {
  RUN_APPROVAL_COMMENT_MAX_LENGTH,
  type RunApprovalCall,
  type RunApprovalDecision,
} from '@indx-workspace/contracts/runs';

/** The prompt's own words; `surfaceStrings(locale)` from `@indx-workspace/react/locale` has them. */
export interface ApprovalPromptStrings {
  /** The heading and accessible name, naming the tool the run paused on. */
  readonly approvalNeeded: (toolName: string) => string;
  /** The button that lets the paused call run. */
  readonly approve: string;
  /** The button that refuses the paused call. */
  readonly reject: string;
  /** The label of the optional comment. */
  readonly approvalComment: string;
}

/** What `ApprovalPrompt` shows and whom it tells about the decision. */
export interface ApprovalPromptProps {
  /** The call the run paused on, as `RunResource.pendingApproval` and `agent.approval.requested` carry it. */
  readonly call: RunApprovalCall;
  /** The prompt's words. */
  readonly strings: ApprovalPromptStrings;
  /** A decision is in flight: both buttons are disabled so it cannot be sent twice. */
  readonly pending: boolean;
  /** The last decision's refusal or failure, in the reader's words; `null` when there is none. */
  readonly problem?: string | null | undefined;
  /** Called with the decision and the comment, or `undefined` when the comment is blank. */
  readonly onDecide: (decision: RunApprovalDecision, comment: string | undefined) => void;
  /** Replaces the default `aw-` classes, for a host that styles the prompt itself. */
  readonly classNames?:
    | {
        readonly root?: string | undefined;
        readonly heading?: string | undefined;
        readonly call?: string | undefined;
        readonly label?: string | undefined;
        readonly comment?: string | undefined;
        readonly actions?: string | undefined;
        /** Both buttons; `approve` replaces it for the Approve button. */
        readonly button?: string | undefined;
        readonly approve?: string | undefined;
        readonly problem?: string | undefined;
      }
    | undefined;
}

/**
 * Approve or reject the tool call a run paused on (ADR-0145). The tool name and the canonical call
 * are text nodes, so a call cannot inject markup; a blank comment is sent as no comment, which is
 * what `RunApprovalRequestSchema` accepts.
 */
export function ApprovalPrompt({
  call,
  strings,
  pending,
  problem = null,
  onDecide,
  classNames = {},
}: ApprovalPromptProps): ReactNode {
  const [comment, setComment] = useState('');
  const heading = strings.approvalNeeded(call.toolName);
  const decide = (decision: RunApprovalDecision): void => {
    onDecide(decision, comment.trim() === '' ? undefined : comment);
  };
  const button = classNames.button ?? 'aw-approval-button';
  return (
    <div role="group" aria-label={heading} className={classNames.root ?? 'aw-approval'}>
      <p className={classNames.heading ?? 'aw-approval-heading'}>{heading}</p>
      <pre className={classNames.call ?? 'aw-pre aw-approval-call'}>{call.canonicalCall}</pre>
      <label className={classNames.label ?? 'aw-approval-label'}>
        {strings.approvalComment}
        <textarea
          className={classNames.comment ?? 'aw-input aw-approval-comment'}
          maxLength={RUN_APPROVAL_COMMENT_MAX_LENGTH}
          rows={2}
          value={comment}
          disabled={pending}
          onChange={(event) => {
            setComment(event.target.value);
          }}
        />
      </label>
      <div className={classNames.actions ?? 'aw-approval-actions'}>
        <button
          type="button"
          className={classNames.approve ?? `${button} aw-approval-approve`}
          disabled={pending}
          onClick={() => {
            decide('approve');
          }}
        >
          {strings.approve}
        </button>
        <button
          type="button"
          className={button}
          disabled={pending}
          onClick={() => {
            decide('reject');
          }}
        >
          {strings.reject}
        </button>
      </div>
      {problem === null ? null : (
        <p role="alert" className={classNames.problem ?? 'aw-approval-problem'}>
          {problem}
        </p>
      )}
    </div>
  );
}
