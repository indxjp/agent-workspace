import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'ad-compliance',
  area: 'legal',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/ad-compliance',
  name: {
    ja: '広告表現チェック',
    en: 'Ad compliance',
  },
  summary: {
    ja: '広告の原稿を自社の広告表示基準と表現ごとに照らし、判定と修正案を示す。',
    en: 'Checks ad copy claim by claim against your in-house advertising standard, with a suggested fix.',
  },
  demo: {
    agent: 'ad-compliance',
    prompts: [
      {
        ja: 'ad-compliance/inbox/LP原稿_加湿空気清浄機KAZE-9.md をチェックして',
        en: 'Check ad-compliance/inbox/LP原稿_加湿空気清浄機KAZE-9.md',
      },
      {
        ja: 'AD-03 の通常価格の基準を説明して',
        en: 'Explain the AD-03 standard for regular prices.',
      },
    ],
    moment: {
      ja: '広告の原稿を指定すると、表現ごとに「OK・要注意・NG」と修正案が並び、保存は承認を待つ。',
      en: 'Name an ad draft; each claim is marked OK, caution or NG with a fix, and saving waits for approval.',
    },
    data: {
      ja: '架空の商品ページとSNS投稿の原稿・日付つきの自社広告表示基準',
      en: 'fictional product-page and social-post drafts, a dated in-house advertising standard',
    },
    seed: [{ collection: 'ad-compliance', from: 'data/ja' }],
    check: { tools: ['Read'], approval: 'Write' },
  },
  safety: ['approval', 'files', 'structured'],
});
