import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'translator',
  area: 'knowledge',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/translator',
  name: {
    ja: '文書翻訳',
    en: 'Document translator',
  },
  summary: {
    ja: '用語集に沿って社内文書を翻訳し、見出しと段落の構成を保った Word で返す。',
    en: 'Translates documents with your glossary and returns Word files that keep the headings and paragraphs.',
  },
  demo: {
    agent: 'translator',
    prompts: [
      {
        ja: 'translator/ja/notes/社内通知_年末年始の営業.md を英語に翻訳して',
        en: 'Translate translator/en/notes/Notice_year-end-hours.md into Japanese',
      },
      {
        ja: 'translator/ja/notes/製品発表_KL-200温度ロガー.docx を英語に翻訳して',
        en: 'Translate translator/en/notes/Product-announcement_KL-200.docx into Japanese',
      },
    ],
    moment: {
      ja: '文書を渡すと、用語集どおりの訳文が見出しの順に出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over a document; the translation appears block by block with the glossary terms, and the Word file waits for approval.',
    },
    data: {
      ja: '架空の製品発表（Word）・社内通知・訳語集・翻訳スタイルガイド',
      en: 'a fictional product announcement (Word), a notice, a glossary and a translation style guide',
    },
    seed: [{ collection: 'translator', from: 'data' }],
    check: { tools: ['Read'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
