/**
 * The words of the Files screen's search box (UX-17 in #2086, issue #2090) in English and Japanese,
 * negotiated from `Accept-Language` as the Versions tab is. The rest of the Files screen has no
 * locale yet, so only the search box reads these.
 */
import type { VersionsLocale } from '../agents/versions-messages';

export type FilesSearchLocale = VersionsLocale;

export interface FilesSearchStrings {
  readonly label: string;
  readonly placeholder: string;
  readonly search: string;
  readonly clear: string;
  readonly searching: string;
  readonly heading: (query: string) => string;
  readonly noResults: (query: string) => string;
  readonly partial: string;
  readonly searchAgain: string;
  readonly page: (page: number) => string;
  readonly sheet: (sheet: number) => string;
  readonly openFolder: string;
  readonly download: string;
  readonly noTerms: string;
  readonly unavailable: string;
  readonly switchedOff: string;
  readonly forbidden: string;
  readonly failed: string;
}

const EN: FilesSearchStrings = {
  label: 'Search inside files',
  placeholder: 'Words to find',
  search: 'Search',
  clear: 'Clear search',
  searching: 'Searching…',
  heading: (query) => `Results for "${query}"`,
  noResults: (query) => `No file contains "${query}".`,
  partial:
    'Some files are still being read, so these results may be incomplete. Search again to include them.',
  searchAgain: 'Search again',
  page: (page) => `Page ${String(page)}`,
  sheet: (sheet) => `Sheet ${String(sheet)}`,
  openFolder: 'Open folder',
  download: 'Download',
  noTerms: 'Type at least one word to search for.',
  unavailable: 'File search is not available on this deployment.',
  switchedOff: 'Files is switched off for this workspace. Reload the page.',
  forbidden: 'Your role cannot search files. Ask an Owner of this workspace for access.',
  failed: 'The search failed. Try again.',
};

const JA: FilesSearchStrings = {
  label: 'ファイルの中身を検索',
  placeholder: '検索する言葉',
  search: '検索',
  clear: '検索をクリア',
  searching: '検索中…',
  heading: (query) => `「${query}」の検索結果`,
  noResults: (query) => `「${query}」を含むファイルはありません。`,
  partial:
    'まだ読み込み中のファイルがあるため、結果が一部だけの可能性があります。もう一度検索すると含まれます。',
  searchAgain: 'もう一度検索',
  page: (page) => `${String(page)} ページ`,
  sheet: (sheet) => `シート ${String(sheet)}`,
  openFolder: 'フォルダーを開く',
  download: 'ダウンロード',
  noTerms: '検索する言葉を1つ以上入力してください。',
  unavailable: 'この環境ではファイル検索を利用できません。',
  switchedOff:
    'このワークスペースではファイルがオフになっています。ページを再読み込みしてください。',
  forbidden:
    'あなたのロールではファイルを検索できません。このワークスペースのオーナーに権限を依頼してください。',
  failed: '検索に失敗しました。もう一度お試しください。',
};

export function filesSearchStrings(locale: FilesSearchLocale): FilesSearchStrings {
  return locale === 'ja' ? JA : EN;
}
