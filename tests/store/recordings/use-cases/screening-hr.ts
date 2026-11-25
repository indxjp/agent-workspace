/**
 * The screening-hr entry's recorder: the application the prompt names, read with the five posted
 * requirements, one verdict per requirement with the applicant's own words as evidence, and the
 * summary written behind the approval. The summary uses no personal attribute no requirement names
 * (the application's date of birth and gender appear nowhere in it), and has no rank or score.
 */
import screeningHrAgent from '../../../../use-cases/screening-hr/agents/screening-hr.ts';
import type { Recorder } from '../types.ts';
import { carries, reporting, table, type Bilingual } from '../use-case-script.ts';
import { playUseCase } from '../use-case-desk.ts';

const APPLICATION = 'A-0412_職務経歴書';
const STANDARDS = [
  'REQ-01-experience',
  'REQ-02-drawings',
  'REQ-03-improvement',
  'REQ-04-plc',
  'REQ-05-english',
].map((name) => `screening-hr/standards/${name}.md`);

const QUOTE = {
  years: '「経験年数：5年（生産技術）」',
  cad: '「二次元CADで、組立治具の部品図と組立図を作成し、試作の結果に合わせて寸法と公差を修正した」',
  why: '「なぜなぜ分析で原因を締付け順序に絞り込み、作業手順と治具を見直して不良を減らした」',
  plc: '「PLC基礎研修（社内、3日間）を受講」',
};

const TABLE: Bilingual = {
  ja: table(
    ['要件', '判定', '根拠', '理由', '確認すること'],
    [
      [
        '生産技術または設備保全の実務経験（必須）〔REQ-01〕',
        '満たす',
        QUOTE.years,
        '製造業の工場での生産技術の経験年数が3年以上と書かれている',
        '',
      ],
      [
        '機械図面の読解と修正（必須）〔REQ-02〕',
        '満たす',
        QUOTE.cad,
        'CADで図面を作成し、修正した具体的な業務が書かれている',
        '',
      ],
      [
        '品質改善の手法を使った改善の経験（必須）〔REQ-03〕',
        '満たす',
        QUOTE.why,
        '使った手法（なぜなぜ分析）と改善の対象（ねじ締め不良）がともに書かれている',
        '',
      ],
      [
        'PLCのプログラム修正（歓迎）〔REQ-04〕',
        '不明確',
        QUOTE.plc,
        '研修の受講だけで、自らプログラムを修正したかが読み取れない',
        'PLCのプログラムを実機で修正した経験があるか',
      ],
      [
        '英語の技術資料の読解（歓迎）〔REQ-05〕',
        '記載なし',
        'なし',
        '英語について何も書かれていない',
        '英語の取扱説明書や仕様書を業務で読んだ経験があるか',
      ],
    ],
  ),
  en: table(
    ['Requirement', 'Verdict', 'Evidence', 'Why', 'To confirm'],
    [
      [
        'Production engineering or maintenance experience (required) [REQ-01]',
        'met',
        QUOTE.years,
        'It states production engineering experience at a factory of 3 years or more',
        '',
      ],
      [
        'Reading and revising mechanical drawings (required) [REQ-02]',
        'met',
        QUOTE.cad,
        'It states drawing and revising drawings in CAD',
        '',
      ],
      [
        'Improvement work with quality methods (required) [REQ-03]',
        'met',
        QUOTE.why,
        'It states both the method (why-why analysis) and what was improved (screw-tightening defects)',
        '',
      ],
      [
        'Revising PLC programs (preferred) [REQ-04]',
        'unclear',
        QUOTE.plc,
        'Only a training course; it does not say the applicant revised a program',
        'Whether the applicant has revised a PLC program on real equipment',
      ],
      [
        'Reading English technical documents (preferred) [REQ-05]',
        'not shown',
        'none',
        'The application says nothing about English',
        'Whether the applicant has read English manuals or specifications at work',
      ],
    ],
  ),
};

const ANSWER: Bilingual = {
  ja: `応募番号 A-0412 の応募書類を、募集要項の要件 REQ-01〜REQ-05 ごとに整理しました。承認されたサマリーを screening-hr-reports/${APPLICATION}_summary.md に保存しました。\n\n${TABLE.ja}\n\n選考の判断は担当者が行ってください。`,
  en: `I summarised application A-0412 against the posted requirements REQ-01 to REQ-05. The approved summary is saved to screening-hr-reports/${APPLICATION}_summary.md.\n\n${TABLE.en}\n\nA person makes every hiring decision.`,
};

export const screeningHr: Recorder = (ask) => {
  carries(ask, `screening-hr/inbox/${APPLICATION}.md`);
  return playUseCase(
    ask.slug,
    screeningHrAgent,
    reporting({
      queries: [],
      open: [`screening-hr/inbox/${APPLICATION}.md`, ...STANDARDS],
      file: `screening-hr-reports/${APPLICATION}_summary.md`,
      report: `# ${APPLICATION} ${ask.lang === 'ja' ? 'サマリー' : 'summary'}\n\n${TABLE[ask.lang]}\n`,
      answer: ANSWER[ask.lang],
    }),
    ask,
  );
};
