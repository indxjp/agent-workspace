import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'project-status',
  area: 'collab',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'プロジェクト週報',
    en: 'Project status',
  },
  summary: {
    ja: 'チケットとチャットから週報とリスクを作る。',
    en: 'Writes the weekly status and risks from tickets and chat.',
  },
});
