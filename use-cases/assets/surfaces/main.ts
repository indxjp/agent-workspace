import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'assets',
  title: 'IT資産棚卸 / Asset inventory',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '資産台帳と端末の検出結果のCSVを指定してください。 / Name the register and inventory CSVs.',
    suggestedPrompts: [
      'IT資産台帳_2026年11月.csv と 端末検出結果_2026-11-20.csv を突き合わせて、台帳と実態の差を洗い出して',
      'Compare asset-register-2026-11.csv with device-inventory-2026-11-20.csv and list the gaps',
      'IT資産台帳_2026年11月.csv と 端末検出結果_2026-11-20.csv で、ライセンスの過不足と60日以上接続のない端末を教えて',
      'In asset-register-2026-11.csv and device-inventory-2026-11-20.csv, show the licence gaps and PCs not seen for over 60 days',
    ],
    disclaimer: '数値はスクリプトの計算結果です。判断は担当者が行います。 / A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'bar',
      field: 'licences',
      label: 'product',
      value: 'gap',
      title: { ja: 'ライセンスの過不足（導入数−保有数）', en: 'Licence gap (installed − owned)' },
      axes: { label: { ja: '製品', en: 'Product' }, value: { ja: '過不足', en: 'Gap' } },
    },
  ],
});
