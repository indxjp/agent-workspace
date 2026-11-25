import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'handover',
  title: '引き継ぎ資料 / Handover pack',
  layout: 'page',
  parts: {
    greeting:
      '前任者のタスク一覧・やり取り・手順書から、進行中の案件・定例業務・窓口・確認事項をまとめた引き継ぎ資料を Word で作ります。人の評価はしません。書き出す前に承認をお願いします。 / From the task list, threads and procedures of the person handing over, I draft a handover pack as a Word document: cases in progress, routine work, contacts and open points. I never assess anyone, and I ask for your approval before writing it.',
    suggestedPrompts: [
      '購買担当の引き継ぎの依頼メモに沿って、引き継ぎ資料を作成して',
      'Draft the handover pack for the purchasing role as the request asks',
      '購買担当の引き継ぎ資料の構成だけを示して',
      'Show only the outline of the handover pack for the purchasing role',
    ],
    disclaimer: '下書きです。内容は担当者が確認します。 / A draft: a person checks it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
