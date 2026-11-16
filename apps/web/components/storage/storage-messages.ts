/**
 * The Storage screens' own words in the reader's language (UX-15 in #2086): the connection list,
 * Connect storage and Edit storage connection, plus the sentences `storage-model.ts` builds for
 * them, in the shape of `../resources/admin-messages.ts`.
 *
 * English is the text these screens printed before, unchanged. What the server sends — a
 * connection's name, provider id, URL and folders — is shown as it comes. The heading word is the
 * sidebar's (`../shell/shell-messages.ts`), so the two read the same. An agent's Connected storage
 * panel (`connected-storage.tsx`) reads the same model sentences in English until that screen is
 * translated.
 */
import type { VersionsLocale } from '../agents/versions-messages';

/** The API problem codes `storageProblemMessage` words; any other code gets the caller's fallback. */
type StorageProblemCode =
  | 'storage_connection_url_invalid'
  | 'storage_connection_url_has_secret'
  | 'storage_connection_endpoint_forbidden'
  | 'storage_connection_name_taken'
  | 'storage_connection_not_found'
  | 'storage_connection_prefix_not_allowed'
  | 'storage_connection_write_not_allowed'
  | 'storage_connection_credential_required'
  | 'storage_connection_in_use'
  | 'storage_connection_unreachable'
  | 'agent_definition_references_missing';

/** The sentences `storage-model.ts` builds: problems, test outcomes and Save and test results. */
export interface StorageModelWords {
  readonly providerLabel: Readonly<Record<'s3' | 'gcs' | 'azblob' | 'file', string>>;
  readonly nameInvalid: string;
  readonly nameLooksLikeId: string;
  readonly keyPairHalf: string;
  readonly problems: Readonly<Record<StorageProblemCode, string>>;
  readonly noAccess: string;
  readonly testOk: string;
  readonly testOkEmpty: (folders: string) => string;
  readonly testForbidden: string;
  readonly testNotFound: string;
  readonly testUnreachable: string;
  readonly savedConnected: string;
  readonly savedConnectedEmpty: (folders: string) => string;
  readonly savedEmptyNext: string;
  readonly savedTestFailed: (outcome: string) => string;
  readonly savedForbiddenNext: string;
  readonly savedNotFoundNext: string;
  readonly savedUnreachableNext: string;
  readonly savedNotTested: (problem: string) => string;
  readonly savedNotTestedNext: string;
  readonly couldNotTest: string;
}

export interface StorageStrings extends StorageModelWords {
  readonly title: string;
  readonly intro: string;
  readonly connectStorage: string;
  readonly loading: string;
  readonly empty: string;
  readonly couldNotLoadList: string;
  readonly folders: (list: string) => string;
  readonly writesAllowed: string;
  readonly readOnly: string;
  readonly credentialStored: string;
  readonly edit: string;
  readonly editLabel: (name: string) => string;
  readonly test: string;
  readonly testLabel: (name: string) => string;
  readonly testing: (name: string) => string;
  readonly notAllowed: string;

  readonly newTitle: string;
  readonly newIntro: string;
  readonly name: string;
  readonly nameHelp: string;
  readonly provider: string;
  readonly url: string;
  readonly urlExample: (hint: string) => string;
  readonly noKeysInUrl: string;
  readonly urlMoveNeedsCredential: string;
  readonly allowedFolders: string;
  readonly foldersHelp: string;
  readonly allowWriting: string;
  readonly allowWritingHelp: string;
  readonly credential: string;
  readonly credentialNewHelp: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly serviceAccountJson: string;
  readonly credentialType: string;
  readonly accountKey: string;
  readonly sasToken: string;
  readonly cancel: string;
  readonly saveAndTest: string;
  readonly couldNotSave: string;
  readonly saved: (name: string) => string;
  readonly testingConnection: string;
  readonly editConnection: string;
  readonly done: string;
  readonly backToStorageList: string;

