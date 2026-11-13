import type { VersionsLocale } from '../agents/versions-messages';

/**
 * The home chat's own words in the reader's language (UX-15 in #2086): the heading, the composer,
 * its pickers and the Send button, and the reasons nothing can be sent.
 *
 * English is the text `ui/home.html` and spec §45 print, unchanged; this file only adds the
 * Japanese a `ja` reader sees instead, as `shell-messages.ts` does for the navigation. The agent's
 * own detail line (model, sandbox, permissions) is built from {@link ComposerStrings.sandbox} and
 * the words after it; the run-target line still comes from `model.ts` in English.
 */
export interface ComposerStrings {
  readonly heading: string;
  /** Under the heading; `files` says whether the Files feature is on. */
  readonly intro: (files: boolean) => string;
  readonly inputLabel: string;
  readonly inputPlaceholder: string;
  readonly send: string;
  readonly modelLabel: string;
  readonly modelInherit: string;
  readonly project: string;
  readonly noProject: string;
  /** The agent picker's button: the chosen agent's name, or `null` when there is none. */
  readonly agentPicker: (name: string | null) => string;
  readonly runAs: string;
  readonly cannotRunYet: string;
  readonly switchingAgent: string;
  readonly manageAgents: string;
  readonly filesPicker: string;
  readonly connectorsPicker: string;
  readonly availableToAgent: string;
  readonly noFilesListed: string;
  readonly noConnectorsListed: string;
  readonly filesListedNote: string;
  /** The `.d` line under a file or folder the agent is granted: its path and its access. */
  readonly fileOptionDetail: (path: string, access: 'read' | 'read-write') => string;
  readonly upload: string;
  readonly pickersNarrow: string;
  readonly remove: string;
  readonly removeChip: (name: string) => string;
  readonly recent: string;
  readonly seeAll: string;
  /** Why no agent can be offered, said in the composer's status slot. */
  readonly noAgentStore: string;
  readonly noSession: string;
  readonly noMembership: string;
  readonly noAgentsYet: string;
  /** The follow-up box's placeholder once the chat has become the run view. */
  readonly followUpPlaceholder: string;
  /** The line before **Send**, and the middle of the agent's detail line. */
  readonly sandbox: (writeFiles: boolean) => string;
  /** Stands in for the model in the detail line when no run target is known. */
  readonly workspaceDefaultModel: string;
  /** The permissions the detail line names after the sandbox, joined by {@link listSeparator}. */
  readonly canRunCommands: string;
  readonly unrestrictedNetwork: string;
  readonly listSeparator: string;
}

const EN: ComposerStrings = {
  heading: 'What can I help with?',
  intro: (files) =>
    files
      ? 'Pick an agent, add files or connectors, and start. Everything runs in a sandbox.'
      : 'Pick an agent, add connectors, and start. Everything runs in a sandbox.',
  inputLabel: 'Ask anything',
  inputPlaceholder: 'Ask anything…',
  send: 'Send',
  modelLabel: 'Model',
  modelInherit: 'Agent default',
  project: 'Project',
  noProject: 'No project',
  agentPicker: (name) => `Agent: ${name ?? 'none'}`,
  runAs: 'Run this message as',
  cannotRunYet: 'Cannot run yet',
  switchingAgent: 'Switching agent mid-conversation starts a new session.',
  manageAgents: 'Manage agents',
  filesPicker: '+ Files',
  connectorsPicker: '+ Connectors',
  availableToAgent: 'Available to this agent',
  noFilesListed:
    'No workspace files are listed for this agent. It still reads every file granted to it.',
  noConnectorsListed:
    "This agent's connectors are not listed here yet. It can still use the connectors set on it in every chat.",
  filesListedNote:
    'Only files this agent is permitted to read are listed. Pick some to limit this chat to them; pick none to keep them all.',
  fileOptionDetail: (path, access) =>
    `${path} · ${access === 'read-write' ? 'read/write' : 'read-only'}`,
  upload: 'Upload',
  pickersNarrow: 'Pickers narrow what the agent may use — they never grant new capability.',
  remove: 'Remove',
  removeChip: (name) => `Remove ${name}`,
  recent: 'Recent',
  seeAll: 'See all',
  noAgentStore: 'No agent store is configured — nothing can run yet.',
  noSession: 'You are not signed in — no agent can be offered.',
  noMembership: 'Your account is not a member of this workspace — no agent can be offered.',
  noAgentsYet: 'This workspace has no agents yet — create one to run a message.',
  followUpPlaceholder:
    'Ask a follow-up. The session is resumed, so the agent still has the context above.',
  sandbox: (writeFiles) => `Standard Sandbox · ${writeFiles ? 'read/write' : 'read-only'}`,
  workspaceDefaultModel: 'the workspace default model',
  canRunCommands: 'can run commands',
  unrestrictedNetwork: 'unrestricted network',
  listSeparator: ', ',
};

