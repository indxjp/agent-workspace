/**
 * The Runs screen's own words in the reader's language (UX-15 in #2086): the list, its filters, the
 * detail panel, and the words `./history.ts` builds for a run's cost, duration and model, in the
 * shape of `../team/team-messages.ts`.
 *
 * English is the text this screen printed before, unchanged; the status badges follow the run
 * view's (`./run-view-messages.ts`), so no screen mixes languages. What the server sends — an
 * agent, project, user or workspace name, an id, an error or accounting error, a problem's
 * sentence — is shown as it comes.
 */
import type { VersionsLocale } from '../agents/versions-messages';

/** The words `./history.ts` builds a run's figures from. */
export interface RunFigureWords {
  readonly pending: string;
  readonly unavailable: string;
  readonly accountingFailed: (reason: string | null) => string;
  readonly actual: string;
  readonly partial: string;
  readonly notStarted: string;
  readonly inProgress: string;
  readonly unknownDuration: string;
  readonly milliseconds: (ms: string) => string;
  readonly hoursMinutesSeconds: (hours: string, minutes: string, seconds: string) => string;
  readonly minutesSeconds: (minutes: string, seconds: string) => string;
  readonly seconds: (seconds: string) => string;
  readonly notYetResolved: string;
}

export interface RunsStrings extends RunFigureWords {
  /** The page's placeholder while the screen itself loads. */
  readonly loading: string;
  readonly title: string;
  readonly intro: string;
  readonly loadingRuns: string;
  /** Another language's lead over a failed list; English shows the failure alone. */
  readonly runsLoadFailed: string;
  readonly noRuns: string;
  readonly noSearchMatch: string;
  readonly columns: readonly string[];
  readonly deletedAgent: string;
  readonly notAvailable: string;
  readonly noLongerMember: string;
  readonly openRunLabel: (id: string) => string;
  readonly open: string;
  readonly nextPage: string;
  readonly searchThisPage: string;
  readonly searchPlaceholder: string;
  readonly status: string;
  readonly allStatuses: string;
  readonly agent: string;
  readonly allAgents: string;
  readonly project: string;
  readonly allProjects: string;
  readonly startedBy: string;
  readonly everyone: string;
  readonly clearFilters: string;

  readonly backToRuns: string;
  readonly loadingRun: string;
  /** Another language's lead over a failed run; English shows the failure alone. */
  readonly runLoadFailed: string;
  /** "No run <id> exists in this workspace.", split around the id. */
  readonly noRunBefore: string;
  readonly noRunAfter: string;
  readonly notAvailableParen: string;
  readonly run: string;
  readonly created: string;
  readonly openConversation: string;
  readonly rawSessionData: string;
  readonly duration: string;
  readonly totalTokens: string;
  readonly toolCalls: string;
  readonly cost: string;
  readonly noAgent: string;
  readonly noProject: string;
  readonly deletedProject: string;
  readonly unknown: string;
  readonly workspace: string;
  readonly providerModel: string;
  readonly technicalDetails: string;
  readonly usage: string;
  readonly accountingState: string;
  /** Each accounting state by its name; a name not listed is shown as it came. */
  readonly accountingStates: Readonly<Record<string, string>>;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly cacheRead: string;
  readonly cacheWrite: string;
  readonly priceTable: string;
  readonly accountingError: string;
  readonly runtime: string;
  readonly started: string;
  readonly ended: string;
  readonly session: string;
  readonly error: string;
}

const EN: RunsStrings = {
  loading: 'Loading…',
  title: 'Runs',
  intro: 'Every run in this workspace that your role lets you see, newest first.',
  loadingRuns: 'Loading runs…',
  runsLoadFailed: 'The runs could not be loaded.',
  noRuns: 'No runs match these filters yet.',
  noSearchMatch: 'No runs on this page match that search.',
  columns: [
    'Started',
    'Agent',
    'Status',
    'Started by',
    'Provider / model',
    'Duration',
    'Tokens',
    'Cost',
  ],
  deletedAgent: 'Deleted agent',
  notAvailable: 'Not available',
  noLongerMember: 'No longer a member',
  openRunLabel: (id) => `Open run ${id}`,
  open: 'Open',
  nextPage: 'Next page →',
  searchThisPage: 'Search this page',
  searchPlaceholder: 'Run, model, or name',
  status: 'Status',
  allStatuses: 'All statuses',
  agent: 'Agent',
  allAgents: 'All agents',
  project: 'Project',
  allProjects: 'All projects',
  startedBy: 'Started by',
  everyone: 'Everyone',
  clearFilters: 'Clear filters',

  backToRuns: '← Back to Runs',
  loadingRun: 'Loading run…',
  runLoadFailed: 'The run could not be loaded.',
  noRunBefore: 'No run ',
  noRunAfter: ' exists in this workspace.',
  notAvailableParen: '(not available)',
  run: 'Run',
  created: 'Created',
  openConversation: 'Open conversation',
  rawSessionData: 'raw session data',
  duration: 'Duration',
  totalTokens: 'Total tokens',
  toolCalls: 'Tool calls',
  cost: 'Cost',
  noAgent: 'No agent',
  noProject: 'No project',
  deletedProject: 'Deleted project',
  unknown: 'Unknown',
  workspace: 'Workspace',
  providerModel: 'Provider / model',
  technicalDetails: 'Technical details',
  usage: 'Usage',
  accountingState: 'Accounting state',
  accountingStates: {},
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  priceTable: 'Price table',
  accountingError: 'Accounting error',
  runtime: 'Runtime',
  started: 'Started',
  ended: 'Ended',
  session: 'Session',
  error: 'Error',

  pending: 'Pending',
  unavailable: 'Unavailable',
  accountingFailed: (reason) => `Accounting failed${reason === null ? '' : ` — ${reason}`}`,
  actual: 'Actual',
  partial: 'Partial',
  notStarted: 'Not started',
  inProgress: 'In progress',
  unknownDuration: 'Unknown duration',
  milliseconds: (ms) => `${ms} ms`,
  hoursMinutesSeconds: (hours, minutes, seconds) => `${hours} h ${minutes} m ${seconds} s`,
  minutesSeconds: (minutes, seconds) => `${minutes} m ${seconds} s`,
  seconds: (seconds) => `${seconds} s`,
  notYetResolved: 'Not yet resolved',
};