  readonly editTitle: string;
  readonly loadingConnection: string;
  readonly couldNotLoad: string;
  readonly backToStorage: string;
  readonly credentialStoredHelp: string;
  readonly credentialNoneHelp: string;
  readonly enterNewToReplace: string;
  readonly rotateCredential: string;
  readonly saveChanges: string;
  readonly nothingChanged: string;
  readonly changesSaved: string;
  readonly couldNotSaveChanges: string;
  readonly enterNewCredential: string;
  readonly credentialRotated: string;
  readonly couldNotRotate: string;
  readonly deleteHeading: string;
  readonly deleteHelp: string;
  readonly deleteThis: string;
  readonly deleteTitle: (name: string) => string;
  readonly deleteDescription: string;
  readonly deleteConnection: string;
  readonly couldNotDelete: string;
}

const EN: StorageStrings = {
  providerLabel: {
    s3: 'Amazon S3 or compatible',
    gcs: 'Google Cloud Storage',
    azblob: 'Azure Blob Storage',
    file: 'Local folder',
  },
  nameInvalid:
    'Name: use lowercase letters, digits and hyphens, starting with a letter, up to 63 characters. For example: sales-reports.',
  nameLooksLikeId:
    'Name: that looks like a connection ID. Choose a name made of words, for example: sales-reports.',
  keyPairHalf: 'Fill both the access key ID and the secret access key, or leave both empty.',
  problems: {
    storage_connection_url_invalid: 'That is not a valid storage URL for the chosen provider.',
    storage_connection_url_has_secret:
      'The URL must not carry a password, key or signed parameter. Use the credential fields instead.',
    storage_connection_endpoint_forbidden:
      'This deployment does not allow that endpoint or folder. Ask an operator which locations are permitted.',
    storage_connection_name_taken: 'Another storage connection already has that name.',
    storage_connection_not_found: 'That storage connection no longer exists.',
    storage_connection_prefix_not_allowed:
      'That folder is outside the connection’s allowed folders.',
    storage_connection_write_not_allowed: 'This connection does not allow writing.',
    storage_connection_credential_required:
      'Moving the connection to another endpoint, bucket or account needs a new credential. Enter it under Credential and save again.',
    storage_connection_in_use:
      'Agents still grant this connection. Remove their storage grants first, then delete it.',
    storage_connection_unreachable:
      'The storage did not answer. Try again, or check the connection.',
    agent_definition_references_missing:
      'The agent refers to something that no longer exists, so the grant could not be saved.',
  },
  noAccess: 'You don’t have access to connected storage.',
  testOk: 'Connection OK',
  testOkEmpty: (folders) =>
    `Connection OK, but no files found under: ${folders}. Check the folder names.`,
  testForbidden: 'The storage refused the credential or the endpoint.',
  testNotFound: 'The storage location was not found.',
  testUnreachable: 'The storage did not answer.',
  savedConnected: 'Saved and connected.',
  savedConnectedEmpty: (folders) =>
    `Saved and connected, but no files were found under: ${folders}.`,
  savedEmptyNext: 'If a folder name is wrong, edit the connection.',
  savedTestFailed: (outcome) => `Saved, but the test did not pass. ${outcome}`,
  savedForbiddenNext: 'Check the credential and the endpoint, then edit the connection.',
  savedNotFoundNext: 'Check the bucket or folder in the URL, then edit the connection.',
  savedUnreachableNext:
    'Check the URL and that the storage is reachable, then edit the connection or test it again from Storage.',
  savedNotTested: (problem) => `Saved. ${problem}`,
  savedNotTestedNext: 'Test it again from Storage.',
  couldNotTest: 'The connection could not be tested.',

  title: 'Storage',
  intro:
    'Buckets and folders your agents may read. Credentials are write-only: they are stored encrypted and never shown again.',
  connectStorage: '+ Connect storage',
  loading: 'Loading storage connections…',
  empty: 'No storage is connected yet. Connect a bucket or folder to grant it to an agent.',
  couldNotLoadList: 'Storage connections could not be loaded.',
  folders: (list) => `Folders: ${list}`,
  writesAllowed: 'Writes allowed',
  readOnly: 'Read-only',
  credentialStored: 'Credential stored securely · write-only',
  edit: 'Edit',
  editLabel: (name) => `Edit ${name}`,
  test: 'Test',
  testLabel: (name) => `Test ${name}`,
  testing: (name) => `Testing ${name}…`,
  notAllowed: 'Only workspace Owners and Admins can manage storage connections.',

  newTitle: 'Connect storage',
  newIntro:
    'Name a bucket or folder and the folders agents may be granted. Access is read-only unless you allow writing.',
  name: 'Name',
  nameHelp:
    'Lowercase letters, digits and hyphens, starting with a letter, up to 63 characters. Grants use this name.',
  provider: 'Provider',
  url: 'URL',
  urlExample: (hint) => `For example ${hint}.`,
  noKeysInUrl: 'No keys in the URL.',
  urlMoveNeedsCredential: 'Moving to another endpoint, bucket or account needs a new credential.',
  allowedFolders: 'Allowed folders',
  foldersHelp: 'One folder per line, such as reports. Agents see only these.',
  allowWriting: 'Allow writing',
  allowWritingHelp:
    "Off by default. With a read/write grant, a run's new and changed files are written back; nothing is deleted.",
  credential: 'Credential',
  credentialNewHelp:
    'Stored encrypted and never shown again. Leave empty to use the deployment’s own identity.',
  accessKeyId: 'Access key ID',
  secretAccessKey: 'Secret access key',
  serviceAccountJson: 'Service account JSON',
  credentialType: 'Credential type',
  accountKey: 'Account key',
  sasToken: 'SAS token',
  cancel: 'Cancel',
  saveAndTest: 'Save and test',
  couldNotSave: 'The storage connection could not be saved.',
  saved: (name) => `Saved ${name}`,
  testingConnection: 'Testing the connection…',
  editConnection: 'Edit connection',
  done: 'Done',
  backToStorageList: 'Back to Storage',

  editTitle: 'Edit storage connection',
  loadingConnection: 'Loading the storage connection…',
  couldNotLoad: 'The storage connection could not be loaded.',
  backToStorage: 'Back to storage',
  credentialStoredHelp: 'A credential is stored encrypted and never shown again.',
  credentialNoneHelp: 'No credential is stored; the deployment’s own identity is used.',
  enterNewToReplace: 'Enter a new one to replace it.',
  rotateCredential: 'Rotate credential',
  saveChanges: 'Save changes',
  nothingChanged: 'Nothing has changed.',
  changesSaved: 'Changes saved.',
  couldNotSaveChanges: 'The changes could not be saved.',
  enterNewCredential: 'Enter the new credential.',
  credentialRotated: 'Credential rotated. It is stored encrypted and not shown again.',
  couldNotRotate: 'The credential could not be rotated.',
  deleteHeading: 'Delete',
  deleteHelp:
    'Removes the connection and its stored credential. Agents that still grant it must have their grants removed first.',
  deleteThis: 'Delete this connection',
  deleteTitle: (name) => `Delete ${name}?`,
  deleteDescription:
    'The connection and its stored credential are removed. The files in the bucket are not touched. A connection that agents still grant cannot be deleted.',
  deleteConnection: 'Delete connection',
  couldNotDelete: 'The connection could not be deleted.',
};

