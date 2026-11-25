import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'tests',
  area: 'it',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/tests',
  name: {
    ja: 'テスト作成',
    en: 'Test writer',
  },
  summary: {
    ja: '仕様書からテストケースとテストコードの下書きを作る。',
    en: 'Drafts test cases and test code from a spec.',
  },
  demo: {
    agent: 'tests',
    prompts: [
      {
        ja: 'ポイント付与の仕様書からテストケースとテストコードの下書きを作成して',
        en: 'Draft the test cases and test code for the point award spec',
      },
      {
        ja: 'ポイント付与の仕様書から、エラーになる入力のテストケースだけでテスト設計書を作成して',
        en: 'Draft a test design with only the error cases of the point award spec',
      },
    ],
    moment: {
      ja: '仕様書を渡すと、計算例と不具合一覧から根拠付きのテストケースが出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over a spec; out come test cases sourced from its examples and the defect list, and the Word file waits for approval.',
    },
    data: {
      ja: '架空の機能の仕様書、テスト設計の決まり、関数の仕様、不具合一覧',
      en: 'A fictional feature spec, test design rules, a function reference and a defect list',
    },
    seed: [{ collection: 'tests', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
