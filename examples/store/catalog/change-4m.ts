import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'change-4m',
  area: 'mfg',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/change-4m',
  name: {
    ja: '4M変更管理',
    en: '4M change tracker',
  },
  summary: {
    ja: '人・機械・材料・方法の変更申請を確認し、影響範囲を洗い出す。',
    en: 'Reviews man, machine, material and method changes and maps the impact.',
  },
  demo: {
    agent: 'change-4m',
    prompts: [
      {
        ja: 'change-4m/inbox/変更申請_CR-2611-05_材料変更.md を4M変更管理規程に照らしてチェックして',
        en: 'Check change-4m/inbox/変更申請_CR-2611-05_材料変更.md against the 4M change rules',
      },
      {
        ja: 'change-4m/inbox/変更申請_CR-2611-05_材料変更.md の影響範囲を部品使用先一覧と照らして、CHG-02 だけ確かめて',
        en: 'Check only CHG-02 for change-4m/inbox/変更申請_CR-2611-05_材料変更.md against the parts usage list',
      },
    ],
    moment: {
      ja: '変更申請を渡すと、影響する品番と顧客への届け出の要否が洗い出され、規程ごとの判定が並び、チェック結果の保存は承認を待つ。',
      en: 'Hand over a change request; the affected products and customer notices are mapped, each rule gets a verdict, and saving waits for approval.',
    },
    data: {
      ja: '架空の4M変更申請・部品使用先一覧・4M変更管理規程',
      en: 'fictional 4M change requests, a parts usage list and change control rules',
    },
    seed: [{ collection: 'change-4m', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
