import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'churn',
  title: '解約予兆分析 / Churn signals',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '分析する利用状況のCSVを指定してください。 / Name the account usage CSV.',
    suggestedPrompts: [
      '利用状況_2026年6月-11月.csv で、解約の兆候がある顧客と、その兆候を示して',
      'In account-usage-2026-06-to-11.csv, show the customer accounts with signs of leaving and the signs',
      '利用状況_2026年6月-11月.csv で、兆候が1つでもある顧客をすべて挙げて',
      'In account-usage-2026-06-to-11.csv, list every customer account with at least one sign',
    ],
    disclaimer: '利用状況からの兆候で、予測ではありません。 / Signs from usage, not a prediction.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'atRisk',
      label: 'accountName',
      value: 'signCount',
      title: { ja: '兆候のある顧客（兆候の数）', en: 'Accounts with signs (number of signs)' },
      axes: { label: { ja: '顧客', en: 'Account' }, value: { ja: '兆候', en: 'Signs' } },
    },
    {
      kind: 'bar',
      field: 'accounts',
      label: 'accountName',
      value: 'adoption',
      title: { ja: '顧客別の利用率（%）', en: 'Adoption by account (%)' },
      axes: { label: { ja: '顧客', en: 'Account' }, value: { ja: '利用率', en: 'Adoption' } },
    },
  ],
});
