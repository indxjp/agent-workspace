import type { VersionsLocale } from '../agents/versions-messages';
import { runRefusalReason } from '../run/run-refusal-messages';

/** Where a runnable agent's model comes from: the run ladder's layers (issue #393). */
export type RunTargetSource = 'agent' | 'project' | 'workspace' | 'deployment';

/** The words of the line under the composer that says what **Send** will run (issue #393). */
export interface RunTargetWords {
  /** A per-message model override: the agent, the model and the override's connection. */
  readonly override: (agent: string, model: string, connection: string) => string;
  /**
   * The run ladder's answer. `newestRelease` is true for the deployment default, which may run on
   * the newest dated release of the model it names (#506).
   */
  readonly runnable: (
    agent: string,
    model: string,
    connection: string,
    source: RunTargetSource,
    newestRelease: boolean,
  ) => string;
  /**
   * The agent cannot run: the server's `code` and its English `reason`. English shows the reason
   * as it came; Japanese shows its own sentence for a known code (`run/run-refusal-messages.ts`).
   */
  readonly unrunnable: (agent: string, code: string, reason: string) => string;
  /** No run API is installed, so nothing is known beyond the agent. */
  readonly unknown: (agent: string) => string;
}

/**
 * The home chat's own words in the reader's language (UX-15 in #2086): the heading, the composer,
 * its pickers and the Send button, and the reasons nothing can be sent.
 *
 * English is the text `ui/home.html` and spec §45 print, unchanged; this file only adds the
 * Japanese a `ja` reader sees instead, as `shell-messages.ts` does for the navigation. The agent's
 * own detail line (model, sandbox, permissions) is built from {@link ComposerStrings.sandbox} and
 * the words after it; the run-target line from {@link ComposerStrings.runTarget}. A reason an agent
 * cannot run comes from the server and is shown as it came.
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
  readonly runTarget: RunTargetWords;
}

const EN_SOURCE: Readonly<Record<RunTargetSource, string>> = {
  agent: 'the agent’s model',
  project: 'the project default',
  workspace: 'the workspace default',
  deployment: 'the deployment default',
};

const JA_SOURCE: Readonly<Record<RunTargetSource, string>> = {
  agent: 'エージェントのモデル',
  project: 'プロジェクトの既定',
  workspace: 'ワークスペースの既定',
  deployment: 'デプロイの既定',
};

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
  runTarget: {
    override: (agent, model, connection) =>
      `Runs as ${agent} on ${model} (${connection}, this message only).`,
    runnable: (agent, model, connection, source, newestRelease) =>
      `Runs as ${agent} on ${model}${newestRelease ? ' or its newest dated release' : ''} (${connection}, ${EN_SOURCE[source]}).`,
    unrunnable: (agent, _code, reason) => `${agent} cannot run yet — ${reason}`,
    unknown: (agent) => `Runs as ${agent}.`,
  },
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
  runTarget: {
    override: (agent, model, connection) =>
      `${agent} として ${model} で実行します（${connection}、このメッセージのみ）。`,
    runnable: (agent, model, connection, source, newestRelease) =>
      `${agent} として ${model}${newestRelease ? ' またはその最新の日付付きリリースで' : ' で'}実行します（${connection}、${JA_SOURCE[source]}）。`,
    unrunnable: (agent, code, reason) =>
      `${agent} はまだ実行できません — ${runRefusalReason(code, reason, 'ja')}`,
    unknown: (agent) => `${agent} として実行します。`,
  },
};

const STRINGS: Readonly<Record<VersionsLocale, ComposerStrings>> = { en: EN, ja: JA };

export function composerStrings(locale: VersionsLocale): ComposerStrings {
  return STRINGS[locale];
}
