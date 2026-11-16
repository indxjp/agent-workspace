/**
 * What the store tells a visitor when the platform refuses a form or a read, in both languages: one
 * message per refusal code of `POST /api/store/leads`, never the platform's own text. A `503` and a
 * platform that cannot be reached both mean "not available yet" (no sender or challenge provider is
 * configured until the open decisions are made). Pure, so `pnpm test` covers it.
 */
import { STORE_LEAD_PROBLEM_CODES } from '@indx-workspace/contracts/email-link';
import type { StorePrivacyFacts } from '@indx-workspace/contracts/demo';

import { tr } from './text.ts';
import type { Lang } from './lang.ts';

export type Refusal = {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;
};

/** The sentence a form shows for `refusal`. */
export function refusalMessage(refusal: Refusal, lang: Lang): string {
  const t = tr(lang);
  if (refusal.status === 503 || refusal.code === 'platform_unreachable') {
    return t(
      'この機能はまだ使えません。準備ができ次第、お知らせします。',
      'This is not available yet. We will open it as soon as it is ready.',
    );
  }
  if (!Object.hasOwn(STORE_LEAD_PROBLEM_CODES, refusal.code)) {
    return t(
      '送信できませんでした。しばらくしてからもう一度お試しください。',
      'We could not send that. Please try again in a little while.',
    );
  }
  switch (refusal.code as keyof typeof STORE_LEAD_PROBLEM_CODES) {
    case 'invalid_body':
      return t(
        '入力内容を確認してください（メールアドレス、同意、本文）。',
        'Please check what you entered (email address, consent, message).',
      );
    case 'store_lead_challenge_failed':
      return t(
        '確認に失敗しました。もう一度お試しください。',
        'The check failed. Please try again.',
      );
    case 'store_lead_rate_limited':
      return refusal.retryAfterSeconds === null
        ? t(
            '短時間に多く送信されました。しばらくしてからお試しください。',
            'Too many requests. Please wait a little and try again.',
          )
        : t(
            `短時間に多く送信されました。${String(refusal.retryAfterSeconds)}秒ほど待ってからお試しください。`,
            `Too many requests. Please wait about ${String(refusal.retryAfterSeconds)} seconds and try again.`,
          );
    case 'store_lead_unavailable':
      return t('この機能はまだ使えません。', 'This is not available yet.');
  }
}

/** How long the notice says leads are kept: the configured days, "to be set", or unknown. */
export function retentionText(facts: StorePrivacyFacts | null, lang: Lang): string {
  const t = tr(lang);
  if (facts === null)
    return t('現在確認できません（お問い合わせください）', 'not available right now (ask us)');
  if (facts.leadRetentionDays === null)
    return t(
      '未定（決まり次第この通知に記載します）',
      'to be set (we will state it here once decided)',
    );
  return t(
    `最後の連絡から${String(facts.leadRetentionDays)}日`,
    `${String(facts.leadRetentionDays)} days after the last contact`,
  );
}

/** How long a demo workspace lasts before it and everything typed in it is deleted. */
export function demoHoursText(facts: StorePrivacyFacts | null, lang: Lang): string {
  const t = tr(lang);
  if (facts === null) return t('設定された時間', 'the configured time');
  return t(`${String(facts.demoWorkspaceHours)}時間`, `${String(facts.demoWorkspaceHours)} hours`);
}
