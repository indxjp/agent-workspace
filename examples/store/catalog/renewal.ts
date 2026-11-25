import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'renewal',
  area: 'sales',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/renewal',
  name: {
    ja: '契約更新リマインド',
    en: 'Renewal reminder',
  },
  summary: {
    ja: '更新期限の近い契約を拾い、更新案内メールの下書きを用意する。',
    en: 'Finds contracts nearing renewal and drafts the renewal email.',
  },
  demo: {
    agent: 'renewal',
    prompts: [
      {
        ja: '2026-11-24 時点の契約更新リマインドを作成して',
        en: 'Write the renewal reminder as of 2026-11-24',
      },
      {
        ja: '30日以内に満了する契約に絞って、2026-11-24 時点の契約更新リマインドを作成して',
        en: 'Write the renewal reminder as of 2026-11-24 for contracts ending within 30 days only',
      },
    ],
    moment: {
      ja: '更新期限の近い契約が、満了日と担当者、更新案内メールの下書きつきで並び、保存は承認を待つ。メールは送らない。',
      en: 'Contracts nearing renewal are listed with the end date, the owner and a draft renewal email; the save waits for approval, and no email is sent.',
    },
    data: {
      ja: '架空の契約管理システムの契約一覧',
      en: 'a fictional contract management export',
    },
    seed: [{ collection: 'renewal', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
