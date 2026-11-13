/**
 * The connected-storage panel's words (`./connected-storage.tsx`) in the reader's language (UX-15
 * in #2086). It sits inside the agent detail screen's assigned-resources editor, which passes the
 * reader's words; English is the text the panel printed before, unchanged. A connection's name, a
 * folder's path and the server's refusal are shown as they come.
 */
import type { VersionsLocale } from '../agents/versions-messages';

export interface ConnectedStorageWords {
  readonly loadFailed: string;
  readonly removeFailed: string;
  readonly listFailed: string;
  readonly saveFailed: string;
  readonly loadingGrant: (prefix: string) => string;
  readonly unresolvedConnection: (prefix: string) => string;
  readonly read: string;
  readonly readWrite: string;
  readonly grantsLabel: string;
  readonly removeGrant: (label: string) => string;
  readonly remove: string;
  readonly connectionReadOnly: string;
  readonly writeFilesOff: string;
  /** Why read/write is offered disabled: the rule, then each reason above, as one paragraph. */
  readonly readWriteGap: (...reasons: string[]) => string;
  readonly loading: string;
  readonly noConnections: string;
  readonly connection: string;
  readonly chooseOne: string;
  readonly currentFolder: (folder: string) => string;
  readonly allowedFolders: string;
  readonly upOneFolder: string;
  readonly loadingFolder: string;
  readonly openFolder: (name: string) => string;
  readonly emptyFolder: string;
  readonly accessForFolder: string;
  readonly grantFolder: string;
  readonly openToGrant: string;
}

const EN_CONNECTED_STORAGE: ConnectedStorageWords = {
  loadFailed: 'Connected storage could not be loaded.',
  removeFailed: 'The grant could not be removed.',
  listFailed: 'This folder could not be listed.',
  saveFailed: 'The grant could not be saved.',
  loadingGrant: (prefix) => `${prefix}/ (Loading…)`,
  unresolvedConnection: (prefix) => `Unresolved connection (${prefix}/)`,
  read: 'Read',
  readWrite: 'Read/write',
  grantsLabel: 'Connected storage grants',
  removeGrant: (label) => `Remove ${label}`,
  remove: 'Remove',
  connectionReadOnly: 'This connection is read-only.',
  writeFilesOff: 'This agent’s Write files permission is off.',
  readWriteGap: (...reasons) =>
    [
      'Read/write needs a connection that allows writing and an agent with Write files turned on.',
      ...reasons,
    ].join(' '),
  loading: 'Loading connected storage…',
  noConnections: 'No storage is connected to this workspace yet.',
  connection: 'Storage connection',
  chooseOne: 'Choose one…',
  currentFolder: (folder) => `Current folder: ${folder}`,
  allowedFolders: 'allowed folders',
  upOneFolder: 'Up one folder',
  loadingFolder: 'Loading folder…',
  openFolder: (name) => `Open ${name}/`,
  emptyFolder: 'This folder is empty.',
  accessForFolder: 'Access for this folder',
  grantFolder: 'Grant this folder',
  openToGrant: 'Open a folder to grant it.',
};

const JA_CONNECTED_STORAGE: ConnectedStorageWords = {
  loadFailed: '接続済みストレージを読み込めませんでした。',
  removeFailed: '付与を削除できませんでした。',
  listFailed: 'このフォルダの中身を表示できませんでした。',
  saveFailed: '付与を保存できませんでした。',
  loadingGrant: (prefix) => `${prefix}/ (読み込み中…)`,
  unresolvedConnection: (prefix) => `見つからない接続 (${prefix}/)`,
  read: '読み取り',
  readWrite: '読み書き',
  grantsLabel: '接続済みストレージの付与',
  removeGrant: (label) => `${label} を削除`,
  remove: '削除',
  connectionReadOnly: 'この接続は読み取り専用です。',
  writeFilesOff: 'このエージェントは「ファイルの書き込み」が無効です。',
  // Japanese sentences follow one another with no space between them.
  readWriteGap: (...reasons) =>
    [
      '読み書きには、書き込みを許可した接続と、「ファイルの書き込み」が有効なエージェントの両方が必要です。',
      ...reasons,
    ].join(''),
  loading: '接続済みストレージを読み込み中…',
  noConnections: 'このワークスペースにはまだストレージが接続されていません。',
  connection: 'ストレージ接続',
  chooseOne: '選んでください…',
  currentFolder: (folder) => `現在のフォルダ: ${folder}`,
  allowedFolders: '許可されたフォルダ',
  upOneFolder: '1 つ上のフォルダへ',
  loadingFolder: 'フォルダを読み込み中…',
  openFolder: (name) => `${name}/ を開く`,
  emptyFolder: 'このフォルダは空です。',
  accessForFolder: 'このフォルダのアクセス権',
  grantFolder: 'このフォルダを付与',
  openToGrant: '付与するフォルダを開いてください。',
};

const WORDS: Readonly<Record<VersionsLocale, ConnectedStorageWords>> = {
  en: EN_CONNECTED_STORAGE,
  ja: JA_CONNECTED_STORAGE,
};

export function connectedStorageWords(locale: VersionsLocale = 'en'): ConnectedStorageWords {
  return WORDS[locale];
}
