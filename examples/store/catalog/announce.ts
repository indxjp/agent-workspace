import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'announce',
  area: 'collab',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/announce',
  name: {
    ja: '社内告知文',
    en: 'Announcement writer',
  },
  summary: {
    ja: '決定メモから、日本語と英語の社内告知の下書きを一つの文書で作る。',
    en: 'Drafts an internal announcement in Japanese and English from a decision memo, in one document.',
  },
  demo: {
    agent: 'announce',
    prompts: [
      {
        ja: '決定メモ DM-2026-014 から社内告知を作成して',
        en: 'Draft the internal announcement from decision memo DM-2026-014',
      },
      {
        ja: 'DM-2026-014 の社内告知の構成だけを示して',
        en: 'Show only the outline of the announcement for DM-2026-014',
      },
    ],
    moment: {
      ja: '決定メモを渡すと、日英の告知の構成がメモの節付きで出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over the decision memo; out comes the outline in both languages with memo sections cited, and the Word document waits for approval.',
    },
    data: {
      ja: '架空の決定メモと社内告知の書き方',
      en: 'a fictional decision memo and announcement style guide',
    },
    seed: [{ collection: 'announce', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
