import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'interview',
  title: '面接記録の作成 / Interview summary',
  layout: 'page',
  parts: {
    greeting:
      '面接官のメモと求人票から、要件ごとに面接で聞けたことをまとめた面接記録を Word で作ります。評価や合否の判断はしません。書き出す前に承認をお願いします。 / From the interviewer’s notes and the job description, I draft an interview summary as a Word document, setting out what the interview recorded for each requirement. I never rate or decide; I ask for your approval before writing it.',
    suggestedPrompts: [
      '鶫野ひかるさんの一次面接メモから面接記録を作成して',
      'Draft the interview summary for Hikaru Tsugumino from the first interview notes',
      '鶫野ひかるさんの面接記録の構成だけを示して',
    ],
    disclaimer:
      '下書きです。評価と合否は面接官と採用担当が決めます。 / A draft: the interviewer and the hiring team make every rating and decision.',
    toolTrace: 'collapsed',
    history: true,
  },
});
