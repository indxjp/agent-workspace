import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'sla-watch',
  title: 'SLA監視 / SLA watcher',
  layout: 'side',
  parts: {
    greeting:
      '毎朝、SLAの期限を過ぎたチケットと期限が迫るチケットを、担当者と次の一手つきで一覧にします。保存の前に承認をお願いします。 / Each morning, I list the tickets past or close to their SLA deadline, with the owner and the next step, and ask for your approval before saving.',
    suggestedPrompts: [
      '2026-11-24 のSLA監視レポートを作成して',
      'Write the SLA watch report for 2026-11-24',
      '汐見さんの担当チケットに絞って、2026-11-24 のSLA監視レポートを作成して',
      'Write the SLA watch report for 2026-11-24 for Daichi Shiomi’s tickets only',
    ],
  },
});
