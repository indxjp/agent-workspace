import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'qa',
  agent: 'quality-defect',
  title: '不具合解析（過去トラ・8D）',
  layout: 'page',
  parts: {
    greeting:
      '新しい不具合の現象・品番・ロット・工程・発生数を入力してください。類似の過去トラを根拠に 8D の下書きを作ります。',
    suggestedPrompts: [
      '現象: バリ／品番: BRK-2201／ロット: L260928-2／工程: プレス／発生数: 48',
      '現象: 塗装ムラ／品番: CVR-5120／ロット: L260930-1／工程: 塗装／発生数: 120',
    ],
    disclaimer:
      'AI が作る下書きです。DR（デザインレビュー）で有識者が確認するまで、原因・対策を確定しないでください。',
    toolTrace: 'full',
    feedback: true,
  },
});
