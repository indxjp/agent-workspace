/**
 * The agent detail screen's Configuration tab in the reader's language (UX-15 in #2086), in the
 * shape of `./new-agent-messages.ts`: the definition, model, engine and permission sections, the
 * assigned-resources editor and the save report.
 *
 * English is the text this tab printed before, unchanged. What the server sends — a refusal's own
 * sentence, an engine's or model's name, a transport error's detail — is shown as it comes, marked
 * `lang="en"`. The connected-storage panel inside the editor has its own words in
 * `../storage/connected-storage-messages.ts`.
 */
import type { AgentPermissionKey } from '../../contracts/agents';
import type { VersionsLocale } from './versions-messages';

/** The words of `./resource-editor.tsx`: files and folders, skills, connectors, project-provided. */
interface ResourceEditorWords {
  readonly heading: string;
  readonly filesAndFolders: string;
  readonly noFiles: string;
  readonly unresolvedFile: (id: string) => string;
  readonly missing: string;
  readonly disabled: string;
  readonly accessFor: (label: string) => string;
  readonly read: string;
  readonly readWrite: string;
  readonly remove: string;
  /** Shown under a read/write grant while the agent's Write files permission is off. */
  readonly readOnlyUntilWriteFiles: string;
  readonly closeBrowser: string;
  readonly addFiles: string;
  readonly workspaceFiles: string;
  readonly connectedStorage: string;
  readonly addSelected: (count: number) => string;
  readonly skills: string;
  readonly connectors: string;
  readonly noSkills: string;
  readonly noConnectors: string;
  readonly addSkill: string;
  readonly addConnector: string;
  readonly unresolved: (id: string) => string;
  readonly chooseOne: string;
  readonly add: string;
  readonly projectProvided: string;
  readonly projectProvidedHelp: string;
  readonly noFilesOrConnectors: string;
  readonly unresolvedConnector: (id: string) => string;
}

export interface AgentDetailStrings {
  readonly loadingAgent: string;
  /** Another language's lead over a load failure; English shows the failure's own text alone. */
  readonly loadFailed: string;
  readonly subtitle: string;
  readonly backToAgents: string;
  readonly definition: string;
  readonly name: string;
  readonly instructions: string;

  readonly model: string;
  readonly modelHelp: string;
  readonly loadingModels: string;
  /**
   * The leads of the three catalog failures; the error's own text follows, marked English. English
   * prints the hook's whole sentence (`Models could not be loaded: …`), which these words begin.
   */
  readonly modelsFailed: string;
  readonly override: string;
  readonly noOverride: string;
  readonly clearOverride: string;
  readonly agentOverride: string;
  readonly overrideNotSet: string;
  /** A saved model whose connection the catalog no longer carries. */
  readonly staleModel: (model: string, connectionId: string) => string;
  readonly connection: string;
  readonly noModelsAvailable: string;
  readonly dismiss: string;

  readonly engine: string;
  readonly engineHelp: string;
  readonly loadingEngines: string;
  /** Another language's lead over the engines refusal; English shows the refusal alone. */
  readonly enginesFailed: string;
  readonly noEngine: string;
  readonly engineVersion: (version: string) => string;
  readonly skillsUnavailable: string;
  readonly connectorsUnavailable: string;
  /** Read-only note; the command between the two halves stays in a `<code>` element. */
  readonly engineReadOnlyBefore: string;
  readonly engineReadOnlyAfter: string;

  readonly permissions: string;
  readonly permissionsHelp: string;
  readonly permissionLabels: Readonly<Record<AgentPermissionKey, string>>;

  readonly loadingAssignments: string;
  readonly resourcesFailed: string;
  readonly projectsFailed: string;
  /** Another language's lead over a save refusal; English shows the refusal alone. */
  readonly saveFailed: string;

  readonly definitionHalf: string;
  readonly assignmentsHalf: string;
  readonly halfSaved: (label: string) => string;
  readonly halfNotAttempted: (label: string) => string;
  /** The lead of a refused half; the server's reason follows in English. */
  readonly halfNotSaved: (label: string) => string;
  readonly saving: string;
  readonly save: string;

  readonly editor: ResourceEditorWords;
}

