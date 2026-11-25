import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'reg-watch',
  area: 'legal',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/reg-watch',
  name: {
    ja: '法改正ウォッチ',
    en: 'Regulation watch',
  },
  summary: {
    ja: 'ウォッチ対象の法令やガイドラインの改正を公開情報から拾い、確認する部署を添えて一覧にする。',
    en: 'Picks up amendments to the laws and guidelines you watch from public notices and lists each with the department that checks it.',
  },
  demo: {
    agent: 'reg-watch',
    prompts: [
      {
        ja: '2026-11-23 時点の法改正ウォッチレポートを作成して',
        en: 'Write the regulation watch report as of 2026-11-23',
      },
      {
        ja: '労働時間の管理に絞って、2026-11-23 時点の法改正ウォッチレポートを作成して',
        en: 'Write the regulation watch report as of 2026-11-23 for working-hours management only',
      },
    ],
    moment: {
      ja: 'ウォッチ対象に当たるこれからの改正が、確認する部署と公開情報の時点つきで並び、保存は承認を待つ。',
      en: 'Upcoming changes on the watch list are listed with the department that checks each and the date of the public notices; the save waits for approval.',
    },
    data: {
      ja: '架空の官公庁の改正通知の日付つきスナップショットと、社内のウォッチ対象一覧',
      en: "a dated snapshot of fictional regulators' notices, and an internal watch list",
    },
    seed: [{ collection: 'reg-watch', from: 'data/ja' }],
    check: { tools: ['read_reg_notices'], approval: 'Write' },
  },
  safety: ['approval', 'trigger', 'structured', 'files'],
});
