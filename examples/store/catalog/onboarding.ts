import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'onboarding',
  area: 'hr',
  status: 'soon',
  wave: 2,
  name: {
    ja: '入社手続き',
    en: 'Onboarding flow',
  },
  summary: {
    ja: '入社日から逆算して手続きと準備物を各部署に依頼する。',
    en: 'Works back from the start date and asks each team for what is needed.',
  },
});
