import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'floor',
  agent: 'maintenance-troubleshooting',
  title: '設備トラブル対応',
  // A full page: the shop-floor tablet opens /p/s/floor and nothing else.
  layout: 'page',
  parts: {
    greeting:
      '設備番号（または設備名）と、起きている現象を入力してください。1つずつ確認していきます。',
    suggestedPrompts: [
      'プレス2号機 油圧が上がらない',
      'マシニングセンタ5号機 主軸から異音',
      '射出成形機4号機 型締め圧が上がらない',
    ],
    disclaimer: '作業は必ず停止・LOTO の後に。判断に迷ったら作業を止めて班長に連絡してください。',
    // The technician needs the next step, not the agent's tool calls.
    toolTrace: 'hidden',
    feedback: true,
  },
  limits: { turnsPerConversation: 20 },
});
