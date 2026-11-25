import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'kyt',
  title: '危険予知（KY）支援 / Hazard prediction',
  layout: 'page',
  parts: {
    greeting:
      '作業予定から、作業基準とヒヤリハット報告にある危険と対策だけを場面ごとに並べた KY シートの下書きを Word で作ります。危険のポイントと行動目標は班で決めます。書き出す前に承認をお願いします。 / From a work plan, I draft a KY sheet as a Word document with the hazards and measures of each scene, taken only from your work standard and near-miss reports. Your team picks the key hazards and the action goal, and I ask for your approval before writing it.',
    suggestedPrompts: [
      '11月25日の第2倉庫の棚入れの作業予定から、KY シートを作成して',
      'Draft the KY sheet for the Warehouse 2 racking on 25 November from the work plan',
      '第2倉庫の棚入れの KY シートの構成だけを示して',
      'Show only the outline of the KY sheet for the Warehouse 2 racking',
    ],
    disclaimer:
      '下書きです。KY ミーティングで班が確認し、危険のポイントと行動目標を決めます。 / A draft: the team checks it at the KY meeting and decides the key hazards and the action goal.',
    toolTrace: 'collapsed',
    history: true,
  },
});
