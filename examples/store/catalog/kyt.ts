import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'kyt',
  area: 'mfg',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/kyt',
  name: {
    ja: '危険予知（KY）支援',
    en: 'Hazard prediction',
  },
  summary: {
    ja: '作業予定から、作業基準とヒヤリハット報告にある危険と対策だけを場面ごとに並べたKYシートの下書きを作る。危険のポイントと行動目標は班で決める。',
    en: 'Drafts a KY (hazard prediction) sheet for a task with the hazards and measures of each scene, taken only from your work standard and near-miss reports. The team picks the key hazards and its action goal.',
  },
  demo: {
    agent: 'kyt',
    prompts: [
      {
        ja: '11月25日の第2倉庫の棚入れの作業予定から、KY シートを作成して',
        en: 'Draft the KY sheet for the Warehouse 2 racking on 25 November from the work plan',
      },
      {
        ja: '第2倉庫の棚入れの KY シートの構成だけを示して',
        en: 'Show only the outline of the KY sheet for the Warehouse 2 racking',
      },
    ],
    moment: {
      ja: '作業予定を渡すと、場面ごとの危険と対策がヒヤリハット報告と作業基準の出典付きで出て、Word の書き出しが承認待ちになる。資料にない危険は足さない。',
      en: 'Hand over the work plan; out come the hazards and measures of each scene, each citing a near-miss report or the work standard, with no hazard the sources lack, and the Word document waits for approval.',
    },
    data: {
      ja: '架空の作業予定・フォークリフト作業基準・ヒヤリハット報告・KYシートの書き方',
      en: 'a fictional work plan, a forklift work standard, near-miss reports and a KY sheet guide',
    },
    seed: [{ collection: 'kyt', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
