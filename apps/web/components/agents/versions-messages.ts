/**
 * The Versions tab's own words in English and Japanese (issue #617, 80-10), in the shape of
 * `packages/react/src/locale.ts`. The rest of the console has no locale yet, so only this tab and
 * its tab bar read these. The plan text (`production: 2 -> 3`) and the problem codes are the CLI's
 * and the API's, and stay as they are in both.
 */
import type { AgentVersionProblemCode } from '@indx-workspace/contracts/agent-versions';

export type VersionsLocale = 'en' | 'ja';

/**
 * Every problem code the version routes answer: their own table plus RBAC's two. A `Record` over it
 * makes a code added to the contract fail `typecheck` until both languages say it.
 */
type VersionsRefusalCode = AgentVersionProblemCode | 'forbidden' | 'unauthenticated';

export interface VersionsStrings {
  readonly tabsLabel: string;
  readonly tabConfiguration: string;
  readonly tabVersions: string;
  readonly tabPlatforms: string;
  readonly heading: string;
  readonly loading: string;
  readonly loadFailed: string;
  readonly empty: string;
  readonly listLabel: string;
  readonly columnSelect: string;
  readonly columnVersion: string;
  readonly columnVia: string;
  readonly columnAuthor: string;
  readonly columnTime: string;
  readonly columnSummary: string;
  readonly columnScore: string;
  readonly selectVersion: (version: number) => string;
  readonly badgeLocal: string;
  readonly badgeProduction: string;
  readonly viaUi: string;
  readonly viaAwPush: string;
  readonly viaApi: string;
  readonly diffHeading: (older: number, newer: number) => string;
  readonly diffHint: string;
  readonly diffInstructions: string;
  readonly diffNoInstructionChanges: string;
  readonly diffFields: string;
  readonly diffNoFieldChanges: string;
  readonly diffField: string;
  readonly diffBefore: string;
  readonly diffAfter: string;
  readonly diffMissing: string;
  readonly releaseHeading: string;
  readonly promote: string;
  readonly rollback: string;
  readonly confirmPromote: string;
  readonly confirmRollback: string;
  readonly cancel: string;
  readonly working: string;
  readonly promoteBlurb: string;
  readonly rollbackBlurb: string;
  readonly noScore: string;
  readonly scoreCell: (score: string, passed: number, total: number) => string;
  readonly latestEvaluation: (
    version: number,
    score: string,
    passed: number,
    total: number,
  ) => string;
  readonly notEvaluatedYet: (version: number) => string;
  readonly planChanged: string;
  readonly noBar: string;
  readonly passesBar: (bar: string) => string;
  readonly notEvaluated: (version: number, bar: string) => string;
  readonly gateFailed: (version: number, score: string, bar: string, cases: string) => string;
  readonly refusals: Readonly<Record<VersionsRefusalCode, string>>;
  readonly unavailable: string;
  readonly moved: (plan: string) => string;
}

