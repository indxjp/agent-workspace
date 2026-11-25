import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'newcomer',
  area: 'knowledge',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/newcomer',
  name: {
    ja: '新人ガイド',
    en: 'New-joiner guide',
  },
  summary: {
    ja: '入社資料から新人の質問に答え、最初の1週間の案内を作る。',
    en: "Answers new joiners' questions from onboarding documents and drafts their first-week guide.",
  },
  demo: {
    agent: 'newcomer',
    prompts: [
      {
        ja: '柚木原さつきさんの初週ガイドを作成して',
        en: "Draft Satsuki Yugihara's first-week guide",
      },
      {
        ja: '在宅勤務はいつからできますか？',
        en: 'When can I start working from home?',
      },
    ],
    moment: {
      ja: '入社者情報を渡すと、入社資料の出典付きで初週ガイドの構成が出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over the joiner sheet; out comes a sourced first-week guide outline, and the Word file waits for approval.',
    },
    data: {
      ja: '架空の入社者情報シート・入社初日の流れ・PCとアカウント・勤怠・研修・部署紹介',
      en: 'a fictional joiner sheet, first-day plan, laptop and accounts, working hours, training and team pages',
    },
    seed: [{ collection: 'newcomer', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
