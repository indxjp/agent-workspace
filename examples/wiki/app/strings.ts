import type { RunStatus } from '@indx-workspace/contracts/runs';
import type { SurfaceLocale } from '@indx-workspace/contracts/surfaces';

import type { PortalNavItem } from './nav';
import { theme } from './theme';

/** What the sign-in page can say went wrong, whichever refusal code sent the person back. */
type SignInErrorKey =
  | 'notConfigured'
  | 'notMember'
  | 'expired'
  | 'rateLimited'
  | 'unavailable'
  | 'refused';

/** Every word the portal's own pages show, in each language `theme.locale` may name. */
export interface PortalStrings {
  readonly nav: Readonly<Record<PortalNavItem['id'], string>>;
  readonly navLabel: string;
  readonly dashboardTitle: string;
  readonly recentRuns: string;
  readonly fileCount: (count: number) => string;
  readonly chatTitle: string;
  readonly filesTitle: string;
  readonly fileName: string;
  readonly fileSize: string;
  readonly fileModified: string;
  readonly noFiles: string;
  readonly runsTitle: string;
  readonly runTitle: (id: string) => string;
  readonly runStarted: string;
  readonly runStatus: string;
  readonly noRuns: string;
  readonly following: string;
  readonly status: Readonly<Record<RunStatus, string>>;
  readonly signInTitle: string;
  readonly signInBody: string;
  readonly signInHelp: string;
  readonly signIn: string;
  readonly signOut: string;
  readonly signInPageTitle: string;
  readonly signInPageBody: string;
  /** What the sign-in page says when the sign-in sent the person back with a refusal. */
  readonly signInErrors: Readonly<Record<SignInErrorKey, string>>;
  readonly notAvailable: string;
  readonly failed: string;
  readonly home: string;
}

const STRINGS: Readonly<Record<SurfaceLocale, PortalStrings>> = {
  en: {
    nav: {
      home: 'Home',
      wiki: 'Wiki',
      chat: 'Chat',
      files: 'Files',
      runs: 'Runs',
      recipes: 'Recipes',
    },
    navLabel: 'Portal',
    dashboardTitle: 'wiki',
    recentRuns: 'Recent runs',
    fileCount: (count) => (count === 1 ? '1 file' : `${String(count)} files`),
    chatTitle: 'Chat',
    filesTitle: 'Files',
    fileName: 'Name',
    fileSize: 'Size',
    fileModified: 'Modified',
    noFiles: 'There are no files yet.',
    runsTitle: 'Runs',
    runTitle: (id) => `Run ${id}`,
    runStarted: 'Started',
    runStatus: 'Status',
    noRuns: 'There are no runs yet.',
    following: 'Following the run until it ends…',
    status: {
      queued: 'Queued',
      running: 'Running',
      awaiting_approval: 'Awaiting approval',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    signInTitle: 'Sign in required',
    signInBody:
      'This page shows what you may see in Agent Workspace, so it needs you to be signed in. Signing in uses your workspace’s OpenID Connect issuer.',
    signInHelp: 'How to set up sign-in',
    signIn: 'Sign in',
    signOut: 'Sign out',
    signInPageTitle: 'Sign in to wiki',
    signInPageBody:
      'You sign in with your workspace’s identity provider. A sign-in lasts five minutes; after that, signing in again takes one click.',
    signInErrors: {
      notConfigured: 'Sign-in is not set up for this portal yet. Ask the person who runs it.',
      notMember: 'You are not a member of this workspace. Ask an Owner to invite you.',
      expired: 'That sign-in took too long or was started elsewhere. Sign in again.',
      rateLimited: 'There were too many sign-ins. Wait a minute and try again.',
      unavailable: 'The sign-in service did not answer. Try again in a moment.',
      refused: 'You were not signed in. Try again.',
    },
    notAvailable:
      'Agent Workspace does not serve this to the portal’s sign-in yet. Open it in the Agent Workspace console instead.',
    failed: 'Agent Workspace could not be reached. Reload the page to try again.',
    home: 'Back to the home page',
  },
  ja: {
    nav: { home: 'ホーム', wiki: 'ウィキ', chat: 'チャット', files: 'ファイル', runs: '実行', recipes: 'レシピ' },
    navLabel: 'ポータル',
    dashboardTitle: 'wiki',
    recentRuns: '最近の実行',
    fileCount: (count) => `${String(count)} 件のファイル`,
    chatTitle: 'チャット',
    filesTitle: 'ファイル',
    fileName: '名前',
    fileSize: 'サイズ',
    fileModified: '更新日時',
    noFiles: 'ファイルはまだありません。',
    runsTitle: '実行',
    runTitle: (id) => `実行 ${id}`,
    runStarted: '開始',
    runStatus: '状態',
    noRuns: '実行はまだありません。',
    following: '実行が終わるまで追跡しています…',
    status: {
      queued: '待機中',
      running: '実行中',
      awaiting_approval: '承認待ち',
      completed: '完了',
      failed: '失敗',
      cancelled: '取り消し',
    },
    signInTitle: 'サインインが必要です',
    signInBody:
      'このページは Agent Workspace であなたが見られる内容を表示するため、サインインが必要です。サインインにはワークスペースの OpenID Connect 発行者を使います。',
    signInHelp: 'サインインの設定方法',
    signIn: 'サインイン',
    signOut: 'サインアウト',
    signInPageTitle: 'wiki にサインイン',
    signInPageBody:
      'ワークスペースの ID プロバイダーでサインインします。サインインは 5 分間有効で、その後はワンクリックで再びサインインできます。',
    signInErrors: {
      notConfigured: 'このポータルのサインインはまだ設定されていません。管理者に問い合わせてください。',
      notMember: 'このワークスペースのメンバーではありません。オーナーに招待を依頼してください。',
      expired: 'サインインに時間がかかりすぎたか、別の場所で開始されました。もう一度サインインしてください。',
      rateLimited: 'サインインの回数が多すぎます。1 分ほど待ってからもう一度お試しください。',
      unavailable: 'サインインのサービスが応答しませんでした。しばらくしてからもう一度お試しください。',
      refused: 'サインインできませんでした。もう一度お試しください。',
    },
    notAvailable:
      'Agent Workspace はこの内容をポータルのサインインにはまだ提供していません。Agent Workspace のコンソールで開いてください。',
    failed: 'Agent Workspace に接続できませんでした。ページを再読み込みしてください。',
    home: 'ホームに戻る',
  },
};

/** The portal's words in the language `app/theme.ts` names. */
export const strings: PortalStrings = STRINGS[theme.locale];
