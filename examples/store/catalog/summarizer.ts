import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'summarizer',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  name: {
    ja: '長文要約',
    en: 'Long-document summarizer',
  },
  summary: {
    ja: '100ページを超える資料を、決定事項・数字・リスクに分けて要約する。',
    en: 'Summarizes 100-page documents into decisions, figures and risks.',
  },
});
