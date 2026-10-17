/**
 * The Platforms tab's own words in English and Japanese (issue #973), in the shape of
 * `versions-messages.ts`. Platform display names, field paths, problem codes and the publish command
 * are identifiers and stay as they are in both. This tab says "Platform", never "Runtime": the
 * platform id `aws-agentcore` is spelled like the runtime driver of the same name.
 */
import type { FieldVerdict, PlatformExportProblemCode } from '@indx-workspace/contracts/platforms';

import type { VersionsLocale } from './versions-messages';
import type { VerdictCounts } from './platforms-model';

/**
 * Every problem code the export routes answer, plus RBAC's two. A `Record` over it makes a code
 * added to the contract fail `typecheck` until both languages say it.
 */
type PlatformsRefusalCode = PlatformExportProblemCode | 'forbidden' | 'unauthenticated';

export interface PlatformsStrings {
  readonly heading: string;
  readonly loading: string;
  readonly loadFailed: string;
  readonly empty: string;
  readonly versionLabel: string;
  readonly versionOption: (version: number, summary: string, badges: readonly string[]) => string;
  readonly badgeLocal: string;
  readonly badgeProduction: string;
  readonly matrixCaption: string;
  readonly columnPlatform: string;
  readonly newTab: string;
  readonly resultRegion: string;
  readonly columnCheck: string;
  readonly noCheck: string;
  readonly check: (platform: string) => string;
  readonly checking: string;
  readonly resultHeading: (platform: string, version: number) => string;
  readonly verdictCaption: string;
  readonly columnField: string;
  readonly columnVerdict: string;
  readonly columnWhy: string;
  readonly summary: (counts: VerdictCounts) => string;
  readonly download: string;
  readonly downloading: string;
  readonly publishLabel: string;
  readonly publishHint: string;
  readonly cardUrlLabel: string;
  readonly copy: string;
  readonly copied: string;
  readonly copyFailed: string;
  readonly refusalDetails: string;
  readonly refusals: Readonly<Record<PlatformsRefusalCode, string>>;
  readonly verdicts: Readonly<Record<FieldVerdict['verdict'], string>>;
  readonly capabilities: Readonly<Record<'native' | 'mapped' | 'unsupported', string>>;
  readonly unavailable: string;
}

const EN: PlatformsStrings = {
  heading: 'Platforms',
  loading: 'Loading platforms…',
  loadFailed: 'The platforms could not be loaded.',
  empty: 'This agent has no saved versions yet, so there is nothing to check.',
  versionLabel: 'Version to check',
  versionOption: (version, summary, badges) =>
    `v${String(version)} · ${summary}${badges.map((badge) => ` (${badge})`).join('')}`,
  badgeLocal: 'local',
  badgeProduction: 'production',
  matrixCaption: 'What each platform can carry of an agent',
  columnPlatform: 'Platform',
  newTab: '(opens in a new tab)',
  resultRegion: 'Check result',
  columnCheck: 'Check',
  noCheck: 'Export only',
  check: (platform) => `Check ${platform}`,
  checking: 'Checking…',
  resultHeading: (platform, version) => `${platform}, version ${String(version)}`,
  verdictCaption: 'What happens to each field on this platform',
  columnField: 'Field',
  columnVerdict: 'Verdict',
  columnWhy: 'Why',
  summary: (counts) =>
    `${String(counts.native)} native · ${String(counts.mapped)} mapped · ${String(counts.dropped)} dropped`,
  download: 'Download bundle',
  downloading: 'Downloading…',
  publishLabel: 'Publish command',
  publishHint:
    'Run it in a terminal where aw is signed in. Publishing is not done from the browser.',
  cardUrlLabel: 'A2A Agent Card URL',
  copy: 'Copy',
  copied: 'Copied.',
  copyFailed: 'The text could not be copied. Select it and copy it by hand.',
  refusalDetails: 'Details',
  refusals: {
    forbidden: "Only the agent's owner or an admin can export it.",
    unauthenticated: 'Your session has ended. Sign in again.',
    invalid_agent_id: 'This agent address is not valid.',
    invalid_platform_export: 'The export request is not valid.',
    platform_options_invalid: "The platform's options in this version are not valid.",
    agent_not_found: 'This agent no longer exists.',
    agent_version_not_found: 'That version does not exist.',
    agent_name_not_portable:
      'The agent name must be lower-case words joined by hyphens before it can be exported.',
    platform_model_unsupported: "This platform cannot run the version's model.",
    platform_limit_exceeded: "The version exceeds one of this platform's limits.",
    platform_agent_not_found: 'A subagent of this version names an agent that does not exist.',
    platform_export_too_large: 'The export is larger than the size this deployment allows.',
    agent_policy_not_configured: 'This deployment has no policy configured for agents.',
  },
  verdicts: { native: 'native', mapped: 'mapped', dropped: 'dropped' },
  capabilities: { native: 'native', mapped: 'mapped', unsupported: 'unsupported' },
  unavailable: 'The request could not be completed. Try again.',
};