const JA: StorageStrings = {
  providerLabel: {
    s3: 'Amazon S3 または互換ストレージ',
    gcs: 'Google Cloud Storage',
    azblob: 'Azure Blob Storage',
    file: 'ローカルフォルダー',
  },
  nameInvalid:
    '名前: 英小文字・数字・ハイフンで、英字で始まる 63 文字以内にしてください。例: sales-reports',
  nameLooksLikeId:
    '名前: 接続 ID のように見えます。単語を組み合わせた名前にしてください。例: sales-reports',
  keyPairHalf:
    'アクセスキー ID とシークレットアクセスキーは、両方を入力するか、両方を空欄にしてください。',
  problems: {
    storage_connection_url_invalid: '選んだプロバイダーのストレージ URL として正しくありません。',
    storage_connection_url_has_secret:
      'URL にパスワード、キー、署名付きパラメーターを含めることはできません。認証情報の欄を使ってください。',
    storage_connection_endpoint_forbidden:
      'このデプロイでは、そのエンドポイントまたはフォルダーは許可されていません。許可されている場所を運用担当者に確認してください。',
    storage_connection_name_taken: '同じ名前のストレージ接続がすでにあります。',
    storage_connection_not_found: 'そのストレージ接続はもう存在しません。',
    storage_connection_prefix_not_allowed:
      'そのフォルダーは、接続で許可されたフォルダーの外にあります。',
    storage_connection_write_not_allowed: 'この接続では書き込みが許可されていません。',
    storage_connection_credential_required:
      '別のエンドポイント、バケット、アカウントに移すには新しい認証情報が必要です。「認証情報」に入力して、もう一度保存してください。',
    storage_connection_in_use:
      'この接続はまだエージェントに付与されています。先にエージェントのストレージの付与を外してから削除してください。',
    storage_connection_unreachable:
      'ストレージから応答がありません。もう一度試すか、接続を確認してください。',
    agent_definition_references_missing:
      'エージェントが存在しないものを参照しているため、付与を保存できませんでした。',
  },
  noAccess: '接続済みストレージへのアクセス権がありません。',
  testOk: '接続できました',
  testOkEmpty: (folders) =>
    `接続できましたが、次のフォルダーにファイルがありません: ${folders}。フォルダー名を確認してください。`,
  testForbidden: 'ストレージが認証情報またはエンドポイントを拒否しました。',
  testNotFound: 'ストレージの場所が見つかりませんでした。',
  testUnreachable: 'ストレージから応答がありません。',
  savedConnected: '保存して接続できました。',
  savedConnectedEmpty: (folders) =>
    `保存して接続できましたが、次のフォルダーにファイルがありません: ${folders}。`,
  savedEmptyNext: 'フォルダー名が間違っている場合は、接続を編集してください。',
  savedTestFailed: (outcome) => `保存しましたが、テストに失敗しました。${outcome}`,
  savedForbiddenNext: '認証情報とエンドポイントを確認してから、接続を編集してください。',
  savedNotFoundNext: 'URL のバケットまたはフォルダーを確認してから、接続を編集してください。',
  savedUnreachableNext:
    'URL とストレージに到達できるかを確認してから、接続を編集するか、ストレージ画面からもう一度テストしてください。',
  savedNotTested: (problem) => `保存しました。${problem}`,
  savedNotTestedNext: 'ストレージ画面からもう一度テストしてください。',
  couldNotTest: '接続をテストできませんでした。',

  title: 'ストレージ',
  intro:
    'エージェントが読み取れるバケットとフォルダーです。認証情報は書き込み専用で、暗号化して保存され、二度と表示されません。',
  connectStorage: '+ ストレージを接続',
  loading: 'ストレージ接続を読み込み中…',
  empty:
    'ストレージはまだ接続されていません。バケットやフォルダーを接続すると、エージェントに付与できます。',
  couldNotLoadList: 'ストレージ接続を読み込めませんでした。',
  folders: (list) => `フォルダー: ${list}`,
  writesAllowed: '書き込み可',
  readOnly: '読み取り専用',
  credentialStored: '認証情報は安全に保存済み · 書き込み専用',
  edit: '編集',
  editLabel: (name) => `${name} を編集`,
  test: 'テスト',
  testLabel: (name) => `${name} をテスト`,
  testing: (name) => `${name} をテスト中…`,
  notAllowed: 'ストレージ接続を管理できるのは、ワークスペースのオーナーと管理者だけです。',

  newTitle: 'ストレージを接続',
  newIntro:
    'バケットまたはフォルダーと、エージェントに付与できるフォルダーを指定します。書き込みを許可しない限り、読み取り専用です。',
  name: '名前',
  nameHelp:
    '英小文字・数字・ハイフンで、英字で始まる 63 文字以内。付与のときはこの名前を使います。',
  provider: 'プロバイダー',
  url: 'URL',
  urlExample: (hint) => `（例: ${hint}）`,
  noKeysInUrl: 'URL にキーを含めないでください。',
  urlMoveNeedsCredential:
    '別のエンドポイント、バケット、アカウントに移すには新しい認証情報が必要です。',
  allowedFolders: '許可するフォルダー',
  foldersHelp: '1 行に 1 フォルダー（例: reports）。エージェントにはこれらだけが見えます。',
  allowWriting: '書き込みを許可',
  allowWritingHelp:
    '既定ではオフです。読み書きの付与では、実行で新しく作られたファイルと変更されたファイルが書き戻されます。削除はされません。',
  credential: '認証情報',
  credentialNewHelp:
    '暗号化して保存され、二度と表示されません。空欄にすると、デプロイ自身の ID を使います。',
  accessKeyId: 'アクセスキー ID',
  secretAccessKey: 'シークレットアクセスキー',
  serviceAccountJson: 'サービスアカウントの JSON',
  credentialType: '認証情報の種類',
  accountKey: 'アカウントキー',
  sasToken: 'SAS トークン',
  cancel: 'キャンセル',
  saveAndTest: '保存してテスト',
  couldNotSave: 'ストレージ接続を保存できませんでした。',
  saved: (name) => `${name} を保存しました`,
  testingConnection: '接続をテストしています…',
  editConnection: '接続を編集',
  done: '完了',
  backToStorageList: 'ストレージに戻る',

  editTitle: 'ストレージ接続を編集',
  loadingConnection: 'ストレージ接続を読み込み中…',
  couldNotLoad: 'ストレージ接続を読み込めませんでした。',
  backToStorage: 'ストレージ一覧に戻る',
  credentialStoredHelp: '認証情報は暗号化して保存されており、二度と表示されません。',
  credentialNoneHelp: '認証情報は保存されていません。デプロイ自身の ID を使います。',
  enterNewToReplace: '置き換えるには新しい認証情報を入力してください。',
  rotateCredential: '認証情報を更新',
  saveChanges: '変更を保存',
  nothingChanged: '変更はありません。',
  changesSaved: '変更を保存しました。',
  couldNotSaveChanges: '変更を保存できませんでした。',
  enterNewCredential: '新しい認証情報を入力してください。',
  credentialRotated: '認証情報を更新しました。暗号化して保存され、二度と表示されません。',
  couldNotRotate: '認証情報を更新できませんでした。',
  deleteHeading: '削除',
  deleteHelp:
    '接続と保存された認証情報を削除します。まだこの接続を付与しているエージェントがある場合は、先に付与を外す必要があります。',
  deleteThis: 'この接続を削除',
  deleteTitle: (name) => `${name} を削除しますか？`,
  deleteDescription:
    '接続と保存された認証情報が削除されます。バケット内のファイルには触れません。エージェントにまだ付与されている接続は削除できません。',
  deleteConnection: '接続を削除',
  couldNotDelete: '接続を削除できませんでした。',
};

const STRINGS: Readonly<Record<VersionsLocale, StorageStrings>> = { en: EN, ja: JA };

export function storageStrings(locale: VersionsLocale): StorageStrings {
  return STRINGS[locale];
}
