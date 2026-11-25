import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'excel-consolidation',
  title: 'Excel集計・分析 / Excel consolidation',
  layout: 'page',
  parts: {
    greeting:
      '集計する月を教えてください。拠点ごとに形式の違うExcelを探し、読み方の計画を先にお見せします。集計と保存は承認のあとです。 / Name the months. I find each branch’s workbook, whatever its layout, and show the plan first; consolidating and saving wait for your approval.',
    suggestedPrompts: [
      '今月（2025年5月）の拠点別売上を集計して、前月からの増減を説明して',
      "Consolidate this month's (May 2025) sales by branch and explain the change from last month.",
      '2025年5月と4月の拠点別売上を集計する計画を出して',
      'Show me the plan for consolidating May and April 2025 sales by branch.',
    ],
    disclaimer:
      '数値はスクリプトの集計結果です。各行の出典で原本を確認できます。 / Figures are the script’s; each row names its source.',
    toolTrace: 'collapsed',
    history: true,
  },
});
