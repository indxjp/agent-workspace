import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'planning',
  agent: 'excel-consolidation',
  title: '拠点別売上の集計',
  layout: 'page',
  parts: {
    greeting:
      '集計したい月を教えてください。各拠点の Excel を探して、読み方の計画を先にお見せします。',
    suggestedPrompts: [
      '今月の拠点別売上を集計して、前月からの増減を説明して',
      '5月の売上を拠点別にまとめて',
    ],
    disclaimer: '数値はスクリプトの集計結果です。各値の出典セルで原本を確認できます。',
    toolTrace: 'collapsed',
    history: true,
    feedback: true,
  },
  // Found files render as a table. The key is matched against the tool name exactly; see the
  // tutorial for the prefixed name a Claude run gives an MCP tool.
});
