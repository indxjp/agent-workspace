import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'ir-qa',
  title: 'IR想定問答 / IR Q&A prep',
  layout: 'page',
  parts: {
    greeting:
      'IR担当のメモと開示済みの決算資料から、説明会の想定問答を Word で作ります。書き出す前に承認をお願いします。 / From the IR memo and the disclosed earnings materials, I draft the expected Q&A for the briefing as a Word document, and ask for your approval before writing it.',
    suggestedPrompts: [
      '第2四半期決算説明会の想定問答を作成して',
      'Draft the expected Q&A for the Q2 results briefing',
      '配当と株主還元についての想定問答だけを作成して',
      'Draft the expected Q&A on dividends and shareholder returns only',
    ],
    disclaimer:
      '下書きです。回答は開示済みの資料だけに基づき、投資の助言はしません。IR担当者が確認します。 / A draft from disclosed materials only, with no investment advice; the IR team checks it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
