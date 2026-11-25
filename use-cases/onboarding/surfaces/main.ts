import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'onboarding',
  title: '入社手続き / Onboarding flow',
  layout: 'side',
  parts: {
    greeting:
      '入社する人の名前か社員番号を教えてください。準備のタスクを案にして、承認のあとに登録します。 / Name the new hire: I propose the onboarding tasks and create each one after a person approves.',
    suggestedPrompts: [
      '12月1日入社の鴫原 灯さんの入社準備のタスクを登録して',
      'Set up the onboarding tasks for Akari Shigihara, who joins on December 1',
      '12月8日入社の芦刈 湊斗さんの入社準備のタスクを登録して',
      'Set up the onboarding tasks for Minato Ashikari, who joins on December 8',
    ],
    disclaimer:
      'タスクは一件ずつ承認のあとに登録します。入社する人を評価しません。 / Each task is created only after a person approves it. It never assesses the person.',
    toolTrace: 'collapsed',
  },
});
