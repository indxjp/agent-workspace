import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'facility',
  title: '設備予約 / Facility booking',
  layout: 'side',
  parts: {
    greeting:
      '使う設備、日時、人数、予約者、用途を教えてください。決まりと空きを確かめて案を示し、承認のあとに予約します。 / Tell me the resource, date and time, head count, who it is for and why: I check the rules and what is free, propose a booking and make it after a person approves.',
    suggestedPrompts: [
      '12月3日の14時から15時まで、取引先との打ち合わせで8人使える会議室を予約して。予約者は営業部の鵜飼 澪です',
      'Book a meeting room for 8 people on December 3 from 14:00 to 15:00 for a client meeting, for Mio Ukai in Sales',
      '12月4日の9時から17時まで、設備課の蓮見 朔さんの名前で社用車を予約して。2人で顧客先へ機器を搬入します',
      'Book a pool car on December 4 from 9:00 to 17:00 for Saku Hasumi in Facilities: two of us are delivering equipment to a customer',
    ],
    disclaimer:
      '予約は一件ずつ承認のあとに登録します。既存の予約の変更や取り消しはしません。 / Each booking is made only after a person approves it. It never changes or cancels an existing booking.',
    toolTrace: 'collapsed',
  },
});
