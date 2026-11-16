/**
 * Every word of the Try tab and the sign-in page that depends on what the platform answered, and
 * the pure rules that choose them. It imports only `lang.ts` and the contracts, so
 * `tests/store/try-*.test.ts` runs it under `pnpm test`.
 */
import {
  DEMO_RUN_START_PROBLEM_CODES,
  demoFallbackReason,
  type DemoAllowance,
  type DemoFallbackReason,
} from '@indx-workspace/contracts/demo';
import {
  DEMO_WORKSPACE_LIFETIME_SECONDS,
  VisitorEmailSchema,
  type EmailLinkRequest,
  type EmailLinkVerifyRequest,
} from '@indx-workspace/contracts/email-link';

import { pick, type Lang } from '../../../lang.ts';
import { parseLinkFragment } from '../../../sign-in/fragment.ts';

/** What the platform refused with, as `callPlatform` reports it. */
export interface Refusal {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;
}

/** How long the demo workspace lasts, from the platform's contract; the consent text names it. */
export const DEMO_HOURS = DEMO_WORKSPACE_LIFETIME_SECONDS / 3600;

/**
 * The consent sentence of the sign-up gate, split where the privacy notice's link goes: the demo is
 * deleted after {@link DEMO_HOURS} hours, the address is kept as a lead for the period the privacy
 * notice states, and no real personal data is typed in.
 */
export interface ConsentText {
  readonly before: string;
  readonly linkText: string;
  readonly after: string;
}

export function consentText(lang: Lang): ConsentText {
  const hours = String(DEMO_HOURS);
  return lang === 'ja'
    ? {
        before: `デモ環境は${hours}時間後に削除されます。メールアドレスは`,
        linkText: 'プライバシー通知',
        after:
          'に記載の期間、問い合わせ先として保管されます。実在の個人情報は入力しません。これらに同意します。',
      }
    : {
        before: `The demo workspace is deleted after ${hours} hours. My email address is kept as a lead for the period in the `,
        linkText: 'privacy notice',
        after: '. I will not type real personal data. I agree to this.',
      };
}

const MINUTE = 60;

