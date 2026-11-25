import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'okr',
  title: 'OKR進捗 / OKR tracker',
  layout: 'side',
  parts: {
    greeting:
      'OKRツールのチェックインから、主要な結果ごとの進み具合を期待値と比べて報告します。人の評価はしません。 / From the OKR check-ins, I report each key result against the progress expected by now. I never rate anyone.',
    suggestedPrompts: [
      '2026-11-20 のチェックインからOKR進捗レポートを作成して',
      'Write the OKR progress report from the 2026-11-20 check-ins',
      '2026-11-20 のチェックインで、遅れている主要な結果と更新のない主要な結果を教えて',
      'In the 2026-11-20 check-ins, which key results are behind or have no update?',
    ],
  },
  // The typed report's rows, drawn under the answer (ADR-0168): each key result's progress.
  resultCharts: [
    {
      kind: 'bar',
      field: 'keyResults',
      label: 'kr',
      value: 'progress',
      title: { ja: '主要な結果ごとの進捗率（%）', en: 'Progress by key result (%)' },
      axes: {
        label: { ja: '主要な結果', en: 'Key result' },
        value: { ja: '進捗率', en: 'Progress' },
      },
    },
  ],
});
