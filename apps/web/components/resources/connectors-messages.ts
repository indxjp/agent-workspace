/**
 * The Connectors list and Add connector screens' own words in the reader's language (UX-15 in
 * #2086), in the shape of `./admin-messages.ts`.
 *
 * English is the text these screens printed before, unchanged. What the server sends — a
 * connector's name and transport, a failed test's message, a refusal — is shown as it comes. The
 * transport names (HTTP, SSE, stdio) are protocol names and stay as they are in both languages.
 */
import type { ConnectorAuthType } from '@indx-workspace/contracts/connectors';

import type { VersionsLocale } from '../agents/versions-messages';

export interface ConnectorsStrings {
  readonly title: string;
  readonly intro: string;
  readonly addConnector: string;
  readonly loading: string;
  readonly test: string;
  readonly delete: string;
  readonly confirmDelete: (name: string) => string;
  readonly empty: string;
  readonly newIntro: string;
  readonly cancel: string;
  readonly testConnection: string;
  readonly save: string;
  readonly connectorName: string;
  readonly transport: string;
  readonly endpoint: string;
  readonly endpointPlaceholder: string;
  readonly stdioArguments: string;
  readonly stdioArgumentsPlaceholder: string;
  readonly authentication: string;
  readonly authType: Readonly<Record<ConnectorAuthType, string>>;
  readonly credential: string;
  readonly credentialPlaceholder: string;
  /** A saved connector's test passed: "<name> connection passed." */
  readonly connectionPassed: (name: string) => string;
  /** A saved connector's test failed and the server gave no message. */
  readonly connectionFailed: string;
  readonly draftTestPassed: string;
  /** A draft's test failed and the server gave no message. */
  readonly draftTestFailed: string;
}

const EN: ConnectorsStrings = {
  title: 'Connectors',
  intro: 'MCP servers available to workspace agents.',
  addConnector: 'Add connector',
  loading: 'Loading connectors…',
  test: 'Test',
  delete: 'Delete',
  confirmDelete: (name) => `Delete connector ${name}?`,
  empty: 'No connectors yet.',
  newIntro: 'Test the connection before saving it.',
  cancel: 'Cancel',
  testConnection: 'Test connection',
  save: 'Save',
  connectorName: 'Connector name',
  transport: 'Transport',
  endpoint: 'Endpoint',
  endpointPlaceholder: 'URL or command',
  stdioArguments: 'stdio arguments',
  stdioArgumentsPlaceholder: 'stdio arguments (optional)',
  authentication: 'Authentication',
  authType: {
    none: 'No authentication',
    'api-key': 'API key',
    bearer: 'Bearer token',
    oauth: 'OAuth token',
  },
  credential: 'Credential',
  credentialPlaceholder: 'Credential (stored encrypted)',
  connectionPassed: (name) => `${name} connection passed.`,
  connectionFailed: 'Connection failed.',
  draftTestPassed: 'Connection test passed.',
  draftTestFailed: 'Connection test failed.',
};

const JA: ConnectorsStrings = {
  title: 'コネクタ',
  intro: 'ワークスペースのエージェントが使える MCP サーバーです。',
  addConnector: 'コネクタを追加',
  loading: 'コネクタを読み込み中…',
  test: 'テスト',
  delete: '削除',
  confirmDelete: (name) => `コネクタ「${name}」を削除しますか？`,
  empty: 'コネクタはまだありません。',
  newIntro: '保存する前に接続をテストしてください。',
  cancel: 'キャンセル',
  testConnection: '接続をテスト',
  save: '保存',
  connectorName: 'コネクタ名',
  transport: 'トランスポート',
  endpoint: 'エンドポイント',
  endpointPlaceholder: 'URL またはコマンド',
  stdioArguments: 'stdio の引数',
  stdioArgumentsPlaceholder: 'stdio の引数（任意）',
  authentication: '認証',
  authType: {
    none: '認証なし',
    'api-key': 'API キー',
    bearer: 'Bearer トークン',
    oauth: 'OAuth トークン',
  },
  credential: '認証情報',
  credentialPlaceholder: '認証情報（暗号化して保存されます）',
  connectionPassed: (name) => `${name} の接続テストに合格しました。`,
  connectionFailed: '接続に失敗しました。',
  draftTestPassed: '接続テストに合格しました。',
  draftTestFailed: '接続テストに失敗しました。',
};

const STRINGS: Readonly<Record<VersionsLocale, ConnectorsStrings>> = { en: EN, ja: JA };

export function connectorsStrings(locale: VersionsLocale): ConnectorsStrings {
  return STRINGS[locale];
}
