import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'excel-consolidation',
  area: 'finance',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/excel-consolidation',
  name: {
    ja: 'Excel集計・分析',
    en: 'Excel consolidation',
  },
  summary: {
    ja: '各部署から届くExcelを1つにまとめ、差の大きい項目を説明付きで報告する。',
    en: 'Merges spreadsheets from every department and explains the biggest differences.',
  },
  demo: {
    agent: 'excel-consolidation',
    prompts: [
      {
        ja: '今月（2025年5月）の拠点別売上を集計して、前月からの増減を説明して',
        en: "Consolidate this month's (May 2025) sales by branch and explain the change from last month.",
      },
      {
        ja: '2025年5月と4月の拠点別売上を集計する計画を出して',
        en: 'Show me the plan for consolidating May and April 2025 sales by branch.',
      },
    ],
    moment: {
      ja: '形式のバラバラな5拠点のExcelが1つの表になり、差の大きい拠点に説明が付く。',
      en: 'Spreadsheets of five different shapes, one per branch, become one table, with notes on the biggest gaps.',
    },
    data: {
      ja: '5拠点の月次売上報告Excel 10ファイル',
      en: '10 monthly sales-report spreadsheets from 5 branches',
    },
    seed: [
      { collection: '共通', from: 'data/共通' },
      { collection: '東京支店', from: 'data/東京支店' },
      { collection: '大阪支店', from: 'data/大阪支店' },
      { collection: '名古屋営業所', from: 'data/名古屋営業所' },
      { collection: '札幌営業所', from: 'data/札幌営業所' },
      { collection: '福岡支店', from: 'data/福岡支店' },
    ],
    check: { tools: ['search_files', 'run_skill_script'], approval: 'Write' },
  },
  safety: ['person', 'files', 'structured'],
  next: {
    source: 'use-cases/excel-consolidation',
    demo: {
      agent: 'excel-consolidation',
      prompts: [
        {
          ja: '今月（2025年5月）の拠点別売上を集計して、前月からの増減を説明して',
          en: "Consolidate this month's (May 2025) sales by branch and explain the change from last month.",
        },
        {
          ja: '2025年5月と4月の拠点別売上を集計する計画を出して',
          en: 'Show me the plan for consolidating May and April 2025 sales by branch.',
        },
      ],
      moment: {
        ja: '形式のバラバラな5拠点のExcelが、承認した計画どおりに1つの表とExcelファイルになり、差の大きい拠点に説明が付く。',
        en: 'Spreadsheets of five different shapes, one per branch, become one table and one workbook on the plan a person approved, with notes on the biggest gaps.',
      },
      data: {
        ja: '架空の5拠点の月次売上報告Excel 10ファイルと、テンプレート・経費精算・メモ',
        en: '10 fictional monthly sales workbooks from 5 branches, plus a template, an expense report and a note',
      },
      seed: [{ collection: 'excel-consolidation', from: 'data' }],
      check: { tools: ['search_files'], approval: 'run_skill_script' },
    },
  },
});
