import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'task-extract',
  area: 'collab',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/task-extract',
  name: {
    ja: 'タスク抽出',
    en: 'Task extractor',
  },
  summary: {
    ja: 'メールやチャットから頼まれごとを拾い、タスクに登録する。',
    en: 'Picks requests out of email and chat and files them as tasks.',
  },
  demo: {
    agent: 'task-extract',
    prompts: [
      {
        ja: 'メッセージ MSG-0601 から頼まれごとを拾って、タスクに登録してください',
        en: 'Pick the requests out of message MSG-0601 and file them as a task',
      },
      {
        ja: 'メール MSG-0602 の頼まれごとをタスクにしてください',
        en: 'Turn the requests in email MSG-0602 into a task',
      },
    ],
    moment: {
      ja: 'メッセージを渡すと、頼まれごとと担当者、期限が決まり、タスクの登録は承認を待つ。',
      en: 'Hand over a message; it picks out the requests, the assignee and the due date, and the task waits for approval.',
    },
    data: {
      ja: '架空のチャットのメッセージとメール・チームのメンバー一覧',
      en: "Fictional chat messages and emails, and the team's member list",
    },
    seed: [{ collection: 'task-extract', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
