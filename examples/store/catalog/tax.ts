import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'tax',
  area: 'finance',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/tax',
  name: {
    ja: '税務チェック',
    en: 'Tax check',
  },
  summary: {
    ja: '取引の消費税区分やインボイスの要件を確認する。',
    en: 'Checks consumption-tax categories and invoice requirements.',
  },
  demo: {
    agent: 'tax',
    prompts: [
      {
        ja: 'tax/inbox/請求書_カケス文具_KK-1187.md を社内の経理ルールに照らしてチェックして',
        en: 'Check tax/inbox/請求書_カケス文具_KK-1187.md against our accounting rules',
      },
      {
        ja: 'tax/inbox/請求書_カケス文具_KK-1187.md の仕訳の税区分コードが社内の表と合っているか、TAX-03 だけ確かめて',
        en: 'Check only TAX-03: do the entry tax codes for tax/inbox/請求書_カケス文具_KK-1187.md match our table?',
      },
    ],
    moment: {
      ja: '請求書を渡すと、登録番号・税率の記載・税区分コードなどが自社のルールごとに判定され、チェック結果の保存は承認を待つ。税務の助言はしない。',
      en: 'Hand over an invoice; registration number, tax rates and tax codes are judged by your own rules, saving waits for approval, and no tax advice is given.',
    },
    data: {
      ja: '架空の請求書・仕訳入力データ・経理規程の請求書ルール',
      en: 'fictional supplier invoices, accounting entries and invoice rules',
    },
    seed: [{ collection: 'tax', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
