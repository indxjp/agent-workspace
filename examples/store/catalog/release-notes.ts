import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'release-notes',
  area: 'it',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/release-notes',
  name: {
    ja: 'リリースノート作成',
    en: 'Release notes',
  },
  summary: {
    ja: 'マージ済みの PR 一覧から利用者向けのリリースノートを作る。',
    en: 'Turns the merged-PR list into user-facing release notes.',
  },
  demo: {
    agent: 'release-notes',
    prompts: [
      {
        ja: 'v3.8.0 のマージ済み PR 一覧からリリースノートを作成して',
        en: 'Draft the release notes for v3.8.0 from the merged PR export',
      },
      {
        ja: 'v3.8.0 のリリースノートの構成だけを示して',
        en: 'Show only the outline of the release notes for v3.8.0',
      },
    ],
    moment: {
      ja: 'PR 一覧を渡すと、種類ごとに PR 番号付きでまとめた構成が出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over the PR export; out comes an outline grouped by type with PR numbers, and the Word document waits for approval.',
    },
    data: {
      ja: '架空のマージ済み PR 一覧とリリースノートの書き方',
      en: 'a fictional merged-PR export and release notes style guide',
    },
    seed: [{ collection: 'release-notes', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
