import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'logs',
  area: 'it',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/logs',
  name: {
    ja: 'ログ分析',
    en: 'Log analyst',
  },
  summary: {
    ja: '大量のログから異常のパターンと発生時刻を特定する。',
    en: 'Finds anomaly patterns and timings in large logs.',
  },
  demo: {
    agent: 'logs',
    prompts: [
      {
        ja: 'アプリログ_2026-11-20.csv で、エラーが急増した時間帯と主なエラーのパターンを教えて',
        en: 'In app-log-2026-11-20.csv, when did the errors spike and what are the main error patterns?',
      },
      {
        ja: 'アプリログ_2026-11-20.csv で、auth-api の警告とエラーを5分ごとに見て',
        en: 'In app-log-2026-11-20.csv, show the auth-api warnings and errors in 5-minute buckets',
      },
    ],
    moment: {
      ja: 'ログのCSVからスクリプトが時間帯ごとのエラーと警告を数え、エラーが最も多い時間帯と、秘密情報や個人情報を伏せたエラーのパターンが、計算どおりの数値と時間帯別のグラフで示される。',
      en: 'A script counts the errors and warnings in each time bucket of the log CSV, and the busiest bucket and the error patterns, with secrets and personal data masked, show exactly its numbers with a chart by time.',
    },
    data: {
      ja: '架空の通販サイトの、サービス別のアプリケーションログ（日時・レベル・サービス・ホスト・メッセージ）のCSV',
      en: "An application log CSV of a fictional online shop's services (timestamp, level, service, host, message)",
    },
    seed: [
      {
        collection: 'logs',
        from: 'data',
      },
    ],
    check: {
      tools: ['run_skill_script'],
      approval: null,
    },
    // The suggested eval case's schema (evals/logs.yaml); the surface charts it.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'from',
        'to',
        'bucketMinutes',
        'peak',
        'buckets',
        'patterns',
        'otherPatterns',
        'redactions',
        'commentary',
      ],
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        bucketMinutes: { type: 'integer' },
        peak: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['start', 'errors'],
          properties: { start: { type: 'string' }, errors: { type: 'integer' } },
        },
        buckets: {
          type: 'array',
          maxItems: 1500,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['start', 'errors', 'warnings'],
            properties: {
              start: { type: 'string' },
              errors: { type: 'integer' },
              warnings: { type: 'integer' },
            },
          },
        },
        patterns: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['level', 'service', 'pattern', 'count', 'first', 'last'],
            properties: {
              level: { type: 'string' },
              service: { type: 'string' },
              pattern: { type: 'string' },
              count: { type: 'integer' },
              first: { type: 'string' },
              last: { type: 'string' },
            },
          },
        },
        otherPatterns: { type: 'integer' },
        redactions: { type: 'integer' },
        commentary: { type: 'string' },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
