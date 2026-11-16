import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'task-extract',
  area: 'collab',
  status: 'soon',
  wave: 3,
  name: {
    ja: 'タスク抽出',
    en: 'Task extractor',
  },
  summary: {
    ja: 'メールやチャットから頼まれごとを拾い、タスクに登録する。',
    en: 'Picks requests out of email and chat and files them as tasks.',
  },
});