const JA: PlatformsStrings = {
  heading: 'プラットフォーム',
  loading: 'プラットフォームを読み込んでいます…',
  loadFailed: 'プラットフォームを読み込めませんでした。',
  empty: 'このエージェントには保存されたバージョンがまだないため、確認するものがありません。',
  versionLabel: '確認するバージョン',
  versionOption: (version, summary, badges) =>
    `v${String(version)} · ${summary}${badges.map((badge) => `（${badge}）`).join('')}`,
  badgeLocal: 'local',
  badgeProduction: 'production',
  matrixCaption: '各プラットフォームがエージェントのどこまで対応するか',
  columnPlatform: 'プラットフォーム',
  newTab: '（新しいタブで開きます）',
  resultRegion: '確認結果',
  columnCheck: '確認',
  noCheck: 'エクスポートのみ',
  check: (platform) => `${platform} を確認する`,
  checking: '確認しています…',
  resultHeading: (platform, version) => `${platform}、バージョン ${String(version)}`,
  verdictCaption: 'このプラットフォームでの各項目の扱い',
  columnField: '項目',
  columnVerdict: '判定',
  columnWhy: '理由',
  summary: (counts) =>
    `ネイティブ ${String(counts.native)} · マッピング ${String(counts.mapped)} · 除外 ${String(counts.dropped)}`,
  download: 'バンドルをダウンロード',
  downloading: 'ダウンロードしています…',
  publishLabel: '公開コマンド',
  publishHint:
    'aw にサインインしたターミナルで実行してください。公開はブラウザーからは行いません。',
  cardUrlLabel: 'A2A Agent Card URL',
  copy: 'コピー',
  copied: 'コピーしました。',
  copyFailed: 'コピーできませんでした。文字列を選択して手動でコピーしてください。',
  refusalDetails: '詳細',
  refusals: {
    forbidden: 'エクスポートできるのは、エージェントのオーナーまたは管理者だけです。',
    unauthenticated: 'セッションが終了しました。もう一度サインインしてください。',
    invalid_agent_id: 'このエージェントのアドレスが正しくありません。',
    invalid_platform_export: 'エクスポートのリクエストが正しくありません。',
    platform_options_invalid: 'このバージョンのプラットフォーム設定が正しくありません。',
    agent_not_found: 'このエージェントは存在しません。',
    agent_version_not_found: '指定されたバージョンは存在しません。',
    agent_name_not_portable:
      'エクスポートするには、エージェント名を小文字の単語をハイフンでつないだ形にしてください。',
    platform_model_unsupported:
      'このプラットフォームは、このバージョンのモデルに対応していません。',
    platform_limit_exceeded: 'このバージョンは、プラットフォームの上限を超えています。',
    platform_agent_not_found:
      'このバージョンのサブエージェントが、存在しないエージェントを指しています。',
    platform_export_too_large: 'エクスポートが、この環境で許可されているサイズを超えています。',
    agent_policy_not_configured: 'この環境にはエージェントのポリシーが設定されていません。',
  },
  verdicts: { native: 'ネイティブ', mapped: 'マッピング', dropped: '除外' },
  capabilities: { native: 'ネイティブ', mapped: 'マッピング', unsupported: '非対応' },
  unavailable: '処理を完了できませんでした。もう一度お試しください。',
};

const STRINGS: Readonly<Record<VersionsLocale, PlatformsStrings>> = { en: EN, ja: JA };

export function platformsStrings(locale: VersionsLocale): PlatformsStrings {
  return STRINGS[locale];
}

/** The sentence for a refusal code; a code this tab has no words for gets the generic one. */
export function platformRefusalText(code: string, strings: PlatformsStrings): string {
  return Object.hasOwn(strings.refusals, code)
    ? strings.refusals[code as PlatformsRefusalCode]
    : strings.unavailable;
}
