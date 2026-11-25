import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'scheduling',
  title: '日程調整 / Scheduling assistant',
  layout: 'side',
  parts: {
    greeting:
      '出席者、期間、会議の件名を教えてください。全員の空いている枠を候補にして、承認のあとに社内カレンダーに入れます。 / Tell me the attendees, the period and the title: I find slots in which everyone is free and put the meeting on the company calendar after a person approves.',
    suggestedPrompts: [
      '鷺坂 透、木枯 柊、榎戸 菫の3人で、12月7日の週に1時間の設計レビューを入れて',
      'Schedule a one-hour design review for Toru Sagisaka, Shu Kogarashi and Sumire Enokido in the week of December 7',
      '鳰川 楓さんと榎戸 菫さんで、12月10日か11日に1時間の顧客提案の準備会を入れて',
      'Schedule a one-hour prep meeting for a customer proposal with Kaede Niokawa and Sumire Enokido on December 10 or 11',
    ],
    disclaimer:
      '予定は承認のあとに社内カレンダーに入れます。招待のメールは送りません。 / The meeting goes on the company calendar only after a person approves it. No invitation email is sent.',
    toolTrace: 'collapsed',
  },
});
