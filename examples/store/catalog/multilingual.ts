import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'multilingual',
  area: 'support',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/multilingual',
  name: {
    ja: '多言語返信',
    en: 'Multilingual replies',
  },
  summary: {
    ja: '英語・中国語などの問い合わせに日本語の要約を付け、返信を相手の言語で作る。',
    en: "Adds a Japanese summary to foreign-language enquiries and drafts the reply in the customer's language.",
  },
  demo: {
    agent: 'multilingual',
    prompts: [
      {
        ja: '問い合わせ INQ-3001 を要約して、返信の下書きを作ってください',
        en: 'Summarize enquiry INQ-3001 and draft the reply',
      },
      {
        ja: '問い合わせ INQ-3002 を要約して、担当者に回してください',
        en: 'Summarize enquiry INQ-3002 and pass it to its owner',
      },
    ],
    moment: {
      ja: '海外からの問い合わせを渡すと、要約とお客様の言語の返信の下書きができ、担当者へのタスクの登録は承認を待つ。',
      en: "Hand over an enquiry from abroad; it adds a summary and a reply draft in the customer's language, and the task for the owner waits for approval.",
    },
    data: {
      ja: '英語・中国語・韓国語・スペイン語の架空の問い合わせ・FAQ・担当者の一覧',
      en: 'Fictional enquiries in English, Chinese, Korean and Spanish, the FAQ and the owners list',
    },
    seed: [{ collection: 'multilingual', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
