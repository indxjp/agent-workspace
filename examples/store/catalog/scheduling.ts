import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'scheduling',
  area: 'collab',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/scheduling',
  name: {
    ja: '日程調整',
    en: 'Scheduling assistant',
  },
  summary: {
    ja: '参加者の予定を見て候補日時を出し、承認のあとに社内カレンダーに予定を入れる。',
    en: 'Finds slots across calendars and puts the meeting on the company calendar once approved.',
  },
  demo: {
    agent: 'scheduling',
    prompts: [
      {
        ja: '鷺坂 透、木枯 柊、榎戸 菫の3人で、12月7日の週に1時間の設計レビューを入れて',
        en: 'Schedule a one-hour design review for Toru Sagisaka, Shu Kogarashi and Sumire Enokido in the week of December 7',
      },
      {
        ja: '鳰川 楓さんと榎戸 菫さんで、12月10日か11日に1時間の顧客提案の準備会を入れて',
        en: 'Schedule a one-hour prep meeting for a customer proposal with Kaede Niokawa and Sumire Enokido on December 10 or 11',
      },
    ],
    moment: {
      ja: '出席者と期間を伝えると、全員が空いている枠を候補にし、承認を待ってカレンダーに入れる。招待は送らない。',
      en: 'Name the attendees and the period; it finds slots in which everyone is free and puts the meeting on the calendar only after a person approves. No invitation is sent.',
    },
    data: {
      ja: '架空の会議の日程の決まり、社員名簿、予定表の空き状況の書き出し',
      en: 'Fictional meeting rules, a staff list and a free/busy export',
    },
    seed: [{ collection: 'scheduling', from: 'data' }],
    check: { tools: ['search_files'], approval: 'create_event' },
  },
  safety: ['approval', 'structured', 'files'],
});
