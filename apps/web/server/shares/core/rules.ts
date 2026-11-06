/**
 * The sharing rules, with no I/O (AGENTS.md "Hexagonal rules", refactoring plan part 05): what a
 * publish may ask for, how long a link lives, and when a public link opens. The time, the
 * workspace's policy and the release gate come in as arguments; `../service.ts` reads them through
 * ports and turns a refusal into the HTTP error.
 */
import type { PublishShareInput } from './input';

export type Expiry = '24 h' | '7 days' | '30 days' | 'never';

/** The lifetime of each expiry a publish may choose. */
export const EXPIRY_MS: Record<Exclude<Expiry, 'never'>, number> = {
  '24 h': 86_400_000,
  '7 days': 604_800_000,
  '30 days': 2_592_000_000,
};

/** The spend cap, in USD, of a runnable link that names none (spec §20.6.3). */
export const DEFAULT_RUNNABLE_BUDGET_USD = 20;

const SUBJECT_TYPES: readonly string[] = ['agent', 'session', 'project', 'skill'];
const EXPIRIES: readonly string[] = ['24 h', '7 days', '30 days', 'never'];

/** What a publish needs to know besides the request. */
export interface PublishFacts {
  /** The publisher's workspace role. */
  readonly role: string;
  /** Whether the workspace allows public links (its sharing policy). */
  readonly publicSharingEnabled: boolean;
  /** Whether this release offers runnable public links (D-06). */
  readonly runnableEnabled: boolean;
  /** The time of the publish; an expiry counts from it. */
  readonly now: Date;
}

/** The share a publish may write, or the reason it may not. */
export type PublishDecision =
  | {
      readonly ok: true;
      readonly mode: 'definition' | 'runnable' | undefined;
      readonly budgetCapUsd: string | null;
      readonly expiresAt: Date | null;
    }
  | { readonly ok: false; readonly message: string };

export function decidePublish(input: PublishShareInput, facts: PublishFacts): PublishDecision {
  if (!SUBJECT_TYPES.includes(input.subjectType))
    return refuse(`Unsupported share subject type: ${String(input.subjectType)}`);
  if (input.visibility === 'public' && !facts.publicSharingEnabled)
    return refuse('Public sharing is disabled for this workspace.');
  const mode = input.subjectType === 'agent' ? (input.mode ?? 'definition') : undefined;
  if (mode === 'runnable' && !facts.runnableEnabled)
    return refuse('Runnable public links are not available in this release (D-06).');
  if (mode === 'runnable' && !['owner', 'admin'].includes(facts.role))
    return refuse('Runnable links require Admin or Owner.');
  const expiry = input.expiry ?? 'never';
  if (!EXPIRIES.includes(expiry)) return refuse(`Unsupported expiry: ${String(expiry)}`);
  return {
    ok: true,
    mode,
    budgetCapUsd:
      mode === 'runnable' ? String(input.budgetCapUsd ?? DEFAULT_RUNNABLE_BUDGET_USD) : null,
    expiresAt: expiry === 'never' ? null : new Date(facts.now.getTime() + EXPIRY_MS[expiry]),
  };
}

/** The fields of a stored share that decide whether its public link opens. */
export interface ShareLinkState {
  readonly visibility: string;
  readonly revokedAt: Date | null;
  readonly suspendedAt: Date | null;
  readonly stopped: boolean;
  readonly expiresAt: Date | null;
}

/** Whether a public link opens at `now`: public, not revoked, suspended or stopped, not expired. */
export function publicLinkOpen(share: ShareLinkState, now: Date): boolean {
  if (share.visibility !== 'public' || share.revokedAt || share.suspendedAt || share.stopped)
    return false;
  return share.expiresAt === null || share.expiresAt.getTime() > now.getTime();
}

function refuse(message: string): PublishDecision {
  return { ok: false, message };
}
