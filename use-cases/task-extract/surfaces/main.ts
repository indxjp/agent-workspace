import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'task-extract',
  title: 'タスク抽出 / Task extractor',
  layout: 'side',
  parts: {
    greeting:
      'メッセージの番号を教えてください。頼まれごとを拾って、担当者と期限を付けたタスクにします。 / Give me a message number: I pick out its requests and file them as a task with an assignee and a due date.',
    suggestedPrompts: [
      'メッセージ MSG-0601 から頼まれごとを拾って、タスクに登録してください',
      'Pick the requests out of message MSG-0601 and file them as a task',
      'メール MSG-0602 の頼まれごとをタスクにしてください',
      'Turn the requests in email MSG-0602 into a task',
    ],
    disclaimer:
      'タスクは承認のあとに登録します。メッセージへの返信はしません。 / The task is registered only after a person approves. No reply is sent.',
  },
});
