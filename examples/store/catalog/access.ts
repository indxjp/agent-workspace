import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'access',
  area: 'it',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'アカウント申請',
    en: 'Access requests',
  },
  summary: {
    ja: '権限の申請を受け付け、承認後に設定作業を依頼する。',
    en: 'Takes access requests and, once approved, asks for the change.',
  },
});