const JA: RunsStrings = {
  loading: '読み込み中…',
  title: '実行',
  intro: 'このワークスペースの実行のうち、あなたのロールで見られるものを新しい順に表示します。',
  loadingRuns: '実行を読み込み中…',
  runsLoadFailed: '実行の一覧を読み込めませんでした。',
  noRuns: 'この条件に合う実行はまだありません。',
  noSearchMatch: 'このページには、その検索に合う実行はありません。',
  columns: [
    '開始日時',
    'エージェント',
    '状態',
    '開始した人',
    'プロバイダー / モデル',
    '所要時間',
    'トークン',
    'コスト',
  ],
  deletedAgent: '削除されたエージェント',
  notAvailable: '取得できません',
  noLongerMember: 'メンバーではなくなりました',
  openRunLabel: (id) => `実行 ${id} を開く`,
  open: '開く',
  nextPage: '次のページ →',
  searchThisPage: 'このページを検索',
  searchPlaceholder: '実行、モデル、名前',
  status: '状態',
  allStatuses: 'すべての状態',
  agent: 'エージェント',
  allAgents: 'すべてのエージェント',
  project: 'プロジェクト',
  allProjects: 'すべてのプロジェクト',
  startedBy: '開始した人',
  everyone: '全員',
  clearFilters: '絞り込みを解除',

  backToRuns: '← 実行の一覧に戻る',
  loadingRun: '実行を読み込み中…',
  runLoadFailed: 'この実行を読み込めませんでした。',
  noRunBefore: 'このワークスペースに実行 ',
  noRunAfter: ' はありません。',
  notAvailableParen: '（取得できません）',
  run: '実行',
  created: '作成',
  openConversation: '会話を開く',
  rawSessionData: 'セッションの生データ',
  duration: '所要時間',
  totalTokens: '合計トークン',
  toolCalls: 'ツール呼び出し',
  cost: 'コスト',
  noAgent: 'エージェントなし',
  noProject: 'プロジェクトなし',
  deletedProject: '削除されたプロジェクト',
  unknown: '不明',
  workspace: 'ワークスペース',
  providerModel: 'プロバイダー / モデル',
  technicalDetails: '技術的な詳細',
  usage: '使用量',
  accountingState: '集計の状態',
  accountingStates: {
    pending: '集計待ち',
    complete: '確定',
    partial: '一部のみ',
    failed: '失敗',
    unavailable: '利用不可',
  },
  inputTokens: '入力トークン',
  outputTokens: '出力トークン',
  cacheRead: 'キャッシュ読み取り',
  cacheWrite: 'キャッシュ書き込み',
  priceTable: '料金表',
  accountingError: '集計のエラー',
  runtime: 'ランタイム',
  started: '開始',
  ended: '終了',
  session: 'セッション',
  error: 'エラー',

  pending: '集計待ち',
  unavailable: '利用不可',
  accountingFailed: (reason) => `集計に失敗しました${reason === null ? '' : ` — ${reason}`}`,
  actual: '実績',
  partial: '一部のみ',
  notStarted: '未開始',
  inProgress: '実行中',
  unknownDuration: '所要時間は不明',
  milliseconds: (ms) => `${ms} ミリ秒`,
  hoursMinutesSeconds: (hours, minutes, seconds) => `${hours} 時間 ${minutes} 分 ${seconds} 秒`,
  minutesSeconds: (minutes, seconds) => `${minutes} 分 ${seconds} 秒`,
  seconds: (seconds) => `${seconds} 秒`,
  notYetResolved: 'まだ決まっていません',
};

const STRINGS: Readonly<Record<VersionsLocale, RunsStrings>> = { en: EN, ja: JA };

export function runsStrings(locale: VersionsLocale = 'en'): RunsStrings {
  return STRINGS[locale];
}

/** An accounting state in the reader's words, or as it came when it has none. */
export function accountingStateText(state: string, strings: RunsStrings): string {
  return Object.hasOwn(strings.accountingStates, state)
    ? (strings.accountingStates[state] ?? state)
    : state;
}
