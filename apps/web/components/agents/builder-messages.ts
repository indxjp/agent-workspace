/**
 * The Builder chat's own words in the reader's language (UX-15 in #2086): the chat beside the
 * definition, the definition preview, the saved line, the approval card and the words that card
 * names each change in, in the shape of `../team/team-messages.ts`.
 *
 * English is the text these screens printed before, unchanged. What the model wrote (names,
 * instructions, summaries, rules) and what the server sends (a refusal's sentence, a code) is shown
 * as it comes. The approval card's warnings say what a change lets the agent do; the Japanese says
 * the same thing, no softer.
 */
import type { DefinitionSection } from '@indx-workspace/sdk/portable';

import type { BuilderRefusal } from './definition-from-run';
import type { VersionsLocale } from './versions-messages';

/** The labels and values the approval card and the preview name a change with. */
export interface ChangeWords {
  readonly fields: Readonly<Record<string, string>>;
  readonly fileAccess: (path: string) => string;
  readonly fileAccessEntry: (path: string, entry: string) => string;
  readonly skillVersion: (name: string) => string;
  readonly skill: (name: string) => string;
  readonly connector: (name: string) => string;
  readonly toolInSet: (rule: string) => string;
  readonly blockedTool: (rule: string) => string;
  readonly usedWithoutAsking: (rule: string) => string;
  readonly codeToolTimeout: (tool: string) => string;
  readonly codeToolMayReach: (tool: string, host: string) => string;
  readonly codeToolSecret: (tool: string, secret: string) => string;
  readonly codeTool: (tool: string) => string;
  readonly subagent: (name: string) => string;
  readonly knowledgeFile: (path: string) => string;
  readonly knowledgeConnector: (name: string) => string;
  readonly deploymentDefault: string;
  readonly workspaceDefault: string;
  readonly none: string;
  readonly claudeCodePreset: string;
  readonly yes: string;
  readonly no: string;
  readonly allowed: string;
  readonly notAllowed: string;
  readonly readOnly: string;
  readonly readAndWrite: string;
  readonly removed: string;
  readonly added: string;
  readonly addedValue: (value: string) => string;
}

export interface BuilderStrings {
  readonly heading: string;
  readonly loading: string;
  readonly unavailable: string;
  /** {@link unavailable} as a sentence, before the reason. */
  readonly unavailableSentence: string;
  readonly profileFailed: string;
  readonly profileUnreadable: string;
  readonly notSent: string;
  readonly composerDetail: string;
  readonly definition: string;
  readonly previewEmpty: string;
  readonly saveFailed: string;
  readonly checkFailed: string;
  readonly code: string;
  /** What "Ask the Builder to change this" puts in the message box for a section. */
  readonly askPrefill: (section: string) => string;
  readonly detailKinds: Readonly<Record<string, string>>;
  readonly refusals: Readonly<Record<BuilderRefusal, string>>;

  readonly sections: Readonly<Record<DefinitionSection, string>>;
  readonly changed: string;
  readonly askToChange: (section: string) => string;
  readonly askToChangeThis: string;
  readonly noCodeTools: string;
  readonly noToolRules: string;
  readonly permissionMode: (mode: string) => string;
  readonly skipChecks: (yes: boolean) => string;
  readonly autoApproved: (rules: string) => string;
  readonly denied: (rules: string) => string;
  readonly toolSet: (set: string) => string;

  readonly savedAs: (version: number) => string;
  readonly tryIt: string;
  readonly viewHistory: string;
  readonly promote: string;

  readonly cardLabel: string;
  readonly cardLoading: string;
  readonly cardUnreadable: string;
  readonly saveNew: (name: string) => string;
  readonly saveChanges: (name: string, version: string) => string;
  readonly noChanges: string;
  readonly showExact: string;
  readonly exactNone: string;
  readonly exactRemoved: string;
  readonly alsoChanges: (keys: string) => string;
  readonly summary: (text: string) => string;
  readonly agent: string;
  readonly version: string;
  readonly input: string;
  readonly checks: string;
  readonly inputColon: string;
  readonly expectColon: string;
  readonly trialCap: (cap: string) => string;
  readonly evalsCap: (cap: string) => string;
  readonly warnSkips: string;
  readonly warnPreset: string;
  readonly warnAddsTool: string;
  readonly warnRemovesDeny: string;
  readonly warnWithoutAsking: string;
  readonly notAccepted: string;
  readonly approve: string;
  readonly reject: string;

