import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: '__slug__',
  layout: 'side',
  parts: {
    greeting:
      '資料について質問してください。出典つきで答えます。Ask about the documents: every answer cites its source.',
    suggestedPrompts: ['資料の要点は？', 'What do the documents say?'],
    disclaimer: '回答は資料の記載だけに基づきます。Answers come only from the documents.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
