import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'incident',
  area: 'it',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/incident',
  name: {
    ja: '障害一次対応',
    en: 'Incident triage',
  },
  summary: {
    ja: 'アラートの重要度と影響範囲を見立て、当番の担当者と手順書の初動を示して振り分ける。',
    en: "Sizes an alert's severity and impact, and routes it to the on-call owner with the runbook's first steps.",
  },
  demo: {
    agent: 'incident',
    prompts: [
      {
        ja: 'アラート ALT-0042 を一次対応してください',
        en: 'Triage alert ALT-0042 and pick the on-call owner',
      },
      {
        ja: 'アラート ALT-0044 を一次対応して、当番の担当者を選んでください',
        en: 'Triage alert ALT-0044 and pick the on-call owner',
      },
    ],
    moment: {
      ja: 'アラートを渡すと、重要度と担当者が決まり、振り分けタスクの登録は承認を待つ。',
      en: 'Hand over an alert; it sets the severity and owner, and the routing task waits for approval.',
    },
    data: {
      ja: '監視アラート4件・サービス一覧・当番表・手順書',
      en: '4 monitoring alerts, service list, on-call roster, runbooks',
    },
    seed: [{ collection: 'incident', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