const EN_EDITOR: ResourceEditorWords = {
  heading: 'Assigned resources',
  filesAndFolders: 'Files and folders',
  noFiles: 'No files or folders assigned.',
  unresolvedFile: (id) => `Unresolved file (${id})`,
  missing: 'Missing',
  disabled: 'Disabled',
  accessFor: (label) => `Access for ${label}`,
  read: 'Read',
  readWrite: 'Read/write',
  remove: 'Remove',
  readOnlyUntilWriteFiles:
    'This agent’s Write files permission is off, so this read/write grant will be saved and enforced as read-only until Write files is turned on.',
  closeBrowser: 'Close browser',
  addFiles: 'Add files or folders',
  workspaceFiles: 'Workspace files',
  connectedStorage: 'Connected storage',
  addSelected: (count) => `Add ${String(count)} selected`,
  skills: 'Skills',
  connectors: 'Connectors',
  noSkills: 'No skills assigned.',
  noConnectors: 'No connectors assigned.',
  addSkill: 'Add a skill',
  addConnector: 'Add a connector',
  unresolved: (id) => `Unresolved (${id})`,
  chooseOne: 'Choose one…',
  add: 'Add',
  projectProvided: 'Project-provided (read-only)',
  projectProvidedHelp:
    'Added to every run of this agent that starts from one of these projects (this agent is their default agent). Edit these on the project, not here.',
  noFilesOrConnectors: 'No files or connectors.',
  unresolvedConnector: (id) => `Unresolved connector (${id})`,
};

const JA_EDITOR: ResourceEditorWords = {
  heading: '割り当てたリソース',
  filesAndFolders: 'ファイルとフォルダ',
  noFiles: 'ファイルやフォルダは割り当てられていません。',
  unresolvedFile: (id) => `見つからないファイル (${id})`,
  missing: '見つかりません',
  disabled: '無効',
  accessFor: (label) => `${label} のアクセス権`,
  read: '読み取り',
  readWrite: '読み書き',
  remove: '削除',
  readOnlyUntilWriteFiles:
    'このエージェントは「ファイルの書き込み」が無効なため、この読み書きの割り当ては保存されますが、「ファイルの書き込み」を有効にするまでは読み取り専用として扱われます。',
  closeBrowser: 'ブラウザを閉じる',
  addFiles: 'ファイルやフォルダを追加',
  workspaceFiles: 'ワークスペースのファイル',
  connectedStorage: '接続済みストレージ',
  addSelected: (count) => `選んだ ${String(count)} 件を追加`,
  skills: 'スキル',
  connectors: 'コネクタ',
  noSkills: 'スキルは割り当てられていません。',
  noConnectors: 'コネクタは割り当てられていません。',
  addSkill: 'スキルを追加',
  addConnector: 'コネクタを追加',
  unresolved: (id) => `見つからない項目 (${id})`,
  chooseOne: '選んでください…',
  add: '追加',
  projectProvided: 'プロジェクトから提供 (読み取り専用)',
  projectProvidedHelp:
    'これらのプロジェクトから始まるこのエージェントの実行すべてに追加されます (このエージェントはそれらのプロジェクトの既定のエージェントです)。変更はここではなく、プロジェクトで行ってください。',
  noFilesOrConnectors: 'ファイルやコネクタはありません。',
  unresolvedConnector: (id) => `見つからないコネクタ (${id})`,
};

const EN: AgentDetailStrings = {
  loadingAgent: 'Loading agent…',
  loadFailed: 'The agent could not be loaded.',
  subtitle: 'Agent configuration and explicit permissions',
  backToAgents: 'Back to agents',
  definition: 'Definition',
  name: 'Name',
  instructions: 'Instructions',

  model: 'Model',
  modelHelp: 'Overrides the project and workspace default for every run of this agent.',
  loadingModels: 'Loading model connections…',
  modelsFailed: 'Models could not be loaded:',
  override: 'Override',
  noOverride: 'No override',
  clearOverride: 'Clear override',
  agentOverride: 'Agent override',
  overrideNotSet:
    'Agent override → not set — resolves to the project default when run in a project, otherwise the workspace default.',
  staleModel: (model, connectionId) =>
    `${model} (connection ${connectionId} is no longer available)`,
  connection: 'Connection',
  noModelsAvailable: 'No models available',
  dismiss: 'Dismiss',

  engine: 'Engine',
  engineHelp: 'The harness that runs this agent’s loop. Not the model provider.',
  loadingEngines: 'Loading engines…',
  enginesFailed: 'Engines could not be loaded.',
  noEngine:
    'This deployment installs no engine, so no agent can run. Ask an administrator which engine adapter the runtime image should carry.',
  engineVersion: (version) => `version ${version}`,
  skillsUnavailable: ' — skills unavailable on this engine',
  connectorsUnavailable: ' — connectors unavailable on this engine',
  engineReadOnlyBefore:
    'Read-only here: an agent’s engine is the discriminant of its policy. Set it with ',
  engineReadOnlyAfter: '.',

  permissions: 'Permissions',
  permissionsHelp: 'Every capability is explicit. Network and command access default off.',
  permissionLabels: {
    readFiles: 'Read assigned files and folders',
    writeFiles: 'Write to read/write assignments',
    runCommands: 'Run commands in the selected runtime, asking before one that changes something',
    unrestrictedNetwork: 'Use unrestricted network access',
  },

  loadingAssignments: 'Loading resource assignments…',
  resourcesFailed: 'Resource names could not be loaded:',
  projectsFailed: 'Project associations could not be loaded:',
  saveFailed: 'The change could not be saved.',

  definitionHalf: 'Definition',
  assignmentsHalf: 'Resource assignments',
  halfSaved: (label) => `${label} saved.`,
  halfNotAttempted: (label) => `${label} was not attempted.`,
  halfNotSaved: (label) => `${label} was not saved:`,
  saving: 'Saving…',
  save: 'Save changes',

  editor: EN_EDITOR,
};

