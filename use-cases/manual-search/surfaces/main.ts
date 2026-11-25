import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'manual-search',
  title: 'マニュアル検索',
  layout: 'side',
  parts: {
    greeting:
      '設備のマニュアルについて質問してください。マニュアル名・ページ・節を示して答えます。Ask about the equipment manuals: every answer names the manual, page and section.',
    suggestedPrompts: [
      '油圧ユニットの定期点検の周期は？',
      "How often is the hydraulic unit's periodic inspection due?",
      '作動油はいつ交換すればいいですか',
      'When should the hydraulic oil be replaced?',
    ],
    disclaimer:
      '回答はマニュアルの記載だけに基づきます。作業前に必ず原本を確認してください。Answers come only from the manuals; check the original before you work.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
