import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'budget',
  area: 'finance',
  status: 'live',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/budget',
  name: {
    ja: '予実差異分析',
    en: 'Budget variance',
  },
  summary: {
    ja: '予算と実績の差を部門・勘定科目ごとに計算し、コメント案を作る。',
    en: 'Computes budget-versus-actual gaps by department and account, and drafts commentary.',
  },
  demo: {
    agent: 'budget',
    prompts: [
      {
        ja: '予実_2026年度上期_部門別.csv で2026年9月の予実差異を分析して',
        en: 'Analyse the September 2026 budget variance in budget-actual-FY2026-H1-by-department.csv',
      },
      {
        ja: '予実_2026年度上期_部門別.csv で、2026年9月に予算から15%以上ずれた行だけを挙げて',
        en: 'In budget-actual-FY2026-H1-by-department.csv, list only the September 2026 lines 15% or more off budget',
      },
    ],
    moment: {
      ja: '予実のCSVからスクリプトが差異・差異率・累計を計算し、基準を超えた行と部門別のグラフが計算どおりの数値で示される。',
      en: 'A script computes variance, variance % and year to date from the budget CSV, and the lines over the threshold and a chart by department show exactly its numbers.',
    },
    data: {
      ja: '4部門の部門経費の予実（2026年度上期、月次）のCSVと、備考付きの差替CSV',
      en: 'A monthly budget-and-actual CSV of four departments’ expenses (first half of FY2026), and a resubmitted CSV with notes',
    },
    seed: [{ collection: 'budget', from: 'data' }],
    check: { tools: ['run_skill_script'], approval: null },
    // The suggested eval case's schema (evals/budget.yaml); the surface charts departments and trend.
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'month',
        'from',
        'threshold',
        'total',
        'ytd',
        'departments',
        'trend',
        'flagged',
        'commentary',
      ],
      properties: {
        month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        from: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        threshold: { type: 'number' },
        total: { $ref: '#/$defs/figures' },
        ytd: { $ref: '#/$defs/figures' },
        departments: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['department', 'budget', 'actual', 'variance', 'variancePct'],
            properties: {
              department: { type: 'string' },
              budget: { type: 'integer' },
              actual: { type: 'integer' },
              variance: { type: 'integer' },
              variancePct: { type: ['number', 'null'] },
            },
          },
        },
        trend: {
          type: 'array',
          maxItems: 60,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['month', 'budget', 'actual', 'variance', 'variancePct'],
            properties: {
              month: { type: 'string' },
              budget: { type: 'integer' },
              actual: { type: 'integer' },
              variance: { type: 'integer' },
              variancePct: { type: ['number', 'null'] },
            },
          },
        },
        flagged: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'department',
              'account',
              'budget',
              'actual',
              'variance',
              'variancePct',
              'ytd',
              'flagged',
            ],
            properties: {
              department: { type: 'string' },
              account: { type: 'string' },
              budget: { type: 'integer' },
              actual: { type: 'integer' },
              variance: { type: 'integer' },
              variancePct: { type: ['number', 'null'] },
              ytd: { $ref: '#/$defs/figures' },
              flagged: { type: 'boolean' },
            },
          },
        },
        commentary: { type: 'string' },
      },
      $defs: {
        figures: {
          type: 'object',
          additionalProperties: false,
          required: ['budget', 'actual', 'variance', 'variancePct'],
          properties: {
            budget: { type: 'integer' },
            actual: { type: 'integer' },
            variance: { type: 'integer' },
            variancePct: { type: ['number', 'null'] },
          },
        },
      },
    },
  },
  safety: ['person', 'files', 'structured'],
});