const JA: ComposerStrings = {
  heading: '何をお手伝いしましょうか？',
  intro: (files) =>
    files
      ? 'エージェントを選び、ファイルやコネクタを追加して始めましょう。すべてサンドボックスの中で実行されます。'
      : 'エージェントを選び、コネクタを追加して始めましょう。すべてサンドボックスの中で実行されます。',
  inputLabel: '何でも聞いてください',
  inputPlaceholder: '何でも聞いてください…',
  send: '送信',
  modelLabel: 'モデル',
  modelInherit: 'エージェントの既定',
  project: 'プロジェクト',
  noProject: 'プロジェクトなし',
  agentPicker: (name) => `エージェント: ${name ?? 'なし'}`,
  runAs: 'このメッセージを実行するエージェント',
  cannotRunYet: 'まだ実行できません',
  switchingAgent: '会話の途中でエージェントを切り替えると、新しいセッションになります。',
  manageAgents: 'エージェントを管理',
  filesPicker: '+ ファイル',
  connectorsPicker: '+ コネクタ',
  availableToAgent: 'このエージェントが使えるもの',
  noFilesListed:
    'このエージェントに表示できるワークスペースのファイルはありません。許可されたファイルはすべて読めます。',
  noConnectorsListed:
    'このエージェントのコネクタはまだここに表示されません。設定されたコネクタはどのチャットでも使えます。',
  filesListedNote:
    'このエージェントが読めるファイルだけを表示しています。選ぶとこのチャットで使うファイルを絞れます。選ばなければすべて使えます。',
  fileOptionDetail: (path, access) =>
    `${path} · ${access === 'read-write' ? '読み書き' : '読み取り専用'}`,
  upload: 'アップロード',
  pickersNarrow: 'ここで選ぶと使えるものが絞られます。新しい権限が増えることはありません。',
  remove: '外す',
  removeChip: (name) => `${name} を外す`,
  recent: '最近',
  seeAll: 'すべて表示',
  noAgentStore: 'エージェントの保存先が設定されていないため、まだ何も実行できません。',
  noSession: 'サインインしていないため、エージェントを選べません。',
  noMembership:
    'あなたのアカウントはこのワークスペースのメンバーではないため、エージェントを選べません。',
  noAgentsYet:
    'このワークスペースにはまだエージェントがありません。作成するとメッセージを実行できます。',
  followUpPlaceholder:
    '続けて質問できます。セッションは再開されるので、エージェントは上の内容を覚えています。',
  sandbox: (writeFiles) => `標準サンドボックス · ${writeFiles ? '読み書き' : '読み取り専用'}`,
  workspaceDefaultModel: 'ワークスペースの既定モデル',
  canRunCommands: 'コマンド実行可',
  unrestrictedNetwork: 'ネットワーク制限なし',
  listSeparator: '、',
};

const STRINGS: Readonly<Record<VersionsLocale, ComposerStrings>> = { en: EN, ja: JA };

export function composerStrings(locale: VersionsLocale): ComposerStrings {
  return STRINGS[locale];
}
