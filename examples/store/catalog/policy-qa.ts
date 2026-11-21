import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'policy-qa',
  area: 'knowledge',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/policy-qa',
  name: {
    ja: '社内規程Q&A',
    en: 'Policy Q&A',
  },
  summary: {
    ja: '就業規則や経費規程について、条文番号付きで答える。',
    en: 'Answers questions on work and expense rules, citing the article.',
  },
  demo: {
    agent: 'policy-qa',
    prompts: [
      {
        ja: '国内出張の宿泊費の上限はいくら？',
        en: 'What is the limit on hotel costs for a domestic business trip?',
      },
      {
        ja: '在宅勤務は週に何日までできますか？',
        en: 'How many days a week can I work from home?',
      },
    ],
    moment: {
      ja: '規程について質問すると、結論と、規程名と条番号の出典がついた回答が返る。',
      en: 'Ask about a policy; the answer gives the conclusion and cites the policy and article.',
    },
    data: {
      ja: '就業規則・旅費経費精算規程・IT利用規程・社内掲示板のサンプル',
      en: 'sample work rules, travel and expense rules, IT use rules and notice board',
    },
    seed: [{ collection: 'policy-qa', from: 'data' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['person', 'files'],
});
