/**
 * The run view's own words in the reader's language (UX-15 in #2086), in the shape of
 * `./team-messages.ts`, whose locale negotiation (`./attach-messages.ts`) they share.
 *
 * English is the text `ui/agent-run.html` prints, unchanged. What arrives as data — the transcript,
 * the activity lines, the event log and the usage figures — is not translated here.
 */
import type { VersionsLocale } from '../agents/versions-messages';

export interface RunViewStrings {
  /** The follow-up box's accessible name. */
  readonly followUpLabel: string;
  readonly send: string;
  /** The assistant's placeholder while it works, and its accessible name. */
  readonly thinking: string;
  readonly working: (name: string) => string;
  /** The heading of the notice a failed run shows in the transcript. */
  readonly didNotComplete: string;
  /** The disclosure under the follow-up box, and what it holds. */
  readonly technicalDetails: string;
  readonly technicalDetailsHint: string;
  readonly tabEvents: string;
  readonly tabUsage: string;
  readonly tabRuntime: string;
  readonly noSdkEvents: string;
  readonly noUsage: string;
  readonly noRuntimeEvents: string;
}

const EN: RunViewStrings = {
  followUpLabel: 'Ask a follow-up',
  send: 'Send',
  thinking: 'Thinking…',
  working: (name) => `${name} is working`,
  didNotComplete: 'This run did not complete',
  technicalDetails: 'Show technical details',
  technicalDetailsHint: 'SDK events, tool calls, usage',
  tabEvents: 'SDK events',
  tabUsage: 'Usage',
  tabRuntime: 'Runtime',
  noSdkEvents: 'No SDK events have been received for this run.',
  noUsage: 'No usage has been reported for this run.',
  noRuntimeEvents: 'No runtime events have been received for this run.',
};

const JA: RunViewStrings = {
  followUpLabel: '続けて質問する',
  send: '送信',
  thinking: '考えています…',
  working: (name) => `${name} が作業中です`,
  didNotComplete: 'この実行は完了しませんでした',
  technicalDetails: '技術的な詳細を表示',
  technicalDetailsHint: 'SDK イベント、ツールの呼び出し、使用量',
  tabEvents: 'SDK イベント',
  tabUsage: '使用量',
  tabRuntime: 'ランタイム',
  noSdkEvents: 'この実行の SDK イベントはまだ届いていません。',
  noUsage: 'この実行の使用量はまだ報告されていません。',
  noRuntimeEvents: 'この実行のランタイムイベントはまだ届いていません。',
};

const STRINGS: Readonly<Record<VersionsLocale, RunViewStrings>> = { en: EN, ja: JA };

export function runViewStrings(locale: VersionsLocale): RunViewStrings {
  return STRINGS[locale];
}

/**
 * The run status badge's words in Japanese, keyed by the English `badgeForRunStatus` and
 * `failureBadge` print. A label not listed — a status this console does not know — is shown as it
 * came, as `badgeForRunStatus` itself does.
 */
const STATUS_JA: Readonly<Record<string, string>> = {
  Queued: '待機中',
  Running: '実行中',
  'Awaiting approval': '承認待ち',
  Completed: '完了',
  Failed: '失敗',
  Cancelled: 'キャンセル済み',
  Unknown: '不明',
};

const FAILED_PREFIX = 'Failed · ';

export function runStatusLabel(label: string, locale: VersionsLocale): string {
  if (locale === 'en') return label;
  const listed = STATUS_JA[label];
  if (listed !== undefined) return listed;
  // `failureBadge` names the status the server gave after the word, which stays as it came.
  if (label.startsWith(FAILED_PREFIX)) {
    return `${STATUS_JA['Failed'] ?? 'Failed'} · ${label.slice(FAILED_PREFIX.length)}`;
  }
  return label;
}
