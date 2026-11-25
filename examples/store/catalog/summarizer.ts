import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'summarizer',
  area: 'knowledge',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/summarizer',
  name: {
    ja: '長文要約',
    en: 'Long-document summarizer',
  },
  summary: {
    ja: '長い報告書と会議の議事録を読み、決定事項・主な数字・リスク・未決事項に分けた要約を、出典付きで作る。',
    en: 'Summarizes a long report and its meeting minutes into decisions, key figures, risks and open matters, each with its source.',
  },
  demo: {
    agent: 'summarizer',
    prompts: [
      {
        ja: '物流拠点再編の報告書を、依頼メモに沿って要約して',
        en: 'Summarize the logistics site consolidation report as the request asks',
      },
      {
        ja: '物流拠点再編の要約の構成だけを示して',
        en: 'Show only the outline of the summary of the logistics site consolidation report',
      },
    ],
    moment: {
      ja: '報告書を渡すと、決定事項・数字・リスク・未決事項の構成が出典付きで出て、Word の書き出しが承認待ちになる。報告書の推奨を決定事項にしない。',
      en: "Hand over the report; out comes an outline of decisions, figures, risks and open matters, each with its source, never the report's recommendation as a decision, and the Word document waits for approval.",
    },
    data: {
      ja: '架空の物流拠点再編の検討報告書・費用試算の付録・経営会議の議事録の抜粋',
      en: 'a fictional logistics study report, its cost appendix and a management committee minutes excerpt',
    },
    seed: [{ collection: 'summarizer', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['approval', 'files', 'structured'],
});
