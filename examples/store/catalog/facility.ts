import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'facility',
  area: 'hr',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/facility',
  name: {
    ja: '設備予約',
    en: 'Facility booking',
  },
  summary: {
    ja: '会議室や社用車の予約を会話で受け付け、決まりと空きを確かめて承認のあとに登録する。',
    en: 'Books rooms and pool cars in chat, checking the rules and what is free, once approved.',
  },
  demo: {
    agent: 'facility',
    prompts: [
      {
        ja: '12月3日の14時から15時まで、取引先との打ち合わせで8人使える会議室を予約して。予約者は営業部の鵜飼 澪です',
        en: 'Book a meeting room for 8 people on December 3 from 14:00 to 15:00 for a client meeting, for Mio Ukai in Sales',
      },
      {
        ja: '12月4日の9時から17時まで、設備課の蓮見 朔さんの名前で社用車を予約して。2人で顧客先へ機器を搬入します',
        en: 'Book a pool car on December 4 from 9:00 to 17:00 for Saku Hasumi in Facilities: two of us are delivering equipment to a customer',
      },
    ],
    moment: {
      ja: '日時と人数を伝えると、定員・重なり・運転許可を確かめて設備を案にし、承認を待って予約する。',
      en: 'Give the time and head count; it checks capacity, overlaps and driving permits, proposes a resource and books it only after a person approves.',
    },
    data: {
      ja: '架空の設備予約の決まり、設備の一覧、予約システムの書き出し、運転許可者の名簿',
      en: 'Fictional booking rules, a resource list, a booking system export and a driver list',
    },
    seed: [{ collection: 'facility', from: 'data' }],
    check: { tools: ['search_files'], approval: 'book_resource' },
  },
  safety: ['approval', 'structured', 'files'],
});
