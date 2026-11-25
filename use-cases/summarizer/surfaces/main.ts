import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'summarizer',
  title: '長文要約 / Long-document summarizer',
  layout: 'page',
  parts: {
    greeting:
      '長い報告書と会議の議事録を読み、決定事項・主な数字・リスク・未決事項に分けた要約を、出典付きで Word で作ります。書き出す前に承認をお願いします。 / I read a long report and the meeting minutes, and draft a summary as a Word document in decisions, key figures, risks and open matters, each with its source. I ask for your approval before writing it.',
    suggestedPrompts: [
      '物流拠点再編の報告書を、依頼メモに沿って要約して',
      'Summarize the logistics site consolidation report as the request asks',
      '物流拠点再編の要約の構成だけを示して',
      'Show only the outline of the summary of the logistics site consolidation report',
    ],
    disclaimer:
      '下書きです。正式な内容は元の報告書です。共有の前に担当者が確認します。 / A draft: the full report is the authority, and a person checks the summary before it is shared.',
    toolTrace: 'collapsed',
    history: true,
  },
});
