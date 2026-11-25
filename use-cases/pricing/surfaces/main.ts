import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'pricing',
  title: '価格分析 / Pricing analyst',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '売上のCSVと価格の変更率を指定してください。 / Name the sales CSV and the price change.',
    suggestedPrompts: [
      '商品別売上_2025年12月-2026年11月.csv で、全商品を5%値上げした場合の売上への影響を試算して',
      'Using sales-by-product-2025-12-to-2026-11.csv, estimate the effect on sales of a 5% price increase on every product',
      '商品別売上_2025年12月-2026年11月.csv で、全商品を10%値下げした場合の影響を試算して',
      'Using sales-by-product-2025-12-to-2026-11.csv, estimate the effect of a 10% price cut on every product',
    ],
    disclaimer:
      '過去の値動きからの試算で、予測ではありません。 / An estimate from past changes, not a forecast.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'products',
      label: 'productName',
      value: 'revenueChange',
      title: { ja: '商品別の売上の増減の試算（円）', en: 'Estimated revenue change (yen)' },
      axes: { label: { ja: '商品', en: 'Product' }, value: { ja: '増減', en: 'Change' } },
    },
    {
      kind: 'line',
      field: 'trend',
      label: 'month',
      value: 'revenue',
      title: { ja: '月別の売上（円）', en: 'Revenue by month (yen)' },
      axes: { label: { ja: '月', en: 'Month' }, value: { ja: '売上', en: 'Revenue' } },
    },
  ],
});
