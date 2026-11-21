import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'policy-qa',
  title: '社内規程Q&A',
  layout: 'side',
  parts: {
    greeting:
      '就業規則・経費・IT利用の規程について質問してください。条文を示して答えます。Ask about the work, expense and IT rules: every answer cites the article.',
    suggestedPrompts: [
      '国内出張の宿泊費の上限はいくら？',
      'How many days a week can I work from home?',
      '経費精算の締め切りはいつ？',
      'What should I do if I lose my company laptop?',
    ],
    disclaimer:
      '回答は規程の記載だけに基づきます。判断に迷うときは人事総務部に確認してください。Answers come only from the policies; ask HR and General Affairs when in doubt.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
