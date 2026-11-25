import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'collections',
  title: '売掛金回収 / Collections assistant',
  layout: 'side',
  parts: {
    greeting:
      '入金の遅れている請求を拾い、遅れに応じた督促メールの下書きを用意します。メールは送らず、保存の前に承認をお願いします。 / I find the late invoices and draft a reminder that fits how late each is. I send nothing, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 時点の督促リストを作成して',
      'Write the collections list as of 2026-11-24',
      '株式会社シラサギ工業の未入金に絞って、2026-11-24 時点の督促リストを作成して',
      'Write the collections list as of 2026-11-24 for Shirasagi Industries only',
    ],
  },
});
