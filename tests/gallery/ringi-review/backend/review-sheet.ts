/**
 * The review sheet the `ringi-checklist` skill asks for, as the shape the run is asked to return.
 *
 * The hook starts the run with `ReviewSheetSchema` as its `outputSchema`, so the sheet arrives typed:
 * a heading the agent drops is a missing required key and the run fails instead of reading as "no
 * findings". `renderReviewSheet` writes it back in the skill's Markdown for the comment a person reads.
 */
import { z } from 'zod';

const FindingSchema = z.object({
  text: z.string().describe('指摘の本文。出典の〔〕は本文に入れず citations に分けて書く'),
  citations: z
    .array(z.string())
    .describe(
      '出典。check_authority の citation と、Read で読んだ規程・稟議の「出典」の〔〕の中身だけを写す（例: 稟議規程 §4.1）',
    ),
});

export const ReviewSheetSchema = z.object({
  記載漏れ: z
    .array(FindingSchema)
    .describe('稟議規程 §4.1 の必須記載事項のうち（未記載）の項目を1件に1つ。なければ空配列'),
  規程との照合: z
    .array(FindingSchema)
    .describe('抵触のおそれがある規程を、何が不足しているかと一緒に1件に1つ。なければ空配列'),
  決裁区分: z.object({
    approver: z.string().describe('check_authority の approver をそのまま写す（例: 本部長）'),
    clause: z.string().describe('check_authority の clause の〔〕の中身だけを写す'),
    coReview: z.string().nullable().describe('合議先。なければ null'),
  }),
  類似案件: z
    .array(FindingSchema)
    .describe('関係の深い順に最大3件。件名と結果とこの稟議との関係を text に書く。なければ空配列'),
  総合所見: z.string().describe('決裁者が確認すべき点を2〜3文で。承認・否決の推奨は書かない'),
});

export type ReviewSheet = z.output<typeof ReviewSheetSchema>;
export type Finding = z.output<typeof FindingSchema>;

const bullet = ({ text, citations }: Finding): string =>
  `- ${text}${citations.map((citation) => `〔${citation}〕`).join('')}`;

const bullets = (findings: readonly Finding[]): string[] =>
  findings.length > 0 ? findings.map(bullet) : ['- なし'];

/** The sheet in the skill's format: the five fixed headings, in order. */
export function renderReviewSheet(sheet: ReviewSheet): string {
  const { approver, clause, coReview } = sheet.決裁区分;
  return [
    '## 記載漏れ',
    ...bullets(sheet.記載漏れ),
    '',
    '## 規程との照合',
    ...bullets(sheet.規程との照合),
    '',
    '## 決裁区分',
    `- 決裁区分: ${approver}決裁〔${clause}〕`,
    `- 合議: ${coReview ?? 'なし'}`,
    '',
    '## 類似案件',
    ...bullets(sheet.類似案件),
    '',
    '## 総合所見',
    sheet.総合所見,
  ].join('\n');
}
