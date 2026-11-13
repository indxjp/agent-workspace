import type {
  ShareExpiry,
  ShareSubjectType,
  ShareVisibility,
} from '@indx-workspace/contracts/shares';

import type { VersionsLocale } from '../agents/versions-messages';

/**
 * The share dialog's words in the reader's language (UX-15 in #2086). The dialog is a client
 * component opened from several screens, so it reads the browser's language the way the run
 * view's own cards do (`browserLocale` in `run/attach-messages.ts`).
 */
export interface ShareStrings {
  readonly trigger: string;
  /** The dialog's accessible name and its heading, around the shared thing's label. */
  readonly dialogLabel: (label: string) => string;
  readonly heading: (label: string) => string;
  readonly intro: (type: ShareSubjectType) => string;
  readonly close: string;
  readonly whoCanSee: string;
  readonly visibility: Readonly<Record<ShareVisibility, string>>;
  readonly expiryLabel: string;
  readonly expiry: Readonly<Record<ShareExpiry, string>>;
  readonly passphrase: string;
  readonly cancel: string;
  readonly copyLink: string;
  readonly share: string;
  readonly sharedPrivately: string;
  readonly sharedWithWorkspace: string;
  /** After a public link is made; the link stays last so a hand copy picks up no full stop. */
  readonly oneTimeLink: (url: string, copied: boolean) => string;
  readonly notCreated: string;
}

const EN_TYPE: Readonly<Record<ShareSubjectType, string>> = {
  session: 'session',
  agent: 'agent',
  project: 'project',
  skill: 'skill',
};

const JA_TYPE: Readonly<Record<ShareSubjectType, string>> = {
  session: 'チャット',
  agent: 'エージェント',
  project: 'プロジェクト',
  skill: 'スキル',
};

const EN: ShareStrings = {
  trigger: 'Share',
  dialogLabel: (label) => `Share ${label}`,
  heading: (label) => `Share “${label}”`,
  intro: (type) => `Choose who can see this ${EN_TYPE[type]}.`,
  close: 'Close',
  whoCanSee: 'Who can see this',
  visibility: {
    private: 'Only me',
    workspace: 'Everyone in this workspace',
    public: 'Anyone with the link',
  },
  expiryLabel: 'Expiry',
  expiry: { '24 h': '24 h', '7 days': '7 days', '30 days': '30 days', never: 'never' },
  passphrase: 'Passphrase (optional)',
  cancel: 'Cancel',
  copyLink: 'Copy link',
  share: 'Share',
  sharedPrivately: 'Shared with you only.',
  sharedWithWorkspace: 'Shared with the workspace.',
  oneTimeLink: (url, copied) =>
    copied
      ? `Link copied. It won't be shown again, so save it now: ${url}`
      : `Copy this link now. It won't be shown again: ${url}`,
  notCreated: 'Share could not be created.',
};

const JA: ShareStrings = {
  trigger: '共有',
  dialogLabel: (label) => `${label} を共有`,
  heading: (label) => `「${label}」を共有`,
  intro: (type) => `この${JA_TYPE[type]}を見られる人を選んでください。`,
  close: '閉じる',
  whoCanSee: '見られる人',
  visibility: {
    private: '自分だけ',
    workspace: 'このワークスペースの全員',
    public: 'リンクを知っている全員',
  },
  expiryLabel: '有効期限',
  expiry: { '24 h': '24時間', '7 days': '7日', '30 days': '30日', never: '無期限' },
  passphrase: 'パスフレーズ（任意）',
  cancel: 'キャンセル',
  copyLink: 'リンクをコピー',
  share: '共有',
  sharedPrivately: '自分だけが見られるように共有しました。',
  sharedWithWorkspace: 'このワークスペースの全員に共有しました。',
  oneTimeLink: (url, copied) =>
    copied
      ? `リンクをコピーしました。このリンクは二度と表示されないので、今すぐ保存してください: ${url}`
      : `今すぐこのリンクをコピーしてください。二度と表示されません: ${url}`,
  notCreated: '共有を作成できませんでした。',
};

const STRINGS: Readonly<Record<VersionsLocale, ShareStrings>> = { en: EN, ja: JA };

export function shareStrings(locale: VersionsLocale): ShareStrings {
  return STRINGS[locale];
}
