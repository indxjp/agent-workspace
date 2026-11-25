import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'offboarding',
  title: '退職手続き / Offboarding',
  layout: 'side',
  parts: {
    greeting:
      '退職する人の名前か社員番号を教えてください。返却物と引き継ぎを一覧にし、権限の取り消しを一件ずつ承認のあとに登録します。 / Name the leaver: I list the returns and the handover, and record each access removal after a person approves it.',
    suggestedPrompts: [
      '12月11日に最終出社の汀 千尋さんの退職手続きを進めて',
      'Start the offboarding for Chihiro Migiwa, whose last working day is December 11',
      '生産管理部の樋渡 紗英さんの退職手続きを進めて',
      'Start the offboarding for Sae Hiwatari in Production Control',
    ],
    disclaimer:
      '権限の取り消しは一件ずつ承認のあとに登録します。アカウントやデータは消さず、退職する人を評価しません。 / Each access removal is recorded only after a person approves it. It never deletes an account or data, and never assesses the person.',
    toolTrace: 'collapsed',
  },
});
