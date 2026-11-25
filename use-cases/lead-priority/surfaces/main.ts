import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'lead-priority',
  title: 'リード優先度づけ / Lead prioritizer',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '並べるリードのCSVを指定してください。 / Name the lead CSV to rank.',
    suggestedPrompts: [
      'リード一覧_2026年11月.csv のリードを、先に連絡すべき順に並べて',
      'Rank the leads in leads-2026-11.csv in the order to contact them',
      'リード一覧_2026年11月.csv で、展示会から来たリードだけを優先順に並べて',
      'In leads-2026-11.csv, rank only the leads that came from events',
    ],
    disclaimer:
      'リードの順位で、人の評価ではありません。連絡は担当者が決めます。 / Leads, never people.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'leads',
      label: 'company',
      value: 'score',
      title: { ja: 'リードの点数', en: 'Lead scores' },
      axes: { label: { ja: '会社', en: 'Company' }, value: { ja: '点数', en: 'Score' } },
    },
    {
      kind: 'bar',
      field: 'sources',
      label: 'source',
      value: 'averageScore',
      title: { ja: '流入元ごとの平均点', en: 'Average score by source' },
      axes: { label: { ja: '流入元', en: 'Source' }, value: { ja: '平均点', en: 'Average' } },
    },
  ],
});
