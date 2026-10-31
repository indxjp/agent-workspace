/**
 * The words of the Features card, its confirmation and the switched-off panel (ADR-0160 D8, issue
 * #1497) in English and Japanese, in the shape of `../agents/versions-messages.ts`, whose
 * `Accept-Language` negotiation they share. The navigation entries a confirmation names are §44's
 * labels, which the sidebar prints untranslated, so they stay as they are in both languages.
 */
import type { FeatureId } from '@indx-workspace/contracts/features';

import type { VersionsLocale } from '../agents/versions-messages';

/** The console's locale, negotiated from `Accept-Language` by `versionsLocaleOf`. */
export type FeaturesLocale = VersionsLocale;

/** The refusals `PUT /api/workspaces/:id/features` answers that the card has words for. */
export const FEATURES_REFUSAL_CODES = [
  'feature_in_use',
  'feature_not_installed',
  'forbidden',
  'unauthenticated',
] as const;
type FeaturesRefusalCode = (typeof FEATURES_REFUSAL_CODES)[number];

export interface FeaturesStrings {
  /** A `Record` over every id, so a feature added to the contract fails `typecheck` until named. */
  readonly labels: Readonly<Record<FeatureId, string>>;
  readonly heading: string;
  readonly intro: string;
  readonly readOnly: string;
  readonly loading: string;
  readonly loadFailed: string;
  readonly listLabel: string;
  /** What joins the labels of a list in a sentence. */
  readonly listSeparator: string;
  readonly on: string;
  readonly off: string;
  readonly saving: string;
  readonly needs: (labels: string) => string;
  readonly neededBy: (labels: string) => string;
  readonly notInstalled: string;
  readonly blockedNeededBy: (labels: string) => string;
  readonly blockedNeeds: (labels: string) => string;
  readonly dialogTitle: (label: string) => string;
  readonly dialogHides: (entries: string) => string;
  readonly dialogHidesNothing: string;
  readonly dialogDataKept: string;
  readonly cancel: string;
  readonly confirm: (label: string) => string;
  readonly refusals: Readonly<Record<FeaturesRefusalCode, string>>;
  readonly unavailable: string;
  readonly offHeading: (label: string) => string;
  readonly offNothingDeleted: string;
  readonly offOwnerCanSwitch: string;
  readonly offSettingsLink: string;
  readonly fullStop: string;
  readonly offAskOwner: (workspace: string) => string;
  /** The panel for a feature this deployment does not install, which no Owner can switch on. */
  readonly notInstalledHeading: (label: string) => string;
  readonly notInstalledOperator: (label: string) => string;
}

const EN: FeaturesStrings = {
  labels: {
    chat: 'Chat',
    projects: 'Projects',
    files: 'Files',
    skills: 'Skills',
    connectors: 'Connectors',
    runs: 'Runs',
    sharing: 'Shared links',
    surfaces: 'Surfaces',
    triggers: 'Triggers',
    evaluations: 'Evaluations',
    builder: 'Builder',
  },
  heading: 'Features',
  intro:
    'Switch a feature off to hide it for everyone in this workspace. Nothing is deleted, and switching it back on restores it.',
  readOnly: 'Only a workspace Owner can change these.',
  loading: 'Loading features…',
  loadFailed: 'The features of this workspace could not be read.',
  listLabel: 'Features of this workspace',
  listSeparator: ', ',
  on: 'On',
  off: 'Off',
  saving: 'Saving…',
  needs: (labels) => `Needs: ${labels}`,
  neededBy: (labels) => `Needed by: ${labels}`,
  notInstalled: 'Not installed in this deployment',
  blockedNeededBy: (labels) => `Needed by ${labels}`,
  blockedNeeds: (labels) => `Switch on ${labels} first`,
  dialogTitle: (label) => `Switch ${label} off?`,
  dialogHides: (entries) =>
    `These navigation entries disappear for everyone in this workspace: ${entries}.`,
  dialogHidesNothing:
    'No navigation entry disappears. Its pages and API answer that it is switched off.',
  dialogDataKept: 'Data is kept. Switching it back on restores everything.',
  cancel: 'Cancel',
  confirm: (label) => `Switch ${label} off`,
  refusals: {
    feature_in_use: 'Another feature that is on needs this one, so it cannot be switched off.',
    feature_not_installed: 'This deployment does not install that feature.',
    forbidden: 'Only a workspace Owner can switch features.',
    unauthenticated: 'Your session has ended. Sign in again to change features.',
  },
  unavailable: 'The change could not be saved. Try again.',
  offHeading: (label) => `${label} is switched off for this workspace.`,
  offNothingDeleted: 'Nothing was deleted.',
  offOwnerCanSwitch: 'A workspace Owner can switch it on in',
  offSettingsLink: 'Settings → Features',
  fullStop: '.',
  offAskOwner: (workspace) => `Ask an Owner of ${workspace}.`,
  notInstalledHeading: (label) => `${label} is not installed in this deployment.`,
  notInstalledOperator: (label) =>
    `This deployment does not install ${label}, so it cannot be switched on in Settings. The operator adds it to the features list in agent-workspace.yaml and deploys again.`,
};

