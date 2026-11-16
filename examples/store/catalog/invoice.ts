import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'invoice',
  area: 'finance',
  status: 'soon',
  wave: 2,
  name: {
    ja: '請求書照合',
    en: 'Invoice matching',
  },
  summary: {
    ja: '請求書・発注書・検収を突き合わせ、差があるものだけを担当者に回す。',
    en: 'Matches invoices, orders and receipts and only routes the mismatches.',
  },
});
