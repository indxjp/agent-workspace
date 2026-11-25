import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'training',
  title: '研修計画 / Training planner',
  layout: 'page',
  parts: {
    greeting:
      'スキルマップと役割の目標、研修カタログ、1on1 のメモから、一人分の研修計画案を Word で作ります。人の評価や順位付けはしません。書き出す前に承認をお願いします。 / From the skills matrix, the role targets, the training catalog and the one-on-one notes, I draft one person’s training plan as a Word document. I never rate or rank anyone, and I ask for your approval before writing it.',
    suggestedPrompts: [
      '小雀ちひろさんの 1on1 メモから、2027年上期の研修計画案を作成して',
      "Draft Chihiro Kogara's 2027 H1 training plan from the one-on-one notes",
      '小雀ちひろさんの研修計画案の構成だけを示して',
      "Show only the outline of Chihiro Kogara's training plan",
    ],
    disclaimer:
      '下書きです。研修は上長と本人が相談して決め、課長が承認します。 / A draft: the manager and the person agree on the training, and the section head approves it.',
    toolTrace: 'collapsed',
    history: true,
  },
});
