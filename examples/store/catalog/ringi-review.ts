import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'ringi-review',
  area: 'finance',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/ringi-review',
  name: {
    ja: '稟議レビュー',
    en: 'Ringi review agent',
  },
  summary: {
    ja: '稟議書を規程と過去の決裁に照らし、不足や論点を指摘してから回付する。',
    en: 'Checks a ringi against the rules and past decisions, flags gaps, then circulates it.',
  },
  demo: {
    agent: 'ringi-review',
    prompts: [
      {
        ja: 'この稟議を点検して（設備投資 4,500万円、見積1社、期待効果が未記載）',
        en: 'Please review this ringi (capital investment, ¥45M, one quote, expected benefit not stated)',
      },
      {
        ja: '稟議ID R-2026-0115 rev.1 / 件名: 県議会議員後援会への協賛金 / 区分: 寄付 / 金額（税抜）: 100,000円 / 起案部門: 営業本部 法人営業部 / 起案者: 佐藤 美咲 / 目的: 地域との関係強化 / 期待効果: 地域での認知向上 / 支払条件: 一括 / 実施予定日: 2026-11-10 / 予算: 予算内',
        en: "Ringi ID R-2026-0115 rev.1 / Subject: Sponsorship for a prefectural assembly member's support group / Category: donation / Amount (ex tax): 100,000 yen / Department: Sales HQ, Corporate Sales Dept. / Drafter: Misaki Sato / Purpose: strengthen local ties / Expected benefit: local awareness / Payment terms: lump sum / Planned date: 2026-11-10 / Budget: within budget",
      },
    ],
    moment: {
      ja: '稟議を回す前に、決裁ルートの誤りと添付漏れを指摘する。',
      en: 'Before circulating, it catches the wrong approval route and a missing attachment.',
    },
    data: {
      ja: '決裁規程3本・過去の稟議10ファイル',
      en: '3 rule documents, 10 files of past ringi',
    },
    seed: [
      { collection: 'rules', from: 'data/rules' },
      { collection: 'ringi', from: 'data/ringi' },
    ],
    check: { tools: ['check_authority', 'search_files'], approval: null },
  },
  safety: ['person', 'approval', 'structured'],
});
