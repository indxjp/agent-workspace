import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'incident',
  area: 'it',
  status: 'soon',
  wave: 2,
  name: {
    ja: '障害一次対応',
    en: 'Incident triage',
  },
  summary: {
    ja: 'アラートとログから影響範囲を見立て、手順書に沿って一次対応する。',
    en: 'Sizes the impact from alerts and logs and runs the first steps of the runbook.',
  },
});
