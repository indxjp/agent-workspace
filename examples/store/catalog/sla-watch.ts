import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'sla-watch',
  area: 'support',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/sla-watch',
  name: {
    ja: 'SLA監視',
    en: 'SLA watcher',
  },
  summary: {
    ja: '期限を過ぎた、または迫るチケットを、担当者と次の一手つきで一覧にする。',
    en: 'Lists the tickets past or close to their SLA, with the owner and the next step.',
  },
  demo: {
    agent: 'sla-watch',
    prompts: [
      {
        ja: '2026-11-24 のSLA監視レポートを作成して',
        en: 'Write the SLA watch report for 2026-11-24',
      },
      {
        ja: '汐見さんの担当チケットに絞って、2026-11-24 のSLA監視レポートを作成して',
        en: 'Write the SLA watch report for 2026-11-24 for Daichi Shiomi’s tickets only',
      },
    ],
    moment: {
      ja: '期限超過と期限間近のチケットが、担当者と次の一手つきで並び、保存は承認を待つ。',
      en: 'Tickets past and close to their deadline are listed with the owner and a next step; the save waits for approval.',
    },
    data: {
      ja: '架空のヘルプデスクのチケット一覧',
      en: 'a fictional helpdesk ticket list',
    },
    seed: [{ collection: 'sla-watch', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
