/**
 * The Models screens' own words in the reader's language (UX-15 in #2086): the provider list, the
 * Add Provider form and the provider detail panel, in the shape of `../resources/admin-messages.ts`.
 *
 * English is the text these screens printed before, unchanged. What the server sends — a
 * connection's name, base URL, deployment, API version, project and location values, a probe's
 * message and a refusal's message — is shown as it comes. The heading word is the sidebar's
 * (`../shell/shell-messages.ts`), so the two read the same.
 */
import type { ModelConnectionConfigField, VertexLocation } from '@indx-workspace/contracts/models';

import type { VersionsLocale } from '../agents/versions-messages';

import type { ConnectionStatusKind, ProviderId } from './model';

export interface ModelsStrings {
  readonly title: string;
  readonly intro: string;
  readonly addProvider: string;
  readonly tabProviders: string;
  readonly tabCompatibility: string;
  readonly tabGateway: string;
  readonly loading: string;
  readonly empty: string;
  readonly credentialStored: string;
  readonly test: string;
  readonly testing: (name: string) => string;
  /** The line a failed probe or refused test request leaves, naming the HTTP status. */
  readonly testReturned: (status: string) => string;
  readonly manage: string;
  readonly hide: string;
  readonly status: Readonly<Record<ConnectionStatusKind, string>>;
  readonly providerLabel: Readonly<Record<ProviderId, string>>;
  readonly providerDescription: Readonly<Record<ProviderId, string>>;
  /** The detail line's labelled values; the value itself is the server's. */
  readonly detailDeployment: (value: string) => string;
  readonly detailApiVersion: (value: string) => string;
  readonly detailProject: (value: string) => string;

  readonly addTitle: string;
  readonly addIntro: string;
  readonly chooseProvider: string;
  readonly recommended: string;
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly optional: string;
  readonly gcpProjectOptional: string;
  readonly gcpProjectHelp: string;
  readonly location: string;
  readonly locationLabel: Readonly<Record<VertexLocation, string>>;
  readonly locationHelp: string;
  readonly apiKey: string;
  readonly apiKeyHelp: string;
  readonly deployment: string;
  readonly apiVersion: string;
  readonly displayName: string;
  readonly displayNamePlaceholder: string;
  readonly compatibilityWarning: string;
  readonly cancel: string;
  readonly save: string;
  readonly saving: string;

  readonly close: string;
  readonly connectionSettings: string;
  readonly fieldLabel: Readonly<Record<ModelConnectionConfigField, string>>;
  readonly saveChanges: string;
  readonly signIn: string;
  readonly keylessNotice: string;
  readonly rotateCredential: string;
  readonly newApiKey: string;
  readonly rotateHelp: string;
  readonly rotating: string;
  readonly rotatedTesting: string;
  readonly rotated: (message: string) => string;
  readonly rotatedTestFailed: (message: string) => string;
  readonly removeConnection: string;
  readonly removeConnectionOpen: string;
  readonly checkingAgents: string;
  readonly checkFailed: string;
  readonly noAgent: string;
  readonly usedBy: (count: number, names: string) => string;
  /** "Type <name> to confirm", around the connection's name, which is shown as it is. */
  readonly typeToConfirmBefore: string;
  readonly typeToConfirmAfter: string;
  readonly removing: string;
}

