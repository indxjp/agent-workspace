import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'work-instruction',
  area: 'mfg',
  status: 'soon',
  wave: 2,
  kind: 'agent',
  source: 'use-cases/work-instruction',
  name: {
    ja: '作業手順書作成',
    en: 'Work instruction writer',
  },
  summary: {
    ja: '現場での説明の文字起こしから、安全基準の条項を添えた作業手順書の下書きを作る。',
    en: 'Drafts a work instruction from a transcribed walkthrough, with safety notes cited from your standard.',
  },
  demo: {
    agent: 'work-instruction',
    prompts: [
      {
        ja: 'P-3 の金型交換の文字起こしから作業手順書を作成して',
        en: 'Draft the work instruction for the P-3 die change from the transcript',
      },
      {
        ja: 'P-3 の金型交換の作業手順書の構成だけを示して',
        en: 'Show only the outline of the work instruction for the P-3 die change',
      },
    ],
    moment: {
      ja: '文字起こしを渡すと、安全基準の条項付きの手順書の構成が出て、Word の書き出しが承認待ちになる。',
      en: 'Hand over the transcript; out comes a work instruction outline with cited safety clauses, and the Word document waits for approval.',
    },
    data: {
      ja: '架空の作業説明の文字起こし・プレス作業安全基準・取扱説明書の抜粋',
      en: 'a fictional walkthrough transcript, press safety standard and manual excerpt',
    },
    seed: [{ collection: 'work-instruction', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
