import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'account-requests',
  title: 'アカウント申請 / Access requests',
  layout: 'side',
  parts: {
    greeting:
      '誰に、どのシステムの、どの権限が必要かを教えてください。規程と役割を確かめて案を示し、承認のあとに登録します。 / Tell me who needs which access on which system: I check the policy and the role, propose the change and record it after a person approves.',
    suggestedPrompts: [
      '営業部の楪 奏多さんに顧客管理システムの書き込み権限を付けて',
      'Give Kanata Yuzuriha in Sales write access to the CRM',
      '経理部の箙 陽菜さんに経費精算システムの書き込み権限を付けて',
      'Give Hina Ebira in Accounting write access to the expense system',
    ],
    disclaimer:
      '権限の変更は一件ずつ承認のあとに登録します。規程にない権限は付けません。 / Each change is recorded only after a person approves it, and never beyond the policy.',
    toolTrace: 'collapsed',
  },
});
