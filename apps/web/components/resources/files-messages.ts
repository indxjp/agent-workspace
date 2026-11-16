/**
 * The words of the Files screen and of the `FilePicker` agent detail opens from "Add files or
 * folders", in English and Japanese, negotiated from `Accept-Language` as the other screens are
 * (UX-15 in #2086). The search box keeps its own words in `files-search-messages.ts`.
 *
 * English is the text these screens always printed, word for word. What the server or the browser
 * sends — a refusal's sentence, a network failure — cannot be translated here: it is kept as it was
 * sent and marked English, after a lead in the reader's language (see {@link Said}).
 */
import type { VersionsLocale } from '../agents/versions-messages';

export type FilesLocale = VersionsLocale;

/** One piece of a line: either this screen's own words, or the server's / browser's, kept English. */
interface SaidPart {
  readonly text: string;
  /** Sent by the server or the browser: shown as sent, marked `lang="en"` in another language. */
  readonly english?: true;
}

/** A line built from parts, joined with a space; empty parts are left out. */
export type Said = readonly SaidPart[];

export function saidText(said: Said): string {
  return said
    .map((part) => part.text)
    .filter((text) => text !== '')
    .join(' ');
}

export interface FilesStrings {
  readonly title: string;
  readonly description: string;
  readonly loading: string;
  readonly uploadLabel: string;
  readonly uploadButton: string;
  readonly uploadFolderLabel: string;
  readonly uploadFolderButton: string;
  /** The grant hint, around `files('<folder or file path>')`, which stays code. */
  readonly grantHintBefore: string;
  readonly grantHintAfter: string;
  readonly newFolderLabel: string;
  readonly newFolderPlaceholder: string;
  readonly newFolderButton: string;
  readonly folderNameIsName: string;
  readonly breadcrumb: string;
  readonly home: string;
  readonly back: string;
  readonly columns: {
    readonly select: string;
    readonly name: string;
    readonly type: string;
    readonly size: string;
    readonly contentType: string;
    readonly modified: string;
    readonly actions: string;
  };
  readonly kind: { readonly file: string; readonly folder: string };
  readonly selectRow: (name: string) => string;
  readonly download: string;
  readonly rename: string;
  readonly delete: string;
  readonly newPathFor: string;
  readonly moveToFolder: string;
  readonly save: string;
  readonly cancel: string;
  readonly emptyFolder: string;
  readonly isAFile: (path: string) => string;
  readonly noSuchFolder: (path: string) => string;
  readonly confirmDeleteFolder: (name: string) => string;
  readonly confirmDeleteFile: (name: string) => string;
  readonly confirmNotEmpty: (name: string) => string;
  readonly staleList: string;
  /** Leads a refusal the server worded; English prints the refusal alone. */
  readonly leads: {
    readonly list: string;
    readonly rename: string;
    readonly delete: string;
    readonly createFolder: string;
    readonly upload: string;
  };
  readonly emptyFile: (name: string) => string;
  readonly overHardLimit: (name: string, gib: string) => string;
  readonly folderUnreadable: (path: string) => string;
  readonly folderNotCreated: (path: string) => string;
  readonly tooManyFiles: (max: string) => string;
  /** Before a reason that does not name the file. */
  readonly notUploaded: (name: string) => string;
  /** Before a server reason that already names the file; English prints the reason alone. */
  readonly notUploadedNamed: (name: string) => string;
  readonly overDeployment: (name: string, size: string, always: string) => string;
  readonly uploadReturned: (status: string) => string;
  readonly moveUnfinished: (moved: string, total: string) => string;
  readonly deleteUnfinished: (deleted: string, remaining: string) => string;
  readonly someNotUploaded: (failed: string, total: string) => string;
  readonly uploadingOne: (name: string) => string;
  readonly uploadingOf: (current: string, total: string, name: string) => string;
  readonly finished: (done: string, total: string) => string;
  readonly state: {
    readonly waiting: string;
    readonly uploading: string;
    readonly done: string;
    readonly failed: string;
  };
  readonly uploadResults: string;
  readonly dropWait: string;
  readonly dropHere: string;
}