const EN: ModelsStrings = {
  title: 'Models',
  intro:
    'Providers behind the internal gateway. Agents select a model; they never see provider credentials.',
  addProvider: '+ Add Provider',
  tabProviders: 'Providers',
  tabCompatibility: 'Compatibility',
  tabGateway: 'Gateway',
  loading: 'Loading model connections…',
  empty: 'No providers are configured yet. Add one to make a model available to agents.',
  credentialStored: 'Credential stored securely · write-only',
  test: 'Test',
  testing: (name) => `Testing ${name}…`,
  testReturned: (status) => `Connection test returned ${status}.`,
  manage: 'Manage',
  hide: 'Hide',
  status: {
    'credential-missing': 'Credential missing',
    incomplete: 'Configuration incomplete',
    ready: 'Ready',
  },
  providerLabel: {
    anthropic: 'Anthropic',
    'anthropic-compatible': 'Anthropic-compatible endpoint',
    'azure-openai': 'Microsoft Azure OpenAI',
    openai: 'OpenAI',
    'openai-compatible': 'OpenAI-compatible endpoint',
    vertex: 'Claude on Google Cloud (Vertex AI)',
  },
  providerDescription: {
    anthropic: 'Claude models through the native Anthropic Messages API.',
    'anthropic-compatible': 'A configurable endpoint that speaks the Anthropic Messages API.',
    'azure-openai': 'An Azure deployment translated by the internal gateway.',
    openai: 'OpenAI Responses API models translated by the internal gateway.',
    'openai-compatible': 'A configurable endpoint such as vLLM, Ollama, or a vendor gateway.',
    vertex: "Claude through this install's Google Cloud identity. No API key.",
  },
  detailDeployment: (value) => `deployment ${value}`,
  detailApiVersion: (value) => `API version ${value}`,
  detailProject: (value) => `project ${value}`,

  addTitle: 'Add Provider',
  addIntro: 'Choose a provider, then answer only the questions that provider actually needs.',
  chooseProvider: 'Choose provider',
  recommended: 'Recommended',
  endpoint: 'Endpoint',
  baseUrl: 'Base URL',
  optional: ' (optional)',
  gcpProjectOptional: 'Google Cloud project (optional)',
  gcpProjectHelp:
    "Leave empty to use this install's project. No API key is needed: Claude is reached through this install's Google Cloud sign-in.",
  location: 'Location',
  locationLabel: {
    global: 'Global (recommended)',
    us: 'United States',
    eu: 'European Union',
  },
  locationHelp:
    'United States and European Union keep your data in that region, and cost 10 % more than Global.',
  apiKey: 'API Key',
  apiKeyHelp:
    'Stored encrypted. After saving, this secret is write-only and is never displayed again.',
  deployment: 'Deployment',
  apiVersion: 'API Version',
  displayName: 'Display name',
  displayNamePlaceholder: 'What people choose in the agent editor',
  compatibilityWarning:
    'Compatibility varies by endpoint. The agent editor shows capability warnings before an agent is saved.',
  cancel: 'Cancel',
  save: 'Save',
  saving: 'Saving…',

  close: 'Close',
  connectionSettings: 'Connection settings',
  fieldLabel: {
    baseUrl: 'Base URL',
    deployment: 'Deployment',
    apiVersion: 'API version',
    projectId: 'Google Cloud project',
    location: 'Location',
  },
  saveChanges: 'Save changes',
  signIn: 'Sign-in',
  keylessNotice: "Uses this install's Google Cloud identity. No API key is stored.",
  rotateCredential: 'Rotate credential',
  newApiKey: 'New API key',
  rotateHelp:
    'The current key is never shown. Saving replaces it and retests the connection immediately.',
  rotating: 'Rotating…',
  rotatedTesting: 'Credential rotated. Testing the connection…',
  rotated: (message) => `Credential rotated. ${message}`,
  rotatedTestFailed: (message) => `Credential rotated. Test failed: ${message}`,
  removeConnection: 'Remove connection',
  removeConnectionOpen: 'Remove connection…',
  checkingAgents: 'Checking which agents use this connection…',
  checkFailed:
    'Could not check which agents use this connection. The removal will still report it.',
  noAgent: 'No agent currently uses this connection.',
  usedBy: (count, names) =>
    `This connection is used by ${String(count)} agent${count === 1 ? '' : 's'}: ${names}. Removing it falls those agents back to the workspace default model.`,
  typeToConfirmBefore: 'Type ',
  typeToConfirmAfter: ' to confirm',
  removing: 'Removing…',
};

