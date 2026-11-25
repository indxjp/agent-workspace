import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'assets',
  area: 'it',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/assets',
  name: {
    ja: 'IT資産棚卸',
    en: 'Asset inventory',
  },
  summary: {
    ja: 'PCやライセンスの台帳と実態の差を洗い出す。',
    en: 'Finds gaps between the PC and licence register and reality.',
  },
  demo: {
    agent: 'assets',
    prompts: [
      {
        ja: 'IT資産台帳_2026年11月.csv と 端末検出結果_2026-11-20.csv を突き合わせて、台帳と実態の差を洗い出して',
        en: 'Compare asset-register-2026-11.csv with device-inventory-2026-11-20.csv and list the gaps',
      },
      {
        ja: 'IT資産台帳_2026年11月.csv と 端末検出結果_2026-11-20.csv で、ライセンスの過不足と60日以上接続のない端末を教えて',
        en: 'In asset-register-2026-11.csv and device-inventory-2026-11-20.csv, show the licence gaps and PCs not seen for over 60 days',
      },
    ],
    moment: {
      ja: '資産台帳と端末の検出結果のCSVをスクリプトがシリアル番号で突き合わせ、検出されない端末・台帳にない端末・廃棄済みなのに使われている端末・ライセンスの過不足が、計算どおりの数値と製品別のグラフで示される。',
      en: 'A script matches the asset register and the device inventory CSVs by serial number, and the PCs not detected, the unregistered devices, the disposed PCs still in use and the licence gaps show exactly its numbers with a chart by product.',
    },
    data: {
      ja: '架空の会社のIT資産台帳（PCとライセンス）と、端末管理ツールの検出結果のCSV',
      en: "A fictional company's IT asset register (PCs and licences) and a device-management inventory CSV",
    },
    seed: [
      {
        collection: 'assets',
        from: 'data',
      },
    ],
    check: {
      tools: ['run_skill_script'],
      approval: null,
    },
    // The suggested eval case's schema (evals/assets.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'asOf',
        'staleDays',
        'missing',
        'unregistered',
        'disposedDetected',
        'userMismatch',
        'stale',
        'licences',
        'commentary',
      ],
      properties: {
        asOf: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        staleDays: { type: 'integer' },
        missing: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'serial', 'product', 'user'],
            properties: {
              id: { type: 'string' },
              serial: { type: 'string' },
              product: { type: 'string' },
              user: { type: ['string', 'null'] },
            },
          },
        },
        unregistered: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['serial', 'host', 'user', 'lastSeen'],
            properties: {
              serial: { type: 'string' },
              host: { type: 'string' },
              user: { type: ['string', 'null'] },
              lastSeen: { type: 'string' },
            },
          },
        },
        disposedDetected: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'serial', 'host', 'lastSeen'],
            properties: {
              id: { type: 'string' },
              serial: { type: 'string' },
              host: { type: 'string' },
              lastSeen: { type: 'string' },
            },
          },
        },
        userMismatch: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'serial', 'registered', 'detected'],
            properties: {
              id: { type: 'string' },
              serial: { type: 'string' },
              registered: { type: ['string', 'null'] },
              detected: { type: ['string', 'null'] },
            },
          },
        },
        stale: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'serial', 'user', 'lastSeen', 'days'],
            properties: {
              id: { type: 'string' },
              serial: { type: 'string' },
              user: { type: ['string', 'null'] },
              lastSeen: { type: 'string' },
              days: { type: 'number' },
            },
          },
        },
        licences: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['product', 'owned', 'installed', 'gap'],
            properties: {
              product: { type: 'string' },
              owned: { type: 'integer' },
              installed: { type: 'integer' },
              gap: { type: 'integer' },
            },
          },
        },
        commentary: { type: 'string' },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
