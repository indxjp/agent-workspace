import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'privacy',
  title: '個人情報影響評価 / Privacy impact assessment',
  layout: 'page',
  parts: {
    greeting:
      'サービスの設計メモと社内のチェックリストから、項目ごとに記載と確認したいことをまとめた個人情報影響評価の下書きを Word で作ります。法的な判断はしません。書き出す前に承認をお願いします。 / From a service design memo and your checklist, I draft a privacy impact assessment as a Word document, item by item, with the points still to check. I give no legal opinion, and I ask for your approval before writing it.',
    suggestedPrompts: [
      'DS-12 の設計メモから個人情報影響評価を作成して',
      'Draft the privacy impact assessment from the DS-12 design memo',
      'DS-12 の個人情報影響評価の構成だけを示して',
    ],
    disclaimer:
      '下書きで、法的助言ではありません。法令への適合は法務部が判断します。 / A draft, not legal advice: Legal decides whether the service complies.',
    toolTrace: 'collapsed',
    history: true,
  },
});