const JA: ModelsStrings = {
  title: 'モデル',
  intro:
    '内部ゲートウェイの背後にあるプロバイダーです。エージェントはモデルを選ぶだけで、プロバイダーの認証情報を見ることはありません。',
  addProvider: '+ プロバイダーを追加',
  tabProviders: 'プロバイダー',
  tabCompatibility: '互換性',
  tabGateway: 'ゲートウェイ',
  loading: 'モデルの接続を読み込み中…',
  empty:
    'プロバイダーはまだ設定されていません。追加すると、エージェントがそのモデルを使えるようになります。',
  credentialStored: '認証情報は安全に保存済み · 書き込み専用',
  test: 'テスト',
  testing: (name) => `${name} をテスト中…`,
  testReturned: (status) => `接続テストが ${status} を返しました。`,
  manage: '管理',
  hide: '折りたたむ',
  status: {
    'credential-missing': '認証情報がありません',
    incomplete: '設定が不完全です',
    ready: '使用可能',
  },
  providerLabel: {
    anthropic: 'Anthropic',
    'anthropic-compatible': 'Anthropic 互換エンドポイント',
    'azure-openai': 'Microsoft Azure OpenAI',
    openai: 'OpenAI',
    'openai-compatible': 'OpenAI 互換エンドポイント',
    vertex: 'Google Cloud 上の Claude（Vertex AI）',
  },
  providerDescription: {
    anthropic: 'Anthropic Messages API で Claude のモデルを直接使います。',
    'anthropic-compatible': 'Anthropic Messages API に対応した、設定可能なエンドポイントです。',
    'azure-openai': '内部ゲートウェイが変換する Azure のデプロイです。',
    openai: '内部ゲートウェイが変換する OpenAI Responses API のモデルです。',
    'openai-compatible': 'vLLM、Ollama、ベンダーのゲートウェイなど、設定可能なエンドポイントです。',
    vertex: 'このインストールの Google Cloud の ID で Claude を使います。API キーは不要です。',
  },
  detailDeployment: (value) => `デプロイ ${value}`,
  detailApiVersion: (value) => `API バージョン ${value}`,
  detailProject: (value) => `プロジェクト ${value}`,

  addTitle: 'プロバイダーを追加',
  addIntro: 'プロバイダーを選び、そのプロバイダーに必要な項目だけを入力してください。',
  chooseProvider: 'プロバイダーを選択',
  recommended: 'おすすめ',
  endpoint: 'エンドポイント',
  baseUrl: 'ベース URL',
  optional: '（任意）',
  gcpProjectOptional: 'Google Cloud プロジェクト（任意）',
  gcpProjectHelp:
    '空欄にすると、このインストールのプロジェクトを使います。API キーは不要です。Claude には、このインストールの Google Cloud のサインインで接続します。',
  location: 'ロケーション',
  locationLabel: {
    global: 'グローバル（おすすめ）',
    us: '米国',
    eu: '欧州連合',
  },
  locationHelp:
    '米国と欧州連合では、データをその地域内に保ちます。料金はグローバルより 10% 高くなります。',
  apiKey: 'API キー',
  apiKeyHelp: '暗号化して保存します。保存後は書き込み専用となり、二度と表示されません。',
  deployment: 'デプロイ',
  apiVersion: 'API バージョン',
  displayName: '表示名',
  displayNamePlaceholder: 'エージェントの編集画面で選ぶときの名前',
  compatibilityWarning:
    '互換性はエンドポイントによって異なります。エージェントを保存する前に、編集画面に機能の警告が表示されます。',
  cancel: 'キャンセル',
  save: '保存',
  saving: '保存中…',

  close: '閉じる',
  connectionSettings: '接続の設定',
  fieldLabel: {
    baseUrl: 'ベース URL',
    deployment: 'デプロイ',
    apiVersion: 'API バージョン',
    projectId: 'Google Cloud プロジェクト',
    location: 'ロケーション',
  },
  saveChanges: '変更を保存',
  signIn: 'サインイン',
  keylessNotice: 'このインストールの Google Cloud の ID を使います。API キーは保存されません。',
  rotateCredential: '認証情報を更新',
  newApiKey: '新しい API キー',
  rotateHelp: '現在のキーは表示されません。保存すると置き換えられ、すぐに接続を再テストします。',
  rotating: '更新中…',
  rotatedTesting: '認証情報を更新しました。接続をテストしています…',
  rotated: (message) => `認証情報を更新しました。${message}`,
  rotatedTestFailed: (message) => `認証情報を更新しました。テストに失敗しました: ${message}`,
  removeConnection: '接続を削除',
  removeConnectionOpen: '接続を削除…',
  checkingAgents: 'この接続を使っているエージェントを確認中…',
  checkFailed:
    'この接続を使っているエージェントを確認できませんでした。削除したときに結果が表示されます。',
  noAgent: 'この接続を使っているエージェントはありません。',
  usedBy: (count, names) =>
    `この接続は ${String(count)} 個のエージェントが使っています: ${names}。削除すると、これらのエージェントはワークスペースの既定モデルを使います。`,
  typeToConfirmBefore: '確認のため ',
  typeToConfirmAfter: ' と入力してください',
  removing: '削除中…',
};

const STRINGS: Readonly<Record<VersionsLocale, ModelsStrings>> = { en: EN, ja: JA };

export function modelsStrings(locale: VersionsLocale): ModelsStrings {
  return STRINGS[locale];
}