const EN: FilesStrings = {
  title: 'Files',
  description: 'Browse workspace folders, upload inputs, and manage stored outputs.',
  loading: 'Loading files…',
  uploadLabel: 'Upload files to this folder',
  uploadButton: 'Upload here',
  uploadFolderLabel: 'Upload a folder and everything in it',
  uploadFolderButton: 'Upload folder here',
  grantHintBefore: 'Agents see a file only after it is granted. Add',
  grantHintAfter: "to the agent's definition. Chat attachments are not supported yet.",
  newFolderLabel: 'New folder name',
  newFolderPlaceholder: 'reports',
  newFolderButton: 'Create folder here',
  folderNameIsName: 'A folder name is a single name, not a path.',
  breadcrumb: 'Folder breadcrumb',
  home: 'Home',
  back: 'Back',
  columns: {
    select: 'Select',
    name: 'Name',
    type: 'Type',
    size: 'Size',
    contentType: 'Content type',
    modified: 'Modified',
    actions: 'Actions',
  },
  kind: { file: 'file', folder: 'folder' },
  selectRow: (name) => `Select ${name}`,
  download: 'Download',
  rename: 'Rename',
  delete: 'Delete',
  newPathFor: 'New path for',
  moveToFolder: 'Move to folder',
  save: 'Save',
  cancel: 'Cancel',
  emptyFolder: 'This folder is empty.',
  isAFile: (path) => `"${path}" is a file, not a folder. Go up one folder to see it.`,
  noSuchFolder: (path) =>
    `There is no folder "${path}". It may have been moved, renamed or deleted.`,
  confirmDeleteFolder: (name) =>
    `Delete "${name}"? If it contains anything you will be asked to confirm removing it too.`,
  confirmDeleteFile: (name) => `Delete "${name}"? This cannot be undone.`,
  confirmNotEmpty: (name) => `"${name}" is not empty. Delete it and everything inside it?`,
  staleList: 'The list could not be refreshed, so it may be out of date.',
  leads: { list: '', rename: '', delete: '', createFolder: '', upload: '' },
  emptyFile: (name) => `"${name}" is empty (0 bytes), so it was not uploaded.`,
  overHardLimit: (name, gib) =>
    `"${name}" is larger than the ${gib} GiB limit, so it was not uploaded.`,
  folderUnreadable: (path) => `The folder "${path}" could not be read, so it was not uploaded.`,
  folderNotCreated: (path) => `The empty folder "${path}" was not created:`,
  tooManyFiles: (max) =>
    `This upload has more than ${max} files, so nothing was uploaded. Upload a smaller folder, or its folders one at a time.`,
  notUploaded: (name) => `"${name}" was not uploaded:`,
  notUploadedNamed: () => '',
  overDeployment: (name, size, always) =>
    `"${name}" is ${size}, more than this deployment accepts. Files up to ${always} always upload here.`,
  uploadReturned: (status) => `Upload returned ${status}.`,
  moveUnfinished: (moved, total) =>
    `Move did not finish: ${moved} of ${total} items moved; the rest are still at the old location.`,
  deleteUnfinished: (deleted, remaining) =>
    `Delete did not finish: ${deleted} removed, ${remaining} still present. Try again.`,
  someNotUploaded: (failed, total) =>
    `${failed} of ${total} files were not uploaded. The list below says why.`,
  uploadingOne: (name) => `Uploading ${name}…`,
  uploadingOf: (current, total, name) => `Uploading ${current} of ${total}: ${name}…`,
  finished: (done, total) => `Finished: ${done} of ${total} files uploaded.`,
  state: { waiting: 'Waiting', uploading: 'Uploading…', done: 'Uploaded', failed: 'Not uploaded' },
  uploadResults: 'Upload results',
  dropWait: 'Wait for the current upload to finish.',
  dropHere: 'Drop to upload to this folder.',
};

