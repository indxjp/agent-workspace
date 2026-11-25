import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'price-guard',
  title: '価格・条件チェック / Pricing guardrail',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '送る前の見積を添付するか、price-guard/inbox のファイルを指定してください。値引率・下限単価・支払条件などを社内の価格ルールと価格表に照らします。 / Attach a quote before it goes out or name a file in price-guard/inbox, and I will check its discounts, floor prices and terms against your pricing rules and price list.',
    suggestedPrompts: [
      'price-guard/inbox/見積_Q-2611-031_シギ電設.md を価格ルールに照らしてチェックして',
      'Check price-guard/inbox/見積_Q-2611-031_シギ電設.md against the pricing rules',
      'price-guard/inbox/見積_Q-2611-031_シギ電設.md の提示単価が価格表の下限単価を下回っていないか、PG-02 だけ確かめて',
      'Check only PG-02: are the offered unit prices in price-guard/inbox/見積_Q-2611-031_シギ電設.md at or above the floor prices?',
    ],
    disclaimer:
      '判定は社内の価格ルールにもとづく判断材料です。価格を変えたり見積を送ったりはしません。送付してよいかは営業部長が決めます。 / The verdicts follow your pricing rules. It never changes a price or sends a quote; the sales manager decides whether it goes out.',
    toolTrace: 'collapsed',
    history: true,
  },
});
