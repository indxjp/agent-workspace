import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'privacy',
  area: 'legal',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/privacy',
  name: {
    ja: '個人情報影響評価',
    en: 'Privacy impact',
  },
  summary: {
    ja: 'サービスの設計メモを社内のチェックリストと照らし、項目ごとの記載と確認事項をまとめた評価書の下書きを作る。法的な判断はしない。',
    en: "Drafts a privacy impact assessment from a service's design memo, item by item against your checklist, with the points to check. It gives no legal opinion.",
  },
  demo: {
    agent: 'privacy',
    prompts: [
      {
        ja: 'DS-12 の設計メモから個人情報影響評価を作成して',
        en: 'Draft the privacy impact assessment from the DS-12 design memo',
      },
      {
        ja: 'DS-12 の個人情報影響評価の構成だけを示して',
        en: 'Show only the outline of the privacy impact assessment for DS-12',
      },
    ],
    moment: {
      ja: '設計メモを渡すと、チェックリストの項目ごとの記載と確認事項の構成が出て、Word の書き出しが承認待ちになる。法的な判断は出さない。',
      en: 'Hand over the design memo; out comes an outline of each checklist item and the points to check, with no legal verdict, and the Word document waits for approval.',
    },
    data: {
      ja: '架空のサービス設計メモ・個人情報影響評価チェックリスト・プライバシーポリシーの抜粋',
      en: 'a fictional service design memo, an assessment checklist and a privacy policy excerpt',
    },
    seed: [{ collection: 'privacy', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
