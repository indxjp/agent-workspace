/**
 * The Settings, API keys and Shared links screens' own words in the reader's language (UX-15 in
 * #2086), in the shape of `../shell/shell-messages.ts`.
 *
 * English is the text these screens printed before, unchanged. What the server sends — endpoint
 * paths and status codes, key names and prefixes, a share's label, kind and mode — is shown as it
 * comes. Role names come from `../shell/shell-messages.ts`, so they read as the sidebar's do.
 */
import type { VersionsLocale } from '../agents/versions-messages';

export interface AdminStrings {
  readonly settingsTitle: string;
  readonly settingsManagersIntro: string;
  readonly settingsMembersIntro: string;
  readonly defaultModelHeading: string;
  /** The default-model card's sentence, around the literal `not set` it quotes. */
  readonly defaultModelBefore: string;
  readonly defaultModelAfter: string;
  readonly apiKeysTitle: string;
  readonly apiKeysIntro: string;
  readonly copyKeyNow: string;
  readonly keyName: string;
  readonly keyRole: string;
  readonly createKey: string;
  readonly revoke: string;
  readonly revoked: string;
  readonly sharesTitle: string;
  readonly sharesIntro: string;
  readonly publicSharing: string;
  readonly views: (count: number) => string;
  readonly spentOf: (spent: string, cap: string) => string;
  readonly shareRevoked: string;
  readonly shareSuspended: string;
  readonly shareStopped: string;
  readonly shareActive: string;
  readonly stop: string;
  readonly noShares: string;
  readonly loading: string;
}

const EN: AdminStrings = {
  settingsTitle: 'Settings',
  settingsManagersIntro:
    'Deployment subsystem status. Secrets and agent configuration stay out of this page.',
  settingsMembersIntro: 'The features of this workspace.',
  defaultModelHeading: 'Workspace default model',
  defaultModelBefore:
    'The model a run uses when neither the agent nor its project picks one. It cannot be changed from this screen yet. While it is ',
  defaultModelAfter:
    ', a run whose agent and project pick no model does not start, and says which setting is missing instead of guessing.',
  apiKeysTitle: 'API Keys',
  apiKeysIntro: 'Create scoped credentials; plaintext is shown exactly once.',
  copyKeyNow: 'Copy this key now',
  keyName: 'Key name',
  keyRole: 'Role',
  createKey: 'Create key',
  revoke: 'Revoke',
  revoked: 'Revoked',
  sharesTitle: 'Shared links',
  sharesIntro:
    'Every definition, snapshot and runnable link in this workspace. A public link is shown only once, when it is created.',
  publicSharing: 'Public sharing',
  views: (count) => `${String(count)} views`,
  spentOf: (spent, cap) => `$${spent} of $${cap}`,
  shareRevoked: 'Revoked',
  shareSuspended: 'Suspended',
  shareStopped: 'Stopped',
  shareActive: 'Active',
  stop: 'Stop',
  noShares: 'No links have been shared.',
  loading: 'Loading…',
};

const JA: AdminStrings = {
  settingsTitle: '設定',
  settingsManagersIntro:
    'デプロイの各サブシステムの状態です。シークレットとエージェントの設定はこのページには表示しません。',
  settingsMembersIntro: 'このワークスペースの機能です。',
  defaultModelHeading: 'ワークスペースの既定モデル',
  defaultModelBefore:
    'エージェントもプロジェクトもモデルを選んでいないときに、実行で使うモデルです。この画面からはまだ変更できません。',
  defaultModelAfter:
    ' のあいだは、エージェントとプロジェクトのどちらもモデルを選んでいない実行は開始されず、推測せずにどの設定が足りないかを表示します。',
  apiKeysTitle: 'API キー',
  apiKeysIntro: '権限を絞った認証情報を作成します。キーの値は一度だけ表示されます。',
  copyKeyNow: 'このキーを今すぐコピーしてください',
  keyName: 'キーの名前',
  keyRole: 'ロール',
  createKey: 'キーを作成',
  revoke: '無効にする',
  revoked: '無効',
  sharesTitle: '共有リンク',
  sharesIntro:
    'このワークスペースのすべての定義・スナップショット・実行可能なリンクです。公開リンクは作成したときに一度だけ表示されます。',
  publicSharing: '公開共有',
  views: (count) => `閲覧 ${String(count)} 回`,
  spentOf: (spent, cap) => `$${cap} のうち $${spent}`,
  shareRevoked: '無効',
  shareSuspended: '一時停止中',
  shareStopped: '停止',
  shareActive: '有効',
  stop: '停止する',
  noShares: '共有されたリンクはありません。',
  loading: '読み込み中…',
};

const STRINGS: Readonly<Record<VersionsLocale, AdminStrings>> = { en: EN, ja: JA };

export function adminStrings(locale: VersionsLocale): AdminStrings {
  return STRINGS[locale];
}
