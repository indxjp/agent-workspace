import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'tests',
  title: 'テスト作成 / Test writer',
  layout: 'page',
  parts: {
    greeting:
      '仕様書とテスト設計の決まりから、テストケースとテストコードの下書きを Word で作ります。書き出す前に承認をお願いします。 / From the spec and your test design rules, I draft the test cases and the test code as a Word file, and ask for your approval before writing it.',
    suggestedPrompts: [
      'ポイント付与の仕様書からテストケースとテストコードの下書きを作成して',
      'Draft the test cases and test code for the point award spec',
      'ポイント付与の仕様書から、エラーになる入力のテストケースだけでテスト設計書を作成して',
      'Draft a test design with only the error cases of the point award spec',
    ],
    disclaimer:
      '下書きです。テストは実行していません。担当者が見直して実行します。 / A draft: the tests have not been run. A developer reviews and runs them.',
    toolTrace: 'collapsed',
    history: true,
  },
});
