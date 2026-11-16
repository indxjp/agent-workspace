import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'contract-review',
  area: 'legal',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/contract-review',
  name: {
    ja: '契約書レビュー',
    en: 'Contract review agent',
  },
  summary: {
    ja: '自社の審査基準と照らし、条項ごとのリスクと修正案を示す。',
    en: 'Checks each clause against your standards and suggests fixes.',
  },
  demo: {
    agent: 'contract-review',
    prompts: [
      {
        ja: 'contracts/営業一部/業務委託契約書_株式会社ミナトシステムズ案.docx をレビューしてください。',
        en: 'Review contracts/営業一部/業務委託契約書_株式会社ミナトシステムズ案.docx.',
      },
      {
        ja: 'PB-04 の審査基準を説明して。',
        en: 'Explain the PB-04 review standard.',
      },
    ],
    moment: {
      ja: '契約書をアップすると、条項ごとに「OK・要注意・NG」と修正案が並ぶ。',
      en: 'Upload a contract; each clause is marked OK, caution or no, with a suggested fix.',
    },
    data: {
      ja: '業務委託契約のサンプル・自社の審査基準',
      en: 'sample service agreement, review standards',
    },
    seed: [
      { collection: 'contracts', from: 'data/contracts' },
      { collection: 'playbook', from: 'data/playbook' },
      { collection: 'drafts', from: 'data/drafts' },
    ],
    check: { tools: ['run_skill_script'], approval: 'Write' },
  },
  safety: ['person', 'files', 'structured'],
});
