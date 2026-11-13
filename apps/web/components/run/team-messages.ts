/**
 * The run tree's words in the console run views (ADR-0104, issue #1517), in English and Japanese,
 * in the shape of `./attach-messages.ts`, whose locale negotiation they share.
 */
import type { VersionsLocale } from '../agents/versions-messages';

export interface TeamStrings {
  /** The heading of the card that lists a lead run's child runs. */
  readonly team: string;
  readonly teamDescription: string;
  readonly treeCost: string;
  /** Shown beside the tree cost while one run of the tree is not priced yet. */
  readonly treeCostUnsettled: string;
  readonly member: string;
  readonly status: string;
  readonly cost: string;
  readonly duration: string;
  readonly openChildRun: string;
  readonly partOfTeamRun: string;
  readonly openLeadRun: string;
  readonly unknownAgent: string;
  /** An `agent__<name>` call whose child run is not in the tree (yet). */
  readonly childRunPending: string;
}

const EN: TeamStrings = {
  team: 'Team',
  teamDescription: 'The member runs this run started, oldest first.',
  treeCost: 'Tree cost',
  treeCostUnsettled: 'Includes runs that are not priced yet',
  member: 'Member',
  status: 'Status',
  cost: 'Cost',
  duration: 'Duration',
  openChildRun: 'Opens child run',
  partOfTeamRun: 'Part of a team run',
  openLeadRun: 'Open the lead run',
  unknownAgent: 'Unknown agent',
  childRunPending: 'Child run not started yet',
};

const JA: TeamStrings = {
  team: 'チーム',
  teamDescription: 'このランが開始したメンバーのラン（古い順）。',
  treeCost: 'ツリー全体のコスト',
  treeCostUnsettled: '料金が未確定のランを含みます',
  member: 'メンバー',
  status: 'ステータス',
  cost: 'コスト',
  duration: '所要時間',
  openChildRun: '子ランを開く',
  partOfTeamRun: 'チームランの一部',
  openLeadRun: 'リードランを開く',
  unknownAgent: '不明なエージェント',
  childRunPending: '子ランはまだ開始されていません',
};

const STRINGS: Readonly<Record<VersionsLocale, TeamStrings>> = { en: EN, ja: JA };

export function teamStrings(locale: VersionsLocale): TeamStrings {
  return STRINGS[locale];
}
