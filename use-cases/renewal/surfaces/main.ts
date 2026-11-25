import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'renewal',
  title: '契約更新リマインド / Renewal reminder',
  layout: 'side',
  parts: {
    greeting:
      '満了の近い契約を拾い、担当者ごとに更新案内メールの下書きを用意します。メールは送らず、保存の前に承認をお願いします。 / I find the contracts nearing their end and draft each renewal email. I send nothing, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 時点の契約更新リマインドを作成して',
      'Write the renewal reminder as of 2026-11-24',
      '30日以内に満了する契約に絞って、2026-11-24 時点の契約更新リマインドを作成して',
      'Write the renewal reminder as of 2026-11-24 for contracts ending within 30 days only',
    ],
  },
});