const EN: VersionsStrings = {
  tabsLabel: 'Agent sections',
  tabConfiguration: 'Configuration',
  tabVersions: 'Versions',
  tabPlatforms: 'Platforms',
  heading: 'Versions',
  loading: 'Loading versions…',
  loadFailed: 'The versions could not be loaded.',
  empty: 'This agent has no versions yet.',
  listLabel: 'Versions of this agent',
  columnSelect: 'Compare',
  columnVersion: 'Version',
  columnVia: 'Via',
  columnAuthor: 'Author',
  columnTime: 'Time',
  columnSummary: 'Summary',
  columnScore: 'Score',
  selectVersion: (version) => `Compare version ${String(version)}`,
  badgeLocal: 'local',
  badgeProduction: 'production',
  viaUi: 'Console',
  viaAwPush: 'aw push',
  viaApi: 'API',
  diffHeading: (older, newer) => `Version ${String(older)} to version ${String(newer)}`,
  diffHint: 'Select two versions to see what changed between them.',
  diffInstructions: 'Instructions',
  diffNoInstructionChanges: 'The instructions are the same.',
  diffFields: 'Other fields',
  diffNoFieldChanges: 'No other field changed.',
  diffField: 'Field',
  diffBefore: 'Before',
  diffAfter: 'After',
  diffMissing: 'not set',
  releaseHeading: 'Release',
  promote: 'Promote',
  rollback: 'Roll back',
  confirmPromote: 'Confirm promote',
  confirmRollback: 'Confirm roll back',
  cancel: 'Cancel',
  working: 'Working…',
  promoteBlurb: "Moves production to local's version.",
  rollbackBlurb: 'Moves production back to its previous version.',
  noScore: '—',
  scoreCell: (score, passed, total) => `${score} (${String(passed)}/${String(total)})`,
  latestEvaluation: (version, score, passed, total) =>
    `Latest evaluation of v${String(version)}: ${score} (${String(passed)}/${String(total)} cases)`,
  notEvaluatedYet: (version) => `v${String(version)} has not been evaluated.`,
  planChanged: 'The plan changed since you opened it. Review the new plan and confirm again.',
  noBar: 'No promotion bar is set; production needs no evaluation.',
  passesBar: (bar) => `The version passes the promotion bar (${bar}).`,
  notEvaluated: (version, bar) => `v${String(version)} has no evaluation (bar ${bar}).`,
  gateFailed: (version, score, bar, cases) =>
    `v${String(version)} scored ${score} (bar ${bar}). Failing cases: ${cases}`,
  refusals: {
    forbidden: 'Your role may not move production.',
    unauthenticated: 'Your session has ended. Sign in again.',
    invalid_agent_id: 'This agent address is not valid.',
    invalid_agent_version: 'The version is not valid.',
    unsupported_engine: "This deployment does not offer the version's engine.",
    dangerous_permission_mode_refused:
      'The version asks for a permission mode that is not allowed.',
    agent_not_found: 'This agent no longer exists.',
    agent_policy_not_configured: 'This deployment has no policy configured for agents.',
    agent_version_not_found: 'That version does not exist.',
    no_pointer: 'local points at no version, so there is nothing to promote.',
    nothing_to_roll_back: 'production has no earlier version to go back to.',
    promotion_not_evaluated: 'The version has no evaluation, which the promotion bar requires.',
    promotion_gate_failed: 'The version scored below the promotion bar.',
    code_tool_needs_host:
      'The version uses code tools, and this deployment cannot run them: the operator must enable the tool sandbox, or the version needs its bundles pushed again.',
    network_policy_unsupported:
      "The version's code tools declare network domains that this deployment's tool sandbox cannot enforce: remove allowedDomains, or deploy where the tool sandbox enforces them.",
    stdio_connector_needs_tool_sandbox:
      'The version uses stdio connectors, which run only in a tool sandbox this deployment does not start for them, so production cannot run it yet.',
    agent_definition_references_missing: 'The version names resources that do not exist here.',
    agent_definition_reference_ambiguous: 'The version names resources that match more than one.',
    agent_subagent_unusable:
      'The version nests subagents: a subagent must exist here and have none of its own, and an agent that is a subagent cannot have any.',
    engine_capability_unsupported:
      "The version's engine cannot honour a connector or skill it uses.",
    engine_switch_would_widen: 'The version switches engine in a way that would widen the agent.',
    policy_cannot_widen: "The version asks for more than the deployment's policy allows.",
    surface_name_taken: 'Another surface in this workspace already has that name.',
    agent_name_conflict: 'Another agent in this workspace already has that name.',
    tool_bundle_unknown:
      'The version pins tool bundles this workspace has not received. Run aw push --yes to upload them.',
    tool_bundles_not_configured: 'This deployment has no store for tool bundles.',
  },
  unavailable: 'The request could not be completed. Try again.',
  moved: (plan) => `Done: ${plan}`,
};

