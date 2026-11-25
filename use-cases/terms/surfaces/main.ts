import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'terms',
  title: '利用規約の改定 / Terms updater',
  layout: 'page',
  parts: {
    greeting:
      '規約の改定メモと現行の規約から、新旧対照表と利用者へのお知らせ文の下書きを Word で作ります。法的な判断はしません。書き出す前に承認をお願いします。 / From a change memo and your current terms, I draft the before-and-after table and the notice to users as a Word document. I give no legal opinion, and I ask for your approval before writing it.',
    suggestedPrompts: [
      'TM-03 の改定メモから新旧対照表とお知らせ文を作成して',
      'Draft the before-and-after table and the notice from the TM-03 memo',
      'TM-03 の新旧対照表とお知らせ文の構成だけを示して。ファイルはまだ作らないで',
      'Show only the outline of the TM-03 table and notice; do not write a file yet',
    ],
    disclaimer:
      '下書きで、法的助言ではありません。改定の内容と告知の方法は法務部が判断します。 / A draft, not legal advice: Legal decides the change and how users are told.',
    toolTrace: 'collapsed',
    history: true,
  },
});
