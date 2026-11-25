import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'logs',
  title: 'ログ分析 / Log analyst',
  layout: 'page',
  parts: {
    attachments: true,
    greeting: '分析するログのCSVを指定してください。 / Name the log CSV to analyse.',
    suggestedPrompts: [
      'アプリログ_2026-11-20.csv で、エラーが急増した時間帯と主なエラーのパターンを教えて',
      'In app-log-2026-11-20.csv, when did the errors spike and what are the main error patterns?',
      'アプリログ_2026-11-20.csv で、auth-api の警告とエラーを5分ごとに見て',
      'In app-log-2026-11-20.csv, show the auth-api warnings and errors in 5-minute buckets',
    ],
    disclaimer:
      '秘密情報や個人情報は伏せて示します。判断は担当者が行います。 / Secrets and personal data stay masked. A person decides.',
    toolTrace: 'collapsed',
    history: true,
  },
  // The typed output's rows, drawn under the answer (ADR-0168): field, row label and row value.
  resultCharts: [
    {
      kind: 'line',
      field: 'buckets',
      label: 'start',
      value: 'errors',
      title: { ja: '時間帯別のエラー件数', en: 'Errors by time' },
      axes: { label: { ja: '時刻', en: 'Time' }, value: { ja: 'エラー', en: 'Errors' } },
    },
  ],
});
