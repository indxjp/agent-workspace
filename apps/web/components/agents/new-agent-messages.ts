/**
 * The New Agent screen's own words in the reader's language (UX-15 in #2086): the heading, the
 * Form/Chat switch and the form's five steps, in the shape of `../team/team-messages.ts`.
 *
 * English is the text this screen printed before, unchanged. The steps are shared with the agent
 * detail screen and the Builder's definition preview, which pass no locale and so stay English
 * until those screens are translated. What the server sends — a refusal's own sentence, a model's
 * display name, a connection's reason — is shown as it comes.
 */
import type { AgentPermissionKey } from '../../contracts/agents';
import type { VersionsLocale } from './versions-messages';

/** The words of the four steps, shared by the form, the detail screen and the Builder preview. */
export interface AgentStepWords {
  readonly modelTitle: string;
  readonly runtimeTitle: string;
  readonly resourcesTitle: string;
  readonly permissionsTitle: string;
  readonly model: string;
  readonly connection: string;
  readonly deploymentDefault: string;
  readonly noModelConnections: string;
  readonly noModelsAvailable: string;
  readonly dismiss: string;
  /**
   * `docs/spec.md` §12's own warning, shown only when the *selected catalog entry's own reported*
   * `capabilities.promptCaching` is `false` — never guessed from the provider id (#130): it is real
   * discovery data or it is not shown.
   */
  readonly promptCachingWarning: string;
  readonly runtimeProfile: string;
  readonly none: string;
  readonly noRuntimeProfiles: string;
  readonly filesAndFolders: string;
  readonly skills: string;
  readonly connectors: string;
  readonly noneConfigured: string;
  readonly fileAccessRead: string;
  readonly fileAccessReadWrite: string;
  readonly accessFor: (label: string) => string;
  readonly read: string;
  readonly readWrite: string;
  readonly permissionsIntro: string;
  readonly allowed: string;
  readonly notAllowed: string;
  /** Each permission's name and the sentence under it, in the form's order. */
  readonly permissions: Readonly<
    Record<AgentPermissionKey, readonly [label: string, help: string]>
  >;
}

export interface NewAgentStrings extends AgentStepWords {
  readonly heading: string;
  readonly modeLabel: string;
  readonly modeForm: string;
  readonly modeChat: string;
  readonly step1: string;
  readonly name: string;
  readonly namePlaceholder: string;
  readonly instructions: string;
  readonly instructionsHelp: string;
  readonly loadingModels: string;
  /** Leads the error's own text, marked English; English prints `Models could not be loaded: …`. */
  readonly modelsFailed: string;
  readonly loadingRuntimes: string;
  readonly loadingResources: string;
  readonly runtimesFailed: (reason: string) => string;
  readonly cancel: string;
  /** Leads a refused create; the server's status, code and sentence follow, marked English. */
  readonly createFailed: string;
  readonly creating: string;
  readonly create: string;
}

/** The order the form lists permissions in; the `Record` above holds their words. */
export const PERMISSION_ORDER: readonly AgentPermissionKey[] = [
  'readFiles',
  'writeFiles',
  'runCommands',
  'unrestrictedNetwork',
];

const EN: NewAgentStrings = {
  heading: 'New Agent',
  modeLabel: 'How to create this agent',
  modeForm: 'Form',
  modeChat: 'Chat',
  step1: 'Step 1 · Name and instructions',
  name: 'Name',
  namePlaceholder: 'e.g. Contract Review',
  instructions: 'Instructions',
  instructionsHelp:
    'This becomes the agent’s system prompt. Plain language works better than instructions written for a developer.',
  loadingModels: 'Loading model connections…',
  modelsFailed: 'Models could not be loaded:',
  loadingRuntimes: 'Loading runtime profiles…',
  loadingResources: 'Loading files, skills, and connectors…',
  runtimesFailed: (reason) => `Runtime profiles could not be loaded: ${reason}`,
  cancel: 'Cancel',
  createFailed: 'The agent could not be created.',
  creating: 'Creating…',
  create: 'Create Agent',

  modelTitle: 'Step 2 · Model',
  runtimeTitle: 'Step 3 · Runtime',
  resourcesTitle: 'Step 4 · Resources',
  permissionsTitle: 'Step 5 · Permissions',
  model: 'Model',
  connection: 'Connection',
  deploymentDefault: 'Deployment default',
  noModelConnections:
    'No model connections are configured. Add a provider on the Models screen before creating an agent.',
  noModelsAvailable: 'No models available',
  dismiss: 'Dismiss',
  promptCachingWarning:
    '⚠ This model does not fully support Claude prompt caching.\nThe agent can still run, but behavior may differ.',
  runtimeProfile: 'Runtime profile',
  none: 'None',
  noRuntimeProfiles:
    'No runtime profiles are configured. Create one on the Runtimes screen before creating an agent.',
  filesAndFolders: 'Files and folders',
  skills: 'Skills',
  connectors: 'Connectors',
  noneConfigured: 'None configured.',
  fileAccessRead: 'read',
  fileAccessReadWrite: 'read/write',
  accessFor: (label) => `Access for ${label}`,
  read: 'Read',
  readWrite: 'Read/write',
  permissionsIntro: 'Choose each capability explicitly. High-risk capabilities start disabled.',
  allowed: 'Allowed',
  notAllowed: 'Not allowed',
  permissions: {
    readFiles: ['Read files', 'Read only the files and folders assigned above.'],
    writeFiles: ['Write files', 'Modify only resources explicitly assigned read/write.'],
    runCommands: [
      'Run commands',
      'Run commands inside the selected runtime. A command that changes something waits for your approval first.',
    ],
    unrestrictedNetwork: [
      'Unrestricted network',
      'Allow network destinations beyond the runtime policy.',
    ],
  },
};