const JA: FeaturesStrings = {
  labels: {
    chat: 'チャット',
    projects: 'プロジェクト',
    files: 'ファイル',
    skills: 'スキル',
    connectors: 'コネクタ',
    runs: '実行',
    sharing: '共有リンク',
    surfaces: 'サーフェス',
    triggers: 'トリガー',
    evaluations: '評価',
    builder: 'ビルダー',
  },
  heading: '機能',
  intro:
    '機能をオフにすると、このワークスペースの全員に対して非表示になります。データは削除されず、オンに戻すと元どおりになります。',
  readOnly: '変更できるのはワークスペースのオーナーだけです。',
  loading: '機能を読み込んでいます…',
  loadFailed: 'このワークスペースの機能を読み込めませんでした。',
  listLabel: 'このワークスペースの機能',
  listSeparator: '、',
  on: 'オン',
  off: 'オフ',
  saving: '保存しています…',
  needs: (labels) => `必要な機能: ${labels}`,
  neededBy: (labels) => `この機能を必要とする機能: ${labels}`,
  notInstalled: 'このデプロイにはインストールされていません',
  blockedNeededBy: (labels) => `${labels} が必要としています`,
  blockedNeeds: (labels) => `先に ${labels} をオンにしてください`,
  dialogTitle: (label) => `${label} をオフにしますか？`,
  dialogHides: (entries) =>
    `次のナビゲーション項目が、このワークスペースの全員に対して表示されなくなります: ${entries}。`,
  dialogHidesNothing:
    '消えるナビゲーション項目はありません。この機能のページと API は、オフであることを返します。',
  dialogDataKept: 'データは保持されます。オンに戻すとすべて元どおりになります。',
  cancel: 'キャンセル',
  confirm: (label) => `${label} をオフにする`,
  refusals: {
    feature_in_use: 'オンになっている別の機能がこの機能を必要としているため、オフにできません。',
    feature_not_installed: 'このデプロイにはその機能がインストールされていません。',
    forbidden: '機能を切り替えられるのはワークスペースのオーナーだけです。',
    unauthenticated: 'セッションが終了しました。もう一度サインインしてから変更してください。',
  },
  unavailable: '変更を保存できませんでした。もう一度お試しください。',
  offHeading: (label) => `このワークスペースでは ${label} がオフになっています。`,
  offNothingDeleted: 'データは何も削除されていません。',
  offOwnerCanSwitch: 'ワークスペースのオーナーが次の画面でオンにできます:',
  offSettingsLink: '設定 → 機能',
  fullStop: '。',
  offAskOwner: (workspace) => `${workspace} のオーナーに依頼してください。`,
  notInstalledHeading: (label) => `このデプロイには ${label} がインストールされていません。`,
  notInstalledOperator: (label) =>
    `このデプロイには ${label} がインストールされていないため、設定からオンにすることはできません。運用担当者が agent-workspace.yaml の features に追加し、もう一度デプロイします。`,
};

const STRINGS: Readonly<Record<FeaturesLocale, FeaturesStrings>> = { en: EN, ja: JA };

export function featuresStrings(locale: FeaturesLocale): FeaturesStrings {
  return STRINGS[locale];
}

/** The banner for a refusal code; a code the card has no words for gets the generic one. */
export function featuresRefusalText(code: string, strings: FeaturesStrings): string {
  return Object.hasOwn(strings.refusals, code)
    ? strings.refusals[code as FeaturesRefusalCode]
    : strings.unavailable;
}

/** Labels joined for a sentence, in the order given. */
export function featureLabelList(ids: readonly FeatureId[], strings: FeaturesStrings): string {
  return ids.map((id) => strings.labels[id]).join(strings.listSeparator);
}
