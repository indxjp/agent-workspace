import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: '__slug__',
  title: '依頼の登録 / Action',
  layout: 'side',
  parts: {
    greeting: '依頼の内容を教えてください。案を示してから登録します。 / Tell me what you need.',
    suggestedPrompts: [
      '依頼の内容をタスクにして登録して',
      'Turn the request into tasks',
      '依頼のうち急ぎのものだけをタスクにして登録して',
      'Turn only the urgent items of the request into tasks',
    ],
    disclaimer: '登録は一件ずつ承認のあとです。 / Each change waits for a person’s approval.',
    toolTrace: 'collapsed',
  },
});
