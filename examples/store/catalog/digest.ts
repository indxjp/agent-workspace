import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'digest',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/digest',
  name: {
    ja: '調査ダイジェスト',
    en: 'Research digest',
  },
  summary: {
    ja: '指定テーマの社内外の資料を週に1度まとめる。',
    en: 'Writes a weekly digest of internal and external material on a topic.',
  },
  demo: {
    agent: 'digest',
    prompts: [
      {
        ja: '2026-11-24 までの1週間の調査ダイジェストを作成して',
        en: 'Write the research digest for the week up to 2026-11-24',
      },
      {
        ja: '2026-11-17 までの1週間の調査ダイジェストを作成して',
        en: 'Write the research digest for the week up to 2026-11-17',
      },
    ],
    moment: {
      ja: 'その週の社内メモと公開情報が、日付と出典つきで一つのダイジェストにまとまり、公開情報の時点を示し、保存は承認を待つ。',
      en: 'The week’s internal notes and public releases are gathered in one digest with dates and sources, saying the date the public sources stand as of; the save waits for approval.',
    },
    data: {
      ja: '架空の社内の調査メモと、公開情報の日付つきスナップショット',
      en: 'fictional internal research notes and a dated snapshot of public releases',
    },
    seed: [{ collection: 'digest', from: 'data/ja' }],
    check: { tools: ['read_digest_sources'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