  readonly change: ChangeWords;
}

const EN: BuilderStrings = {
  heading: 'New Agent',
  loading: 'Loading the Builder…',
  unavailable: 'The Builder is not available in this workspace',
  unavailableSentence: 'The Builder is not available in this workspace.',
  profileFailed: 'The request to load your profile failed',
  profileUnreadable: 'Your profile was not the published contract.',
  notSent: 'The decision did not reach the server. Check your connection and try again.',
  composerDetail: 'Builds an agent with you, one question at a time.',
  definition: 'Definition',
  previewEmpty: 'The definition appears here once the Builder checks a draft.',
  saveFailed: 'The last save failed.',
  checkFailed: 'The last check failed.',
  code: 'Code:',
  askPrefill: (section) => `Change ${section}: `,
  detailKinds: {
    connector: 'Connector',
    skill: 'Skill',
    file: 'File or folder',
    environment: 'Environment',
    provider: 'Model connection',
  },
  refusals: {
    builder_disabled: 'An admin has switched the Builder off.',
    builder_model_unavailable: 'The model the Builder uses is not available.',
  },

  sections: {
    instructions: 'Instructions',
    model: 'Model',
    runtime: 'Runtime',
    resources: 'Resources',
    permissions: 'Permissions',
    tools: 'Tools',
    policy: 'Tool policy',
    subagents: 'Subagents',
    knowledge: 'Knowledge',
    description: 'Description',
  },
  changed: 'changed',
  askToChange: (section) => `Ask the Builder to change ${section}`,
  askToChangeThis: 'Ask the Builder to change this',
  noCodeTools: 'No code tools',
  noToolRules: 'No tool rules',
  permissionMode: (mode) => `Permission mode: ${mode}`,
  skipChecks: (yes) => `Skip permission checks: ${yes ? 'Yes' : 'No'}`,
  autoApproved: (rules) => `Auto-approved: ${rules}`,
  denied: (rules) => `Denied: ${rules}`,
  toolSet: (set) => `Tool set: ${set}`,

  savedAs: (version) => `Saved as version ${String(version)} on local`,
  tryIt: 'Try it',
  viewHistory: 'View history',
  promote: 'Promote',

  cardLabel: 'The Builder is waiting for your decision',
  cardLoading: 'Loading what the Builder asked for…',
  cardUnreadable: 'The Builder asked for something this screen cannot show.',
  saveNew: (name) => `Save a new agent named ${name}`,
  saveChanges: (name, version) => `Save changes to ${name} on top of version ${version}`,
  noChanges: 'No changes in the listed sections.',
  showExact: 'Show the exact fields',
  exactNone: '(none)',
  exactRemoved: '(removed)',
  alsoChanges: (keys) => `Also changes (not shown here): ${keys}`,
  summary: (text) => `Summary: ${text}`,
  agent: 'Agent',
  version: 'Version',
  input: 'Input',
  checks: 'Checks',
  inputColon: 'Input: ',
  expectColon: 'Expect: ',
  trialCap: (cap) =>
    `This runs the draft once with at most a ${cap} budget. Its tools may change real systems.`,
  evalsCap: (cap) =>
    `Each check runs the draft with at most a ${cap} budget. Its tools may change real systems.`,
  warnSkips: 'This change lets the agent skip permission checks.',
  warnPreset: 'This change gives the agent the whole Claude Code tool set.',
  warnAddsTool: 'This change adds a tool to the explicit tool set.',
  warnRemovesDeny: 'This change removes a hard deny on a tool.',
  warnWithoutAsking: 'This change lets the agent use a tool without asking.',
  notAccepted: 'The decision was not accepted.',
  approve: 'Approve',
  reject: 'Reject',

  change: {
    fields: {
      'definition.agent.instructions': 'Instructions',
      'definition.agent.model': 'Model',
      'definition.agent.modelConnectionName': 'Model connection',
      'definition.agent.runtimeProfileName': 'Runtime profile',
      'definition.policy.tools.base': 'Tool set',
      'definition.policy.tools.permissionMode': 'Permission mode',
      'definition.policy.tools.allowDangerouslySkipPermissions': 'Skip permission checks',
      description: 'Description',
    },
    fileAccess: (path) => `File access: ${path}`,
    fileAccessEntry: (path, entry) => `File access: ${path} (entry ${entry})`,
    skillVersion: (name) => `Skill version: ${name}`,
    skill: (name) => `Skill: ${name}`,
    connector: (name) => `Connector: ${name}`,
    toolInSet: (rule) => `Tool in the tool set: ${rule}`,
    blockedTool: (rule) => `Blocked tool: ${rule}`,
    usedWithoutAsking: (rule) => `Used without asking: ${rule}`,
    codeToolTimeout: (tool) => `Code tool timeout (ms): ${tool}`,
    codeToolMayReach: (tool, host) => `Code tool ${tool} may reach: ${host}`,
    codeToolSecret: (tool, secret) => `Code tool ${tool} uses secret: ${secret}`,
    codeTool: (tool) => `Code tool: ${tool}`,
    subagent: (name) => `Subagent: ${name}`,
    knowledgeFile: (path) => `Knowledge file: ${path}`,
    knowledgeConnector: (name) => `Knowledge connector: ${name}`,
    deploymentDefault: 'Deployment default',
    workspaceDefault: 'Workspace default',
    none: 'None',
    claudeCodePreset: 'Claude Code preset',
    yes: 'Yes',
    no: 'No',
    allowed: 'Allowed',
    notAllowed: 'Not allowed',
    readOnly: 'Read only',
    readAndWrite: 'Read and write',
    removed: 'Removed',
    added: 'Added',
    addedValue: (value) => `Added: ${value}`,
  },
};

