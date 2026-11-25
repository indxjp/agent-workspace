import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'case-file',
  title: '紛争資料の整理 / Case file organizer',
  layout: 'page',
  parts: {
    greeting:
      '案件のメールと契約・記録を時系列に並べ、論点ごとに整理した資料を、出典付きで Word で作ります。どちらが正しいかや、人の評価はしません。書き出す前に承認をお願いします。 / I put a matter’s emails, contract and records in date order and group them by issue, each with its source, as a Word document. I never say who is right or judge anyone, and I ask for your approval before writing it.',
    suggestedPrompts: [
      'M-2026-08 の依頼メモに沿って、メールと文書を整理して',
      'Organize the emails and documents of matter M-2026-08 as the request asks',
      'M-2026-08 の資料整理の構成だけを示して',
      'Show only the outline of the case file for M-2026-08',
    ],
    disclaimer:
      '下書きで、法的助言ではありません。判断は法務部と弁護士が行います。 / A draft, not legal advice: Legal and counsel decide.',
    toolTrace: 'collapsed',
    history: true,
  },
});
