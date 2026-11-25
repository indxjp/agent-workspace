import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'reg-watch',
  title: '法改正ウォッチ / Regulation watch',
  layout: 'side',
  parts: {
    greeting:
      '毎週、ウォッチ対象の法令やガイドラインの改正を公開情報から拾い、確認する部署と一緒に一覧にします。法的な助言はしません。判断は法務部・弁護士が行います。保存の前に承認をお願いします。 / Each week, I list the amended laws and guidelines on your watch list from public notices, with the department that checks each one, I give no legal advice; your legal team decides. I ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-23 時点の法改正ウォッチレポートを作成して',
      'Write the regulation watch report as of 2026-11-23',
      '労働時間の管理に絞って、2026-11-23 時点の法改正ウォッチレポートを作成して',
      'Write the regulation watch report as of 2026-11-23 for working-hours management only',
    ],
  },
});