const JA: FilesStrings = {
  title: 'ファイル',
  description:
    'ワークスペースのフォルダーを閲覧し、入力ファイルをアップロードし、保存された出力を管理します。',
  loading: 'ファイルを読み込み中…',
  uploadLabel: 'このフォルダーにファイルをアップロード',
  uploadButton: 'ここにアップロード',
  uploadFolderLabel: 'フォルダーを中身ごとアップロード',
  uploadFolderButton: 'ここにフォルダーをアップロード',
  grantHintBefore: 'エージェントがファイルを見られるのは、付与した後だけです。エージェントの定義に',
  grantHintAfter: 'を追加してください。チャットへの添付にはまだ対応していません。',
  newFolderLabel: '新しいフォルダー名',
  newFolderPlaceholder: '報告書',
  newFolderButton: 'ここにフォルダーを作成',
  folderNameIsName: 'フォルダー名はパスではなく、1つの名前にしてください。',
  breadcrumb: 'フォルダーの階層',
  home: 'ホーム',
  back: '戻る',
  columns: {
    select: '選択',
    name: '名前',
    type: '種類',
    size: 'サイズ',
    contentType: 'コンテンツタイプ',
    modified: '更新日時',
    actions: '操作',
  },
  kind: { file: 'ファイル', folder: 'フォルダー' },
  selectRow: (name) => `${name} を選択`,
  download: 'ダウンロード',
  rename: '名前を変更',
  delete: '削除',
  newPathFor: '新しいパス:',
  moveToFolder: '移動先のフォルダー',
  save: '保存',
  cancel: 'キャンセル',
  emptyFolder: 'このフォルダーは空です。',
  isAFile: (path) =>
    `「${path}」はフォルダーではなくファイルです。1つ上のフォルダーで確認してください。`,
  noSuchFolder: (path) =>
    `フォルダー「${path}」はありません。移動、名前の変更、または削除された可能性があります。`,
  confirmDeleteFolder: (name) =>
    `「${name}」を削除しますか？中身がある場合は、それも削除するか改めて確認します。`,
  confirmDeleteFile: (name) => `「${name}」を削除しますか？元に戻せません。`,
  confirmNotEmpty: (name) => `「${name}」は空ではありません。中身ごと削除しますか？`,
  staleList: '一覧を更新できなかったため、最新ではない可能性があります。',
  leads: {
    list: 'フォルダーを読み込めませんでした。',
    rename: '名前を変更できませんでした。',
    delete: '削除できませんでした。',
    createFolder: 'フォルダーを作成できませんでした。',
    upload: 'アップロードできませんでした。',
  },
  emptyFile: (name) => `「${name}」は空（0 バイト）のため、アップロードしませんでした。`,
  overHardLimit: (name, gib) =>
    `「${name}」は上限の ${gib} GiB を超えているため、アップロードしませんでした。`,
  folderUnreadable: (path) =>
    `フォルダー「${path}」を読み取れなかったため、アップロードしませんでした。`,
  folderNotCreated: (path) => `空のフォルダー「${path}」を作成できませんでした：`,
  tooManyFiles: (max) =>
    `ファイルが ${max} 件を超えているため、何もアップロードしませんでした。小さいフォルダーにするか、中のフォルダーを1つずつアップロードしてください。`,
  notUploaded: (name) => `「${name}」はアップロードされませんでした：`,
  notUploadedNamed: (name) => `「${name}」はアップロードされませんでした：`,
  overDeployment: (name, size, always) =>
    `「${name}」は ${size} で、この環境で受け付けられる大きさを超えています。${always} までのファイルはいつでもアップロードできます。`,
  uploadReturned: (status) => `アップロードがステータス ${status} を返しました。`,
  moveUnfinished: (moved, total) =>
    `移動が完了しませんでした。${total} 件中 ${moved} 件を移動し、残りは元の場所にあります。`,
  deleteUnfinished: (deleted, remaining) =>
    `削除が完了しませんでした。${deleted} 件を削除し、${remaining} 件が残っています。もう一度お試しください。`,
  someNotUploaded: (failed, total) =>
    `${total} 件中 ${failed} 件のファイルをアップロードできませんでした。理由は下の一覧のとおりです。`,
  uploadingOne: (name) => `${name} をアップロード中…`,
  uploadingOf: (current, total, name) => `${total} 件中 ${current} 件目をアップロード中：${name}…`,
  finished: (done, total) => `完了：${total} 件中 ${done} 件のファイルをアップロードしました。`,
  state: {
    waiting: '待機中',
    uploading: 'アップロード中…',
    done: 'アップロード済み',
    failed: '未アップロード',
  },
  uploadResults: 'アップロード結果',
  dropWait: '現在のアップロードが終わるまでお待ちください。',
  dropHere: 'ドロップしてこのフォルダーにアップロード',
};

export function filesStrings(locale: FilesLocale): FilesStrings {
  return locale === 'ja' ? JA : EN;
}

/** English words, for helpers called without a reader (tests and older callers). */
export const ENGLISH_FILES_STRINGS: FilesStrings = EN;
