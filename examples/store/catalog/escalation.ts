import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'escalation',
  area: 'support',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'エスカレーション判定',
    en: 'Escalation triage',
  },
  summary: {
    ja: '重大度を判定し、必要なときだけ上長と技術チームにつなぐ。',
    en: 'Rates severity and pulls in managers and engineers only when needed.',
  },
});
