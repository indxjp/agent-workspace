import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'sec-alert',
  area: 'it',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'セキュリティアラート分析',
    en: 'Security alert triage',
  },
  summary: {
    ja: '検知アラートを重要度順に並べ、調査メモを付ける。',
    en: 'Ranks security alerts and adds investigation notes.',
  },
});
