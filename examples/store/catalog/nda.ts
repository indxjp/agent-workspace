import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'nda',
  area: 'legal',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/nda',
  name: {
    ja: 'NDAチェック',
    en: 'NDA checker',
  },
  summary: {
    ja: '受け取ったNDAを自社のひな形と比べ、違いを報告する。',
    en: 'Compares an incoming NDA with your template and reports the differences.',
  },
  demo: {
    agent: 'nda',
    prompts: [
      {
        ja: 'nda/inbox/秘密保持契約書_株式会社ツバメ技研案.md をレビューして',
        en: 'Review nda/inbox/秘密保持契約書_株式会社ツバメ技研案.md',
      },
      {
        ja: 'NDA-05 の有効期間の基準を説明して',
        en: 'Explain the NDA-05 standard on the term.',
      },
    ],
    moment: {
      ja: 'NDAを渡すと、基準の項目ごとに判定と修正案が並び、差分レポートの保存は承認を待つ。',
      en: 'Hand over an NDA; each item gets a verdict and a fix, and the report waits for approval.',
    },
    data: {
      ja: '受け取ったNDAのサンプル2通・自社のNDA審査基準',
      en: '2 sample incoming NDAs, NDA review standards',
    },
    seed: [{ collection: 'nda', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['person', 'approval', 'files'],
});
