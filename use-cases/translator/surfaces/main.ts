import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'translator',
  title: '文書翻訳 / Document translator',
  layout: 'page',
  parts: {
    attachments: true,
    greeting:
      '翻訳する Word の文書を添付するか、translator のファイルを指定してください。用語集に沿って日本語と英語の間で訳し、見出しと段落の構成を保ったまま Word で書き出します。書き出す前に承認をお願いします。 / Attach a Word document or name a file in translator, and I will translate it between Japanese and English with your glossary, keep its headings and paragraphs, and ask for your approval before writing the Word file.',
    suggestedPrompts: [
      'translator/ja/notes/製品発表_KL-200温度ロガー.docx を英語に翻訳して',
      'Translate translator/en/notes/Product-announcement_KL-200.docx into Japanese',
      'translator/ja/notes/社内通知_年末年始の営業.md の英訳だけを見せて',
    ],
    disclaimer:
      '翻訳は下書きです。公開の前に担当者が確認します。 / A draft translation: a person checks it before it is used.',
    toolTrace: 'collapsed',
    history: true,
  },
});