const JA: AgentDetailStrings = {
  loadingAgent: 'エージェントを読み込み中…',
  loadFailed: 'エージェントを読み込めませんでした。',
  subtitle: 'エージェントの設定と明示的な権限',
  backToAgents: 'エージェント一覧に戻る',
  definition: '定義',
  name: '名前',
  instructions: '指示文',

  model: 'モデル',
  modelHelp: 'このエージェントのすべての実行で、プロジェクトとワークスペースの既定を上書きします。',
  loadingModels: 'モデルの接続を読み込み中…',
  modelsFailed: 'モデルを読み込めませんでした:',
  override: '上書き',
  noOverride: '上書きしない',
  clearOverride: '上書きを解除',
  agentOverride: 'エージェントの上書き',
  overrideNotSet:
    'エージェントの上書き → 未設定 — プロジェクト内で実行するとプロジェクトの既定、それ以外はワークスペースの既定になります。',
  staleModel: (model, connectionId) => `${model} (接続 ${connectionId} はもう使えません)`,
  connection: '接続',
  noModelsAvailable: '使えるモデルがありません',
  dismiss: '閉じる',

  engine: 'エンジン',
  engineHelp: 'このエージェントのループを動かす実行基盤です。モデルのプロバイダーではありません。',
  loadingEngines: 'エンジンを読み込み中…',
  enginesFailed: 'エンジンを読み込めませんでした。',
  noEngine:
    'このデプロイメントにはエンジンが入っていないため、どのエージェントも実行できません。ランタイムイメージに入れるエンジンアダプターを管理者に確認してください。',
  engineVersion: (version) => `バージョン ${version}`,
  skillsUnavailable: ' — このエンジンではスキルを使えません',
  connectorsUnavailable: ' — このエンジンではコネクタを使えません',
  engineReadOnlyBefore:
    'ここでは変更できません。エンジンはエージェントのポリシーの種類を決めるためです。設定には ',
  engineReadOnlyAfter: ' を使ってください。',

  permissions: '権限',
  permissionsHelp:
    'すべての機能は明示的に許可します。ネットワークとコマンドの実行は既定で無効です。',
  permissionLabels: {
    readFiles: '割り当てたファイルとフォルダを読み取る',
    writeFiles: '読み書きの割り当てに書き込む',
    runCommands:
      '選んだランタイムでコマンドを実行する (何かを変更するコマンドは実行前に確認します)',
    unrestrictedNetwork: '無制限のネットワークを使う',
  },

  loadingAssignments: 'リソースの割り当てを読み込み中…',
  resourcesFailed: 'リソースの名前を読み込めませんでした:',
  projectsFailed: 'プロジェクトの関連付けを読み込めませんでした:',
  saveFailed: '変更を保存できませんでした。',

  definitionHalf: '定義',
  assignmentsHalf: 'リソースの割り当て',
  halfSaved: (label) => `${label}を保存しました。`,
  halfNotAttempted: (label) => `${label}は保存を試みていません。`,
  halfNotSaved: (label) => `${label}を保存できませんでした:`,
  saving: '保存中…',
  save: '変更を保存',

  editor: JA_EDITOR,
};

const STRINGS: Readonly<Record<VersionsLocale, AgentDetailStrings>> = { en: EN, ja: JA };

export function agentDetailStrings(locale: VersionsLocale = 'en'): AgentDetailStrings {
  return STRINGS[locale];
}
