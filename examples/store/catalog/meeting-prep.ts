import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'meeting-prep',
  area: 'sales',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/meeting-prep',
  name: {
    ja: '商談準備ブリーフ',
    en: 'Meeting prep brief',
  },
  summary: {
    ja: '商談の前に、取引先メモ・進行中の案件・最近のメールを1枚にまとめる。',
    en: 'Before a meeting, puts the account notes, open deals and recent emails on one page.',
  },
  demo: {
    agent: 'meeting-prep',
    prompts: [
      {
        ja: '2026-11-24 の商談の準備ブリーフを作成して',
        en: 'Prepare the briefs for the meetings on 2026-11-24',
      },
      {
        ja: '2026-11-25 のハルカゼ製作所との商談の準備ブリーフを作成して',
        en: 'Prepare the brief for the meeting with Harukaze Works on 2026-11-25',
      },
    ],
    moment: {
      ja: '日付を指定すると、その日の商談ごとに出典つきのブリーフができ、保存は承認を待つ。',
      en: 'Name a day; each of its meetings gets a sourced brief, and saving waits for approval.',
    },
    data: {
      ja: 'CRMから書き出した商談・取引先・案件・メールのCSV',
      en: 'CRM export of meetings, accounts, deals and emails as CSV',
    },
    seed: [{ collection: 'meeting-prep', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
