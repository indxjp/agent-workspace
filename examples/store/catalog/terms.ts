import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'terms',
  area: 'legal',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/terms',
  name: {
    ja: '利用規約の改定',
    en: 'Terms updater',
  },
  summary: {
    ja: '規約の改定案について、新旧対照表とお知らせ文を作る。',
    en: 'Builds the before-and-after table and notice for a terms update.',
  },
  demo: {
    agent: 'terms',
    prompts: [
      {
        ja: 'TM-03 の改定メモから新旧対照表とお知らせ文を作成して',
        en: 'Draft the before-and-after table and the notice from the TM-03 memo',
      },
      {
        ja: 'TM-03 の新旧対照表とお知らせ文の構成だけを示して。ファイルはまだ作らないで',
        en: 'Show only the outline of the TM-03 table and notice; do not write a file yet',
      },
    ],
    moment: {
      ja: '改定メモを渡すと、新旧対照表とお知らせ文の構成が出て、Word の書き出しが承認待ちになる。法的な判断は出さない。',
      en: 'Hand over a change memo; out comes the before-and-after table and the notice, with no legal verdict, and the Word document waits for approval.',
    },
    data: {
      ja: '架空のアプリの規約改定メモ・現行の利用規約・お知らせ文の社内ルール',
      en: 'fictional change memos, current terms of service and in-house notice rules for an app',
    },
    seed: [{ collection: 'terms', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
