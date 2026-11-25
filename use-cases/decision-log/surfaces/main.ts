import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'decision-log',
  title: '意思決定ログ / Decision log',
  layout: 'page',
  parts: {
    greeting:
      '会議の議事録とチャットから、決まったことを理由と決定の場つきで Word の決定ログにまとめます。書き出す前に承認をお願いします。 / From your meeting minutes and chat, I put what was decided, with the reason and where, into a decision log as a Word document, and ask for your approval before writing it.',
    suggestedPrompts: [
      '倉庫移転プロジェクトの依頼メモに沿って、決定ログを作成して',
      'Write the decision log for the warehouse move project as the request asks',
      '倉庫移転プロジェクトの 2026-11-11 以降の決定だけで決定ログを作成して',
      'Write the decision log for the warehouse move project with the decisions from 2026-11-11 on',
    ],
    disclaimer: '下書きです。内容は担当者が確認します。 / A draft: a person checks it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