/** "in about N minutes" from a `Retry-After`, at least one minute; empty without one. */
function retryHint(seconds: number | null, lang: Lang): string {
  if (seconds === null) return '';
  const minutes = Math.max(1, Math.ceil(seconds / MINUTE));
  return lang === 'ja'
    ? `${String(minutes)}分後にもう一度お試しください。`
    : `Try again in about ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
}

const NOT_AVAILABLE = {
  ja: 'まだ利用できません。しばらくしてからもう一度お試しください。',
  en: 'This is not available yet. Please try again later.',
};

/** The sentence for a refused `POST /api/auth/email-link`. */
export function gateRefusalMessage(refusal: Refusal, lang: Lang): string {
  const retry = retryHint(refusal.retryAfterSeconds, lang);
  switch (refusal.code) {
    case 'invalid_body':
      return pick(
        { ja: 'メールアドレスを確認してください。', en: 'Please check the email address.' },
        lang,
      );
    case 'email_link_challenge_failed':
      return pick(
        {
          ja: '確認に失敗しました。もう一度お試しください。',
          en: 'The check did not pass. Please try again.',
        },
        lang,
      );
    case 'email_link_address_refused':
      return pick(
        {
          ja: 'このメールアドレスは使えません。別のアドレスをお試しください。',
          en: 'This email address cannot be used. Please try another one.',
        },
        lang,
      );
    case 'demo_entry_unavailable':
      return pick(
        { ja: 'このデモは現在ご利用いただけません。', en: 'This demo is not available right now.' },
        lang,
      );
    case 'email_link_rate_limited':
      return `${pick({ ja: '試行回数が多すぎます。', en: 'Too many attempts.' }, lang)} ${retry}`.trim();
    default:
      return refusal.status === 429
        ? `${pick({ ja: '試行回数が多すぎます。', en: 'Too many attempts.' }, lang)} ${retry}`.trim()
        : pick(NOT_AVAILABLE, lang);
  }
}

/** What the sign-up form says before it sends anything: a missing address or a missing tick. */
export function gateProblem(input: { email: string; consent: boolean }, lang: Lang): string | null {
  if (!VisitorEmailSchema.safeParse(input.email).success) {
    return pick(
      { ja: 'メールアドレスを入力してください。', en: 'Enter your email address.' },
      lang,
    );
  }
  if (!input.consent) {
    return pick(
      {
        ja: 'デモを始めるには、プライバシー通知への同意が必要です。',
        en: 'To start the demo, please agree to the privacy notice.',
      },
      lang,
    );
  }
  return null;
}

/** The sentence for a refused `POST /api/auth/email-link/verify`. */
export function verifyRefusalMessage(refusal: Refusal, lang: Lang): string {
  if (refusal.code === 'email_link_invalid') {
    return pick(
      {
        ja: 'このリンクは無効か、有効期限が切れています。もう一度メールアドレスを入力してください。',
        en: 'This link is not valid or has expired. Please enter your email address again.',
      },
      lang,
    );
  }
  if (refusal.status === 429) {
    return `${pick({ ja: '試行回数が多すぎます。', en: 'Too many attempts.' }, lang)} ${retryHint(refusal.retryAfterSeconds, lang)}`.trim();
  }
  return pick(NOT_AVAILABLE, lang);
}

const FALLBACK_REASONS: Readonly<
  Record<DemoFallbackReason, { readonly ja: string; readonly en: string }>
> = {
  count: {
    ja: '本日のデモ実行回数の上限に達しました。',
    en: 'You have used all of your demo runs for today.',
  },
  cost: {
    ja: '本日のデモ全体の利用上限に達しました。',
    en: "Today's demo budget for the whole store has been used up.",
  },
  load: {
    ja: 'お使いのネットワークからのデモ実行が多すぎます。',
    en: 'There have been too many demo runs from your network.',
  },
  unavailable: {
    ja: 'デモは現在ご利用いただけません。',
    en: 'The demo is not available right now.',
  },
};

/** Where a cap came from: the platform refusing a start, or one run stopping at its own cap. */
export type FallbackScope = 'start' | 'run';

export interface Fallback {
  readonly reason: DemoFallbackReason;
  readonly scope: FallbackScope;
}

/**
 * Why the demo stopped at a cap, and which cap. A start refusal code (the person's runs, the
 * network, the whole store's budget, caps not set) is the `start` scope: no run can begin. A run
 * that stopped at its own turns (`stopReason` `max_turns`) or spend ceiling (failure code
 * `run_budget_reached`) is the `run` scope: that answer stopped, the visitor's runs are untouched.
 * `null` when nothing was a cap.
 */
export function fallbackReasonOf(input: {
  readonly code?: string | null;
  readonly stopReason?: string | null;
}): Fallback | null {
  const { code, stopReason } = input;
  if (code !== undefined && code !== null && Object.hasOwn(DEMO_RUN_START_PROBLEM_CODES, code)) {
    const reason = demoFallbackReason(code);
    if (reason !== null) return { reason, scope: 'start' };
  }
  for (const own of [code, stopReason]) {
    if (own === undefined || own === null) continue;
    const reason = demoFallbackReason(own);
    if (reason !== null) return { reason, scope: 'run' };
  }
  return null;
}

/** The sentence for a start refusal: the person's runs, the network, the store's budget, or none. */
export function fallbackReasonText(reason: DemoFallbackReason, lang: Lang): string {
  return pick(FALLBACK_REASONS[reason], lang);
}

const RUN_STOPS: Readonly<Record<'count' | 'cost', { readonly ja: string; readonly en: string }>> =
  {
    count: {
      ja: 'この回答は、1回の実行で使える長さの上限に達したため途中で止まりました。',
      en: 'This answer stopped because it reached the length limit of a single run.',
    },
    cost: {
      ja: 'この回答は、1回の実行で使える費用の上限に達したため途中で止まりました。',
      en: 'This answer stopped because it reached the cost limit of a single run.',
    },
  };

/** The sentence for a run that stopped at its own cap; the visitor's other runs are unaffected. */
export function runStopText(reason: DemoFallbackReason, lang: Lang): string {
  return pick(reason === 'cost' ? RUN_STOPS.cost : RUN_STOPS.count, lang);
}

/**
 * What the chat is stopped by: a start refusal always; a single run's stop only once the platform
 * says no runs are left (the allowance is read from the API, never assumed).
 */
export function chatFallback(
  start: DemoFallbackReason | null,
  runStopped: boolean,
  allowance: DemoAllowance | null,
): DemoFallbackReason | null {
  if (start !== null) return start;
  return runStopped && allowance !== null && allowance.runsLeft <= 0 ? 'count' : null;
}

/** What the sign-up form sends, or the sentence to show instead; nothing is sent on an `error`. */
export type GateSubmission = { readonly error: string } | { readonly body: EmailLinkRequest };

export function gateSubmission(
  input: { email: string; consent: boolean; challenge: string; slug: string },
  lang: Lang,
): GateSubmission {
  const error = gateProblem(input, lang);
  if (error !== null) return { error };
  return {
    body: { email: input.email, consent: true, challenge: input.challenge, entry: input.slug },
  };
}

const LINK_MISSING = {
  ja: 'サインイン用のリンクが正しくありません。メールのリンクをそのまま開いてください。',
  en: 'This sign-in link is not complete. Please open the link from your email as it is.',
};

/** The sign-in page's one decision: the request to send for this fragment, or why it cannot be. */
export type SignInStep =
  { readonly request: EmailLinkVerifyRequest } | { readonly failed: string; readonly back: string };

export function signInStep(hash: string, lang: Lang): SignInStep {
  const link = parseLinkFragment(hash);
  return link === null ? { failed: pick(LINK_MISSING, lang), back: '/' } : { request: link };
}

const BACK_LABELS = {
  shelves: { ja: 'エージェントの一覧へ戻る', en: 'Back to the agents' },
  newLink: { ja: '新しいリンクを受け取る', en: 'Request a new link' },
};

/**
 * The words of the sign-in page's way back, matching where it goes: the shelves (`/`), or an
 * entry's Try tab, where the visitor asks for a new link.
 */
export function signInBackLabel(back: string, lang: Lang): string {
  return pick(back === '/' ? BACK_LABELS.shelves : BACK_LABELS.newLink, lang);
}

/** The runs left and when the demo workspace ends, as the allowance route answered them. */
export function allowanceText(allowance: DemoAllowance, lang: Lang, timeZone?: string): string {
  const ends = new Intl.DateTimeFormat(lang === 'ja' ? 'ja-JP' : 'en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(new Date(allowance.expiresAt));
  const left = String(allowance.runsLeft);
  const total = String(allowance.runsPerDay);
  return lang === 'ja'
    ? `残り ${left} / ${total} 回。このデモは ${ends} に削除されます。`
    : `${left} of ${total} runs left. This demo is deleted at ${ends}.`;
}