const JA: BuilderStrings = {
  heading: '新しいエージェント',
  loading: 'Builder を読み込み中…',
  unavailable: 'このワークスペースでは Builder を使えません',
  unavailableSentence: 'このワークスペースでは Builder を使えません。',
  profileFailed: 'プロフィールを読み込むリクエストが失敗しました',
  profileUnreadable: 'プロフィールが公開されている形式ではありませんでした。',
  notSent: '判断がサーバーに届きませんでした。接続を確認して、もう一度お試しください。',
  composerDetail: '質問に一つずつ答えながら、一緒にエージェントを作ります。',
  definition: '定義',
  previewEmpty: 'Builder が下書きを確認すると、ここに定義が表示されます。',
  saveFailed: '最後の保存が失敗しました。',
  checkFailed: '最後の確認が失敗しました。',
  code: 'コード:',
  askPrefill: (section) => `${section}を変更: `,
  detailKinds: {
    connector: 'コネクタ',
    skill: 'スキル',
    file: 'ファイルまたはフォルダ',
    environment: '環境',
    provider: 'モデルの接続',
  },
  refusals: {
    builder_disabled: '管理者が Builder をオフにしています。',
    builder_model_unavailable: 'Builder が使うモデルを利用できません。',
  },

  sections: {
    instructions: '指示文',
    model: 'モデル',
    runtime: 'ランタイム',
    resources: 'リソース',
    permissions: '権限',
    tools: 'ツール',
    policy: 'ツールのポリシー',
    subagents: 'サブエージェント',
    knowledge: 'ナレッジ',
    description: '説明',
  },
  changed: '変更あり',
  askToChange: (section) => `Builder に「${section}」の変更を依頼する`,
  askToChangeThis: 'Builder に変更を依頼する',
  noCodeTools: 'コードツールはありません',
  noToolRules: 'ツールのルールはありません',
  permissionMode: (mode) => `権限モード: ${mode}`,
  skipChecks: (yes) => `権限チェックを省略: ${yes ? 'はい' : 'いいえ'}`,
  autoApproved: (rules) => `確認なしで使用: ${rules}`,
  denied: (rules) => `禁止: ${rules}`,
  toolSet: (set) => `ツールセット: ${set}`,

  savedAs: (version) => `バージョン ${String(version)} として local に保存しました`,
  tryIt: '試す',
  viewHistory: '履歴を見る',
  promote: '昇格',

  cardLabel: 'Builder があなたの判断を待っています',
  cardLoading: 'Builder の依頼内容を読み込み中…',
  cardUnreadable: 'Builder の依頼は、この画面では表示できない内容です。',
  saveNew: (name) => `新しいエージェント ${name} を保存`,
  saveChanges: (name, version) => `バージョン ${version} をもとに ${name} の変更を保存`,
  noChanges: '一覧の項目に変更はありません。',
  showExact: '正確な項目を表示',
  exactNone: '（なし）',
  exactRemoved: '（削除）',
  alsoChanges: (keys) => `ほかにも変更されます（ここには表示していません）: ${keys}`,
  summary: (text) => `概要: ${text}`,
  agent: 'エージェント',
  version: 'バージョン',
  input: '入力',
  checks: 'チェック',
  inputColon: '入力: ',
  expectColon: '期待: ',
  trialCap: (cap) =>
    `下書きを最大 ${cap} の予算で 1 回実行します。ツールによって実際のシステムが変更される可能性があります。`,
  evalsCap: (cap) =>
    `各チェックで下書きを最大 ${cap} の予算で実行します。ツールによって実際のシステムが変更される可能性があります。`,
  warnSkips: 'この変更により、エージェントは権限チェックを省略できるようになります。',
  warnPreset: 'この変更により、エージェントは Claude Code のすべてのツールを使えるようになります。',
  warnAddsTool: 'この変更により、明示的なツールセットにツールが追加されます。',
  warnRemovesDeny: 'この変更により、ツールに対する強制的な禁止が解除されます。',
  warnWithoutAsking: 'この変更により、エージェントは確認なしでツールを使えるようになります。',
  notAccepted: '判断は受け付けられませんでした。',
  approve: '承認',
  reject: '却下',

  change: {
    fields: {
      'definition.agent.instructions': '指示文',
      'definition.agent.model': 'モデル',
      'definition.agent.modelConnectionName': 'モデルの接続',
      'definition.agent.runtimeProfileName': 'ランタイムプロファイル',
      'definition.policy.tools.base': 'ツールセット',
      'definition.policy.tools.permissionMode': '権限モード',
      'definition.policy.tools.allowDangerouslySkipPermissions': '権限チェックを省略',
      description: '説明',
    },
    fileAccess: (path) => `ファイルのアクセス権: ${path}`,
    fileAccessEntry: (path, entry) => `ファイルのアクセス権: ${path}（項目 ${entry}）`,
    skillVersion: (name) => `スキルのバージョン: ${name}`,
    skill: (name) => `スキル: ${name}`,
    connector: (name) => `コネクタ: ${name}`,
    toolInSet: (rule) => `ツールセットのツール: ${rule}`,
    blockedTool: (rule) => `禁止されたツール: ${rule}`,
    usedWithoutAsking: (rule) => `確認なしで使用: ${rule}`,
    codeToolTimeout: (tool) => `コードツールのタイムアウト（ミリ秒）: ${tool}`,
    codeToolMayReach: (tool, host) => `コードツール ${tool} の接続先: ${host}`,
    codeToolSecret: (tool, secret) => `コードツール ${tool} が使うシークレット: ${secret}`,
    codeTool: (tool) => `コードツール: ${tool}`,
    subagent: (name) => `サブエージェント: ${name}`,
    knowledgeFile: (path) => `ナレッジのファイル: ${path}`,
    knowledgeConnector: (name) => `ナレッジのコネクタ: ${name}`,
    deploymentDefault: 'デプロイメントの既定',
    workspaceDefault: 'ワークスペースの既定',
    none: 'なし',
    claudeCodePreset: 'Claude Code プリセット',
    yes: 'はい',
    no: 'いいえ',
    allowed: '許可',
    notAllowed: '不許可',
    readOnly: '読み取りのみ',
    readAndWrite: '読み書き',
    removed: '削除',
    added: '追加',
    addedValue: (value) => `追加: ${value}`,
  },
};

const STRINGS: Readonly<Record<VersionsLocale, BuilderStrings>> = { en: EN, ja: JA };

export function builderStrings(locale: VersionsLocale = 'en'): BuilderStrings {
  return STRINGS[locale];
}

/** One detail of a refused check in words: `connector:erp` reads "Connector: erp". */
export function detailText(detail: string, strings: BuilderStrings = EN): string {
  const colon = detail.indexOf(':');
  const key = detail.slice(0, colon);
  // Own keys only: a detail such as `constructor:x` must not find an inherited property.
  const kind =
    colon === -1 || !Object.hasOwn(strings.detailKinds, key) ? undefined : strings.detailKinds[key];
  return kind === undefined ? detail : `${kind}: ${detail.slice(colon + 1)}`;
}

/** Why the Builder cannot run here, in words. */
export function refusalText(refusal: BuilderRefusal, strings: BuilderStrings = EN): string {
  return strings.refusals[refusal];
}
