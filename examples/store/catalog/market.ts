import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'market',
  area: 'analytics',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/market',
  name: {
    ja: '市場調査',
    en: 'Market research',
  },
  summary: {
    ja: '公開統計と業界団体の発表から、市場規模・シェア・動向の質問に出典と時点つきで答える。',
    en: 'Answers questions on market size, shares and trends from public statistics and industry releases, citing each source and date.',
  },
  demo: {
    agent: 'market',
    prompts: [
      {
        ja: '業務用配膳ロボットの2025年度の国内出荷台数は？',
        en: 'How many serving robots were shipped in Japan in FY2025?',
      },
      {
        ja: '配膳ロボットの主要メーカーとシェアを教えて',
        en: 'Who are the main makers of serving robots, and what are their shares?',
      },
    ],
    moment: {
      ja: '市場について質問すると、数字ごとに発表元と公表日の出典がつき、どの時点の公開情報かを示した回答が返る。',
      en: 'Ask about the market; every figure cites its publisher and release date, and the answer says the date the public sources stand as of.',
    },
    data: {
      ja: '架空の公開統計・業界団体の発表の日付つきスナップショットと、社内の調査メモ',
      en: 'a dated snapshot of fictional public statistics and industry releases, and an internal research memo',
    },
    seed: [{ collection: 'market', from: 'data/files' }],
    check: { tools: ['read_market_stats'], approval: null },
  },
  safety: ['structured', 'files'],
});