const JA: VersionsStrings = {
  tabsLabel: 'エージェントのセクション',
  tabConfiguration: '設定',
  tabVersions: 'バージョン',
  tabPlatforms: 'プラットフォーム',
  heading: 'バージョン',
  loading: 'バージョンを読み込んでいます…',
  loadFailed: 'バージョンを読み込めませんでした。',
  empty: 'このエージェントにはまだバージョンがありません。',
  listLabel: 'このエージェントのバージョン',
  columnSelect: '比較',
  columnVersion: 'バージョン',
  columnVia: '保存元',
  columnAuthor: '作成者',
  columnTime: '日時',
  columnSummary: '概要',
  columnScore: 'スコア',
  selectVersion: (version) => `バージョン ${String(version)} を比較に選ぶ`,
  badgeLocal: 'local',
  badgeProduction: 'production',
  viaUi: 'コンソール',
  viaAwPush: 'aw push',
  viaApi: 'API',
  diffHeading: (older, newer) => `バージョン ${String(older)} からバージョン ${String(newer)} へ`,
  diffHint: '2 つのバージョンを選ぶと、その間の変更を表示します。',
  diffInstructions: '指示文',
  diffNoInstructionChanges: '指示文は同じです。',
  diffFields: 'その他の項目',
  diffNoFieldChanges: '他に変更された項目はありません。',
  diffField: '項目',
  diffBefore: '変更前',
  diffAfter: '変更後',
  diffMissing: '未設定',
  releaseHeading: 'リリース',
  promote: '昇格',
  rollback: 'ロールバック',
  confirmPromote: '昇格を確定',
  confirmRollback: 'ロールバックを確定',
  cancel: 'キャンセル',
  working: '処理中…',
  promoteBlurb: 'production を local のバージョンに進めます。',
  rollbackBlurb: 'production をひとつ前のバージョンに戻します。',
  noScore: '—',
  scoreCell: (score, passed, total) => `${score}（${String(passed)}/${String(total)}）`,
  latestEvaluation: (version, score, passed, total) =>
    `v${String(version)} の最新の評価: ${score}（${String(passed)}/${String(total)} ケース）`,
  notEvaluatedYet: (version) => `v${String(version)} はまだ評価されていません。`,
  planChanged: '開いた後に計画が変わりました。新しい計画を確認して、もう一度確定してください。',
  noBar: '昇格の基準は設定されていません。production に評価は不要です。',
  passesBar: (bar) => `このバージョンは昇格の基準（${bar}）を満たしています。`,
  notEvaluated: (version, bar) => `v${String(version)} は未評価です（基準 ${bar}）。`,
  gateFailed: (version, score, bar, cases) =>
    `v${String(version)} のスコアは ${score} で、基準（${bar}）に届きません。失敗したケース: ${cases}`,
  refusals: {
    forbidden: 'あなたのロールでは production を動かせません。',
    unauthenticated: 'セッションが終了しました。もう一度サインインしてください。',
    invalid_agent_id: 'このエージェントのアドレスが正しくありません。',
    invalid_agent_version: 'このバージョンは正しくありません。',
    unsupported_engine: 'このバージョンのエンジンは、この環境では利用できません。',
    dangerous_permission_mode_refused:
      'このバージョンは、許可されていない権限モードを求めています。',
    agent_not_found: 'このエージェントは存在しません。',
    agent_policy_not_configured: 'この環境にはエージェントのポリシーが設定されていません。',
    agent_version_not_found: '指定されたバージョンは存在しません。',
    no_pointer: 'local がどのバージョンも指していないため、昇格するものがありません。',
    nothing_to_roll_back: 'production には戻せる以前のバージョンがありません。',
    promotion_not_evaluated: '昇格の基準で必要な評価が、このバージョンにはありません。',
    promotion_gate_failed: 'このバージョンのスコアは昇格の基準に届きません。',
    code_tool_needs_host:
      'このバージョンはコードツールを使いますが、このデプロイメントでは実行できません。運用者がツールサンドボックスを有効にするか、バンドルを再度プッシュしてください。',
    network_policy_unsupported:
      'このバージョンのコードツールは許可ドメインを宣言していますが、このデプロイメントのツールサンドボックスでは強制できません。allowedDomains を外すか、ツールサンドボックスが強制できる環境にデプロイしてください。',
    stdio_connector_needs_tool_sandbox:
      'このバージョンは stdio コネクタを使います。この環境はそのためのツールサンドボックスを起動しないため、production ではまだ動かせません。',
    agent_definition_references_missing: 'このバージョンが指定するリソースが、ここに存在しません。',
    agent_definition_reference_ambiguous:
      'このバージョンが指定する名前に、複数のリソースが一致します。',
    agent_subagent_unusable:
      'このバージョンはサブエージェントを入れ子にしています。サブエージェントはここに存在し、自身はサブエージェントを持たない必要があります。また、サブエージェントであるエージェントはサブエージェントを持てません。',
    engine_capability_unsupported:
      '使用中のコネクタまたはスキルに、このバージョンのエンジンが対応していません。',
    engine_switch_would_widen:
      'このバージョンのエンジン変更は、エージェントの権限を広げてしまいます。',
    policy_cannot_widen: 'このバージョンは、環境のポリシーが許す範囲を超えています。',
    surface_name_taken: 'このワークスペースの別のサーフェスが、すでにその名前を使っています。',
    agent_name_conflict: 'このワークスペースの別のエージェントが、すでにその名前を使っています。',
    tool_bundle_unknown:
      'このバージョンが指定するツールバンドルが、このワークスペースにまだありません。aw push --yes でアップロードしてください。',
    tool_bundles_not_configured: 'この環境にはツールバンドルの保存先がありません。',
  },
  unavailable: '処理を完了できませんでした。もう一度お試しください。',
  moved: (plan) => `完了しました: ${plan}`,
};

const STRINGS: Readonly<Record<VersionsLocale, VersionsStrings>> = { en: EN, ja: JA };

export function versionsStrings(locale: VersionsLocale): VersionsStrings {
  return STRINGS[locale];
}

/** The sentence for a refusal code; a code this tab has no words for gets the generic one. */
export function refusalText(code: string, strings: VersionsStrings): string {
  return Object.hasOwn(strings.refusals, code)
    ? strings.refusals[code as VersionsRefusalCode]
    : strings.unavailable;
}

const Q_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;

/**
 * The language of the `Accept-Language` list this tab speaks that ranks highest by q-value, then
 * list order (RFC 9110 §12.5.4), matched on the primary subtag; `en` when none is listed. A missing
 * or malformed q counts as 1, and `q=0` means "not acceptable".
 */
export function versionsLocaleOf(acceptLanguage: string | null): VersionsLocale {
  const ranges = (acceptLanguage ?? '').split(',').map((entry, order) => {
    const [tag = '', ...params] = entry.split(';').map((part) => part.trim().toLowerCase());
    const q = params.find((param) => param.startsWith('q='))?.slice(2) ?? '';
    return { primary: tag.split('-')[0], weight: Q_VALUE.test(q) ? Number(q) : 1, order };
  });
  const best = ranges
    .filter(({ primary, weight }) => weight > 0 && (primary === 'ja' || primary === 'en'))
    .sort((a, b) => b.weight - a.weight || a.order - b.order)[0];
  return best?.primary === 'ja' ? 'ja' : 'en';
}
