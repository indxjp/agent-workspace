import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'supplier',
  title: '仕入先品質管理 / Supplier quality',
  layout: 'side',
  parts: {
    greeting:
      '受入検査とクレームから、仕入先ごとの不良率と要注意の仕入先を毎月まとめます。仕入先への連絡はしません。 / From incoming inspections and claims, I report each supplier’s defect rate and who is on watch. I never contact a supplier.',
    suggestedPrompts: [
      '2026年11月の仕入先品質レポートを作成して',
      'Write the supplier quality report for November 2026',
      'ヒサメ樹脂の2026年6月から11月の不良率の推移とクレームを教えて',
      'Show Hisame Resin’s defect rate from June to November 2026 and its claims',
    ],
  },
  // The typed report's rows, drawn under the answer (ADR-0168).
  resultCharts: [
    {
      kind: 'bar',
      field: 'suppliers',
      label: 'supplier',
      value: 'defectPpm',
      title: { ja: '仕入先別の不良率（当月・ppm）', en: 'Defect rate by supplier (month, ppm)' },
      axes: { label: { ja: '仕入先', en: 'Supplier' }, value: { ja: 'ppm', en: 'ppm' } },
    },
    {
      kind: 'line',
      field: 'trend',
      label: 'month',
      value: 'defectPpm',
      title: { ja: '全仕入先の不良率の推移（ppm）', en: 'All suppliers’ defect rate (ppm)' },
      axes: { label: { ja: '月', en: 'Month' }, value: { ja: 'ppm', en: 'ppm' } },
    },
  ],
});
