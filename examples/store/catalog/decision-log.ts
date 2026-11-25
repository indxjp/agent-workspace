import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'decision-log',
  area: 'collab',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/decision-log',
  name: {
    ja: '意思決定ログ',
    en: 'Decision log',
  },
  summary: {
    ja: '会議やチャットの決定事項を、理由と一緒に記録する。',
    en: 'Records decisions from meetings and chat, with the reasons.',
  },
  demo: {
    agent: 'decision-log',
    prompts: [
      {
        ja: '倉庫移転プロジェクトの依頼メモに沿って、決定ログを作成して',
        en: 'Write the decision log for the warehouse move project as the request asks',
      },
      {
        ja: '倉庫移転プロジェクトの 2026-11-11 以降の決定だけで決定ログを作成して',
        en: 'Write the decision log for the warehouse move project with the decisions from 2026-11-11 on',
      },
    ],
    moment: {
      ja: '議事録とチャットから、決定事項が日付・理由・決定の場・出典つきで並び、未決事項と分けた決定ログの Word の書き出しが承認待ちになる。',
      en: 'From the minutes and chat, the decisions are listed with the date, reason, where decided and source, apart from the open items, and the Word decision log waits for approval.',
    },
    data: {
      ja: '架空のプロジェクトの定例会議の議事録とチャットの書き出し',
      en: "a fictional project's weekly meeting minutes and chat export",
    },
    seed: [{ collection: 'decision-log', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['person', 'approval', 'files', 'structured'],
});
