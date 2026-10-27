import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'minutes',
  agent: 'meeting-minutes',
  title: '議事録作成',
  layout: 'page',
  parts: {
    greeting:
      '会議の文字起こし（Teams / Zoom）を貼り付けるか、transcripts/ のファイル名を指定してください。議事録の下書きとアクション項目を作ります。',
    suggestedPrompts: [
      'transcripts/2026-10-02_生産会議.txt の議事録の下書きを作成してください',
      'transcripts/2026-10-05_新製品開発定例.vtt の議事録の下書きを作成してください',
      '生産会議で登録済みのタスクを一覧にして',
    ],
    disclaimer:
      'ここで作るのは下書きです。タスクの登録は、承認画面で担当と期限を確認したあとに行われます。',
    toolTrace: 'collapsed',
    history: true,
    feedback: true,
  },
  // The tracker's tasks render as a table. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { list_tasks: 'table' },
});
