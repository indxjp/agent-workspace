import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'ir-qa',
  area: 'finance',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/ir-qa',
  name: {
    ja: 'IR想定問答',
    en: 'IR Q&A prep',
  },
  summary: {
    ja: '決算資料から投資家向けの想定問答を作る。',
    en: 'Prepares investor Q&A from earnings materials.',
  },
  demo: {
    agent: 'ir-qa',
    prompts: [
      {
        ja: '第2四半期決算説明会の想定問答を作成して',
        en: 'Draft the expected Q&A for the Q2 results briefing',
      },
      {
        ja: '配当と株主還元についての想定問答だけを作成して',
        en: 'Draft the expected Q&A on dividends and shareholder returns only',
      },
    ],
    moment: {
      ja: 'IR担当のメモを渡すと、開示済みの資料の出典付きで想定問答の構成が出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over the IR memo; out comes an expected Q&A outline citing the disclosed materials, and the Word file waits for approval.',
    },
    data: {
      ja: '架空の会社の決算短信・決算説明資料・前回の質疑応答の要旨・ディスクロージャーポリシー・IR担当のメモ',
      en: "a fictional company's earnings summary, results presentation, last Q&A summary, disclosure policy and IR memo",
    },
    seed: [{ collection: 'ir-qa', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
