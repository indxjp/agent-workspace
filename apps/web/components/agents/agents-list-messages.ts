/**
 * The Agents list's words in the reader's language (UX-15 in #2086), in the shape of
 * `./new-agent-messages.ts`. English is the text this screen printed before, unchanged. An agent's
 * name, instructions and model id, and the server's refusal, are shown as they come.
 */
import type { VersionsLocale } from './versions-messages';

export interface AgentsListStrings {
  readonly heading: string;
  readonly count: (count: number) => string;
  readonly searchPlaceholder: string;
  readonly newAgent: string;
  readonly loading: string;
  /** Another language's lead over a failed list; English shows the failure alone. */
  readonly loadFailed: string;
  readonly empty: string;
  readonly columnAgent: string;
  readonly columnModel: string;
  readonly columnCreated: string;
  readonly noMatch: (query: string) => string;
  /** The Model column for an agent with no model of its own. */
  readonly workspaceDefault: string;
}

const EN: AgentsListStrings = {
  heading: 'Agents',
  count: (count) => (count === 1 ? '1 agent' : `${String(count)} agents`),
  searchPlaceholder: 'Search agents',
  newAgent: 'New Agent',
  loading: 'Loading…',
  loadFailed: 'The agents could not be loaded.',
  empty: 'This workspace has no agents yet.',
  columnAgent: 'Agent',
  columnModel: 'Model',
  columnCreated: 'Created',
  noMatch: (query) => `No agent matches “${query}”.`,
  workspaceDefault: 'Workspace default',
};

const JA: AgentsListStrings = {
  heading: 'エージェント',
  count: (count) => `${String(count)} 件のエージェント`,
  searchPlaceholder: 'エージェントを検索',
  newAgent: '新しいエージェント',
  loading: '読み込み中…',
  loadFailed: 'エージェント一覧を読み込めませんでした。',
  empty: 'このワークスペースにはまだエージェントがありません。',
  columnAgent: 'エージェント名',
  columnModel: 'モデル',
  columnCreated: '作成日',
  noMatch: (query) => `「${query}」に一致するエージェントはありません。`,
  workspaceDefault: 'ワークスペースの既定',
};

const STRINGS: Readonly<Record<VersionsLocale, AgentsListStrings>> = { en: EN, ja: JA };

export function agentsListStrings(locale: VersionsLocale = 'en'): AgentsListStrings {
  return STRINGS[locale];
}
