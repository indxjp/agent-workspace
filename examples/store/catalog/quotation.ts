import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'quotation',
  area: 'sales',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/quotation',
  name: {
    ja: '見積作成',
    en: 'Quotation agent',
  },
  summary: {
    ja: '過去の見積と単価表から見積書の下書きを作る。値引きが基準を超えるときは承認に回す。',
    en: 'Drafts a quote from past quotes and the price list. Discounts above the limit go to approval.',
  },
  demo: {
    agent: 'quotation',
    // The prompts carry the part spec as a fenced json block on purpose: the agent's instructions
    // (tests/gallery/quotation/agents/quotation.md) read a spec written that way instead of a drawing.
    prompts: [
      {
        ja: `以下の部品仕様で見積の下書きを作り、ERPに登録してください。
\`\`\`json
{"customer":"サンプル精機株式会社","drawingNo":"SMP-M-2231 rev.B","partName":"L形ブラケット","material":"SS400","lengthMm":200,"widthMm":100,"thicknessMm":3.2,"holeCount":4,"holeDiameterMm":10,"bendCount":2,"quantity":50}
\`\`\``,
        en: `Draft a quote for this part and register it in the ERP.
\`\`\`json
{"customer":"Sample Seiki Co.","drawingNo":"SMP-M-2231 rev.B","partName":"L bracket","material":"SS400","lengthMm":200,"widthMm":100,"thicknessMm":3.2,"holeCount":4,"holeDiameterMm":10,"bendCount":2,"quantity":50}
\`\`\``,
      },
      {
        ja: `以下の部品仕様で見積の下書きを作ってください（登録はしないで）。
\`\`\`json
{"customer":"サンプル中央工業株式会社","drawingNo":"SMP-H-0042","partName":"放熱プレート","material":"A5052","lengthMm":120,"widthMm":80,"thicknessMm":5,"holeCount":4,"holeDiameterMm":5.5,"bendCount":0,"quantity":7}
\`\`\``,
        en: `Draft a quote for this part (do not register it).
\`\`\`json
{"customer":"Sample Chuo Industries Co.","drawingNo":"SMP-H-0042","partName":"Heat-sink plate","material":"A5052","lengthMm":120,"widthMm":80,"thicknessMm":5,"holeCount":4,"holeDiameterMm":5.5,"bendCount":0,"quantity":7}
\`\`\``,
      },
    ],
    moment: {
      ja: '見積の下書きと原価の内訳が出て、ERPへの登録は担当者の承認待ちで止まる。',
      en: "A draft quote and its cost breakdown come out, and registering it in the ERP stops to wait for a person's approval.",
    },
    data: {
      ja: '部品5点・過去受注6件・材料レート3種',
      en: '5 parts, 6 past orders, 3 material rates',
    },
    seed: [],
    records: 'sample-data',
    check: { tools: ['searchParts', 'getRate', 'run_skill_script'], approval: 'createQuote' },
  },
  safety: ['person', 'approval', 'structured'],
  next: {
    source: 'use-cases/quotation',
    demo: {
      agent: 'quotation',
      prompts: [
        {
          ja: `以下の部品仕様で見積の下書きを作り、ERPに登録してください。
\`\`\`json
{"customer":"サンプル精機株式会社","drawingNo":"SMP-M-2231 rev.B","partName":"L形ブラケット","material":"SS400","lengthMm":200,"widthMm":100,"thicknessMm":3.2,"holeCount":4,"holeDiameterMm":10,"bendCount":2,"quantity":50}
\`\`\``,
          en: `Draft a quote for this part and register it in the ERP.
\`\`\`json
{"customer":"Sample Seiki Co.","drawingNo":"SMP-M-2231 rev.B","partName":"L bracket","material":"SS400","lengthMm":200,"widthMm":100,"thicknessMm":3.2,"holeCount":4,"holeDiameterMm":10,"bendCount":2,"quantity":50}
\`\`\``,
        },
        {
          ja: `以下の部品仕様で見積の下書きを作ってください（登録はしないで）。
\`\`\`json
{"customer":"サンプル中央工業株式会社","drawingNo":"SMP-H-0042","partName":"放熱プレート","material":"A5052","lengthMm":120,"widthMm":80,"thicknessMm":5,"holeCount":4,"holeDiameterMm":5.5,"bendCount":0,"quantity":7}
\`\`\``,
          en: `Draft a quote for this part (do not register it).
\`\`\`json
{"customer":"Sample Chuo Industries Co.","drawingNo":"SMP-H-0042","partName":"Heat-sink plate","material":"A5052","lengthMm":120,"widthMm":80,"thicknessMm":5,"holeCount":4,"holeDiameterMm":5.5,"bendCount":0,"quantity":7}
\`\`\``,
        },
      ],
      moment: {
        ja: '見積の下書きと原価の内訳が出て、ERPへの登録は担当者の承認待ちで止まる。',
        en: "A draft quote and its cost breakdown come out, and registering it in the ERP stops to wait for a person's approval.",
      },
      data: {
        ja: '架空のERPの書き出し（単価表・品番一覧・受注実績6件）',
        en: 'Fictional ERP exports: the rate table, the part list and 6 past orders',
      },
      seed: [{ collection: 'quotation', from: 'data' }],
      check: { tools: ['search_files', 'run_skill_script'], approval: 'create_quote' },
    },
  },
});
