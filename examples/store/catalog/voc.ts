import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'voc',
  area: 'support',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/voc',
  name: {
    ja: 'お客様の声分析',
    en: 'Voice of the customer',
  },
  summary: {
    ja: '問い合わせやレビューを分類し、月次の改善テーマを報告する。',
    en: 'Classifies enquiries and reviews and reports monthly improvement themes.',
  },
  demo: {
    agent: 'voc',
    prompts: [
      {
        ja: '2026年10月のお客様の声レポートを作成して',
        en: 'Write the voice-of-the-customer report for October 2026',
      },
      {
        ja: '2026年10月の声のうち、電気ケトル KT-20 についてのものだけをまとめて',
        en: 'Summarise only the October 2026 voices about the Electric kettle KT-20',
      },
    ],
    moment: {
      ja: '問い合わせとレビューが改善テーマと好評のテーマにIDつきでまとまり、お客様の名前や連絡先は書かず、保存は承認を待つ。',
      en: 'Enquiries and reviews are grouped into issue and praise themes by id, no customer name or contact detail is written, and the save waits for approval.',
    },
    data: {
      ja: '架空のヘルプデスクの問い合わせとストアのレビューのCSV',
      en: 'a fictional helpdesk’s enquiries and a store’s reviews as CSV',
    },
    seed: [{ collection: 'voc', from: 'data' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
