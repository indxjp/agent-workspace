import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'hr-qa',
  title: '人事Q&A / HR helpdesk',
  layout: 'side',
  parts: {
    greeting:
      '休暇・育児介護・社会保険の規程について質問してください。条文を示して答えます。Ask about leave, childcare and insurance rules: every answer cites the article.',
    suggestedPrompts: [
      '子どもが生まれたら、育児休業はいつまで取れますか？',
      'How long can I take childcare leave after my child is born?',
      '家族を健康保険の扶養に入れるには何が必要ですか？',
      'What do I need to add a family member to my health insurance?',
    ],
    disclaimer:
      '回答は人事規程の記載だけに基づきます。個別のケースは人事部が判断します。Answers come only from the HR rules; the HR Department decides each case.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
