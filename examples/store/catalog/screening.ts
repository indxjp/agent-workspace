import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'screening',
  area: 'legal',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/screening',
  name: {
    ja: '取引先チェック',
    en: 'Counterparty screening',
  },
  summary: {
    ja: '取引先の登録申請にある会社と人の名前を公開リストと照合し、一致の候補を担当者に示す。',
    en: 'Checks the companies and people in a counterparty request against public lists, and flags possible matches for a person.',
  },
  demo: {
    agent: 'screening',
    prompts: [
      {
        ja: 'screening/inbox/取引先登録申請_株式会社ミナセ精工.md を照合して',
        en: 'Screen screening/inbox/取引先登録申請_株式会社ミナセ精工.md',
      },
      {
        ja: 'Teodor Vashkin という名前は公開リストにありますか？',
        en: 'Is the name Teodor Vashkin on the public lists?',
      },
    ],
    moment: {
      ja: '登録申請書を渡すと、名前ごとの照合結果がリストの日付つきで並び、一致の候補は担当者の確認に回り、報告書の保存は承認を待つ。',
      en: 'Hand over a registration request; each name’s result appears with the date of the lists, possible matches go to a person, and the report waits for approval.',
    },
    data: {
      ja: '架空の取引先登録申請書2通・取引先確認手順・公開リストの日付つきスナップショット',
      en: '2 fictional registration requests, a screening procedure and a dated snapshot of public lists',
    },
    seed: [{ collection: 'screening', from: 'data/ja' }],
    check: { tools: ['check_public_lists'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
