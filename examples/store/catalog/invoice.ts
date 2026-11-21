import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'invoice',
  area: 'finance',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/invoice',
  name: {
    ja: '請求書照合',
    en: 'Invoice matching',
  },
  summary: {
    ja: '請求書を発注書・納品書と明細ごとに突き合わせ、差がある明細を示す。',
    en: 'Matches each invoice line with the order and delivery note and flags the lines that differ.',
  },
  demo: {
    agent: 'invoice',
    prompts: [
      {
        ja: 'invoice/inbox/請求書_ミサゴ工業_INV-M-24117.md を照合して',
        en: 'Match invoice/inbox/請求書_ミサゴ工業_INV-M-24117.md',
      },
      {
        ja: 'MATCH-03 の数量の照合ルールを説明して',
        en: 'Explain the MATCH-03 quantity rule.',
      },
    ],
    moment: {
      ja: '請求書を指定すると、発注書・納品書との差が明細ごとに「OK・要注意・NG」で並び、保存は承認を待つ。',
      en: 'Name an invoice; each line is marked OK, caution or NG against its order and delivery note, and saving waits for approval.',
    },
    data: {
      ja: '架空の請求書・発注書と納品書のCSV・照合ルール',
      en: 'fictional invoices, purchase order and delivery note CSVs, matching rules',
    },
    seed: [{ collection: 'invoice', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['approval', 'files', 'structured'],
});