const JA: NewAgentStrings = {
  heading: '新しいエージェント',
  modeLabel: 'エージェントの作成方法',
  modeForm: 'フォーム',
  modeChat: 'チャット',
  step1: 'ステップ 1 · 名前と指示文',
  name: '名前',
  namePlaceholder: '例: 契約書レビュー',
  instructions: '指示文',
  instructionsHelp:
    'これがエージェントのシステムプロンプトになります。開発者向けの書き方より、ふだんの言葉で書くほうがうまく伝わります。',
  loadingModels: 'モデルの接続を読み込み中…',
  modelsFailed: 'モデルを読み込めませんでした:',
  loadingRuntimes: 'ランタイムプロファイルを読み込み中…',
  loadingResources: 'ファイル、スキル、コネクタを読み込み中…',
  runtimesFailed: (reason) => `ランタイムプロファイルを読み込めませんでした: ${reason}`,
  cancel: 'キャンセル',
  createFailed: 'エージェントを作成できませんでした。',
  creating: '作成中…',
  create: 'エージェントを作成',

  modelTitle: 'ステップ 2 · モデル',
  runtimeTitle: 'ステップ 3 · ランタイム',
  resourcesTitle: 'ステップ 4 · リソース',
  permissionsTitle: 'ステップ 5 · 権限',
  model: 'モデル',
  connection: '接続',
  deploymentDefault: 'デプロイメントの既定',
  noModelConnections:
    'モデルの接続が設定されていません。エージェントを作成する前に、モデル画面でプロバイダーを追加してください。',
  noModelsAvailable: '使えるモデルがありません',
  dismiss: '閉じる',
  promptCachingWarning:
    '⚠ このモデルは Claude のプロンプトキャッシュに完全には対応していません。\nエージェントは実行できますが、動作が異なる場合があります。',
  runtimeProfile: 'ランタイムプロファイル',
  none: 'なし',
  noRuntimeProfiles:
    'ランタイムプロファイルが設定されていません。エージェントを作成する前に、ランタイム画面で作成してください。',
  filesAndFolders: 'ファイルとフォルダ',
  skills: 'スキル',
  connectors: 'コネクタ',
  noneConfigured: '設定されていません。',
  fileAccessRead: '読み取り',
  fileAccessReadWrite: '読み書き',
  accessFor: (label) => `${label} のアクセス権`,
  read: '読み取り',
  readWrite: '読み書き',
  permissionsIntro: '各機能を一つずつ選んでください。リスクの高い機能は最初は無効です。',
  allowed: '許可',
  notAllowed: '不許可',
  permissions: {
    readFiles: ['ファイルの読み取り', '上で割り当てたファイルとフォルダだけを読み取ります。'],
    writeFiles: ['ファイルの書き込み', '読み書きを明示的に割り当てたリソースだけを変更します。'],
    runCommands: [
      'コマンドの実行',
      '選んだランタイムの中でコマンドを実行します。何かを変更するコマンドは、実行前にあなたの承認を待ちます。',
    ],
    unrestrictedNetwork: [
      '無制限のネットワーク',
      'ランタイムのポリシーを超える接続先への通信を許可します。',
    ],
  },
};

const STRINGS: Readonly<Record<VersionsLocale, NewAgentStrings>> = { en: EN, ja: JA };

export function newAgentStrings(locale: VersionsLocale = 'en'): NewAgentStrings {
  return STRINGS[locale];
}
