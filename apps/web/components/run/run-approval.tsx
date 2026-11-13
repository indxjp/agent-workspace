'use client';

/**
 * The console's Approve / Reject for a run paused on a tool call (issue #1490, ADR-0145): the
 * shared `ApprovalPrompt` part in the console's look, with the decision sent by `./live.ts`. The
 * Builder keeps its own card (`../agents/builder-approval.tsx`), which reads its three tools' input.
 */
import { useEffect, useRef, useState } from 'react';

import {
  RUN_APPROVAL_PROBLEM_CODES,
  type RunApprovalCall,
  type RunApprovalDecision,
  type RunStatus,
} from '@indx-workspace/contracts/runs';
import { ApprovalPrompt } from '@indx-workspace/react';
import { surfaceStrings } from '@indx-workspace/react/locale';
import { approvalProblemMessage } from '@indx-workspace/react/run-model';

import { BTN, BTN_DEFAULT, CARD } from '../agents/agent-form';
import { browserLocale } from './attach-messages';
import { decideRunApproval } from './live';

// The console does not load `@indx-workspace/react/styles.css`, so every element gets its class here.
const CLASSES = {
  root: `${CARD} mt-6 flex flex-col gap-2 p-4 text-[13px]`,
  heading: 'm-0 font-semibold',
  label: 'flex flex-col gap-1 text-[12px] text-muted',
  actions: 'flex flex-wrap gap-2',
  problem: 'm-0 text-[12.5px] text-danger',
  fullCall:
    'text-[12px] text-muted [&>summary]:cursor-pointer [&>summary]:hover:text-text-2 [&>pre]:mt-1',
  call: 'm-0 max-h-48 overflow-auto rounded-(--radius-sm) bg-surface-2 p-2 font-mono text-[12px] [overflow-wrap:anywhere] whitespace-pre-wrap',
  comment:
    'rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-1 text-[13px] text-text',
  button: `${BTN} ${BTN_DEFAULT} disabled:opacity-[.45]`,
  approve: `${BTN} border-accent bg-accent text-white disabled:opacity-[.45] dark:text-[#10131c]`,
} as const;

export interface RunApprovalProps {
  /** The paused run. */
  readonly runId: string;
  readonly call: RunApprovalCall;
  /** The decision was accepted: follow the continuation run it started, which has `status`. */
  readonly onContinued: (runId: string, status: RunStatus) => void;
  /**
   * A decision is in flight, or no longer is. The chat holds its follow-up while one is: the server
   * still runs an approved call whose answer arrives after a new message took the card's place.
   */
  readonly onPendingChange?: (pending: boolean) => void;
  /**
   * The request ended for good (already decided, expired or cancelled): the card stays to say why,
   * and the chat may go on.
   */
  readonly onClosed?: () => void;
}

/** The three refusals that end the request for good (`RUN_APPROVAL_PROBLEM_CODES`): no retry can succeed. */
function isFinalRefusal(code: string): boolean {
  return Object.hasOwn(RUN_APPROVAL_PROBLEM_CODES, code);
}

export function RunApproval({
  runId,
  call,
  onContinued,
  onPendingChange,
  onClosed,
}: RunApprovalProps) {
  const [locale, setLocale] = useState<'en' | 'ja'>('en');
  useEffect(() => setLocale(browserLocale(navigator.languages)), []);
  const strings = surfaceStrings(locale);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  // A new message or leaving the page unmounts the card while a decision may still be in flight;
  // its answer then belongs to no transcript and must not take over the one on screen.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onPendingChange?.(false);
    };
  }, [onPendingChange]);
  // Two clicks in one tick both run before React disables the buttons; only the first decides.
  const inFlight = useRef(false);

  async function decide(decision: RunApprovalDecision, comment: string | undefined) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    onPendingChange?.(true);
    setProblem(null);
    const outcome = await decideRunApproval(runId, decision, comment);
    inFlight.current = false;
    if (!mounted.current) return;
    setPending(false);
    onPendingChange?.(false);
    switch (outcome.kind) {
      case 'continued':
        onContinued(outcome.runId, outcome.status);
        return;
      case 'rejected':
        setProblem(approvalProblemMessage(outcome.code, outcome.message, strings));
        if (isFinalRefusal(outcome.code)) {
          setClosed(true);
          onClosed?.();
        }
        return;
      case 'transport-error':
        setProblem(strings.approvalFailed);
        return;
    }
  }

  return (
    <div lang={locale}>
      <ApprovalPrompt
        call={call}
        strings={strings}
        pending={pending || closed}
        problem={problem}
        onDecide={(decision, comment) => void decide(decision, comment)}
        classNames={CLASSES}
      />
    </div>
  );
}
