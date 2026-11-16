import type { VersionsLocale } from '../agents/versions-messages';

/**
 * What the home chat says when it opens an earlier chat from the sidebar (UX-05 in #2086), in the
 * reader's language. Its earlier messages are shown above the composer when the transcript can be
 * read (step 2), and the notice says so when it cannot.
 */
export interface ResumeStrings {
  /** `label` is the chat's title, or its agent's name; `shown` says whether earlier messages are. */
  readonly continuing: (label: string, shown: boolean) => string;
  readonly refused: string;
  /** The heading above the earlier messages. */
  readonly historyHeading: string;
  /** Said above the earlier messages when `count` older ones are left out. */
  readonly earlierHidden: (count: number) => string;
}

const EN: ResumeStrings = {
  continuing: (label, shown) =>
    shown
      ? `Continuing “${label}”. Your next message goes on from where this chat left off.`
      : `Continuing “${label}”. Your next message goes on from where this chat left off; its earlier messages cannot be shown here.`,
  refused:
    'This chat cannot be continued here: it is archived, it was never started, or it is not yours. Start a new chat below.',
  historyHeading: 'Earlier in this chat',
  earlierHidden: (count) =>
    count === 1
      ? '1 older message is not shown.'
      : `${String(count)} older messages are not shown.`,
};

const JA: ResumeStrings = {
  continuing: (label, shown) =>
    shown
      ? `「${label}」の続きです。次のメッセージはこのチャットの続きとして送られます。`
      : `「${label}」の続きです。次のメッセージはこのチャットの続きとして送られます。以前のメッセージはここでは表示できません。`,
  refused:
    'このチャットはここでは続けられません：アーカイブ済み、まだ始まっていない、またはあなたのチャットではありません。下で新しいチャットを始めてください。',
  historyHeading: 'このチャットのこれまでのやり取り',
  earlierHidden: (count) => `古いメッセージ${String(count)}件は表示していません。`,
};

export function resumeStrings(locale: VersionsLocale): ResumeStrings {
  return locale === 'ja' ? JA : EN;
}
