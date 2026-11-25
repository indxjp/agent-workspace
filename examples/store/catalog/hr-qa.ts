import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'hr-qa',
  area: 'hr',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/hr-qa',
  name: {
    ja: '人事Q&A',
    en: 'HR helpdesk',
  },
  summary: {
    ja: '休暇や社会保険などの質問に、規程を引用して答える。',
    en: 'Answers leave and insurance questions, quoting the rules.',
  },
  demo: {
    agent: 'hr-qa',
    prompts: [
      {
        ja: '子どもが生まれたら、育児休業はいつまで取れますか？',
        en: 'How long can I take childcare leave after my child is born?',
      },
      {
        ja: '家族を健康保険の扶養に入れるには何が必要ですか？',
        en: 'What do I need to add a family member to my health insurance?',
      },
    ],
    moment: {
      ja: '人事の決まりについて質問すると、規程名と条番号の出典がついた回答が返り、個別のケースは人事部の判断に回る。',
      en: 'Ask about an HR rule; the answer cites the rule and article, and a person’s own case is left to the HR Department.',
    },
    data: {
      ja: '架空の休暇規程・育児介護休業規程・社会保険と福利厚生の手引き・人事部のお知らせ',
      en: 'fictional leave rules, childcare and family care leave rules, a social insurance and benefits guide and HR notices',
    },
    seed: [{ collection: 'hr-qa', from: 'data' }],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['person', 'files'],
});
