import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'crm-sales',
  area: 'sales',
  status: 'live',
  wave: 1,
  kind: 'app',
  source: 'examples/crm',
  name: {
    ja: '営業アシスタント付きCRM',
    en: 'CRM with sales assistant',
  },
  summary: {
    ja: '会社・担当者・商談を管理。新しい連絡先が入ると、エージェントが会社名を補って会社とひも付ける。',
    en: 'Companies, contacts and deals. When a contact is added, the agent fills in the company and links them.',
  },
  demo: {
    agent: 'sales-assistant',
    prompts: [
      {
        ja: '佐藤さん（sato@aoba-seiki.example）の会社をメールのドメインから探して、連絡先にひも付けて',
        en: "Find Sato's (sato@aoba-seiki.example) company from the email domain and link it to the contact.",
      },
      {
        ja: '進行中の商談を段階ごとに数えて、金額の大きい順に3件教えて',
        en: 'Count the open deals by stage and give me the three largest by amount.',
      },
    ],
    moment: {
      ja: '連絡先のメールを渡すと、ドメインから会社を探して連絡先にひも付ける。',
      en: "Give a contact's email; the agent finds the company by its domain and links it to the contact.",
    },
    data: {
      ja: '架空の会社8社・担当者16名・商談10件',
      en: '8 fictional companies, 16 contacts, 10 deals',
    },
    seed: [],
    records: 'tests/sample-data',
    check: { tools: ['company_search', 'contact_update'], approval: null },
  },
  safety: ['person', 'structured'],
});
