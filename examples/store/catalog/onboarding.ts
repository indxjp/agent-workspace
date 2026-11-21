import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'onboarding',
  area: 'hr',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/onboarding',
  name: {
    ja: '入社手続き',
    en: 'Onboarding flow',
  },
  summary: {
    ja: '入社する人ごとに、チェックリストと規程から準備のタスクを各部署に登録する。',
    en: 'Turns the onboarding checklist and policies into tasks for each team, one new hire at a time.',
  },
  demo: {
    agent: 'onboarding',
    prompts: [
      {
        ja: '12月1日入社の鴫原 灯さんの入社準備のタスクを登録して',
        en: 'Set up the onboarding tasks for Akari Shigihara, who joins on December 1',
      },
      {
        ja: '12月8日入社の芦刈 湊斗さんの入社準備のタスクを登録して',
        en: 'Set up the onboarding tasks for Minato Ashikari, who joins on December 8',
      },
    ],
    moment: {
      ja: '入社する人の名前を伝えると、チェックリストと規程から準備のタスクを案にし、一件ずつ承認を待って登録する。',
      en: 'Name a new hire; it proposes the onboarding tasks from the checklist and policies, and creates each one only after a person approves it.',
    },
    data: {
      ja: '架空の人事データ、入社準備チェックリスト、アカウントと機器の規程、研修日程',
      en: 'Fictional HR records, an onboarding checklist, account and equipment policies and a training schedule',
    },
    seed: [{ collection: 'onboarding', from: 'data' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['approval', 'person', 'structured', 'files'],
});
