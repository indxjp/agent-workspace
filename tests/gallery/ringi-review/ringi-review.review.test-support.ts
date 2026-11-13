import { expect, it } from 'vitest';

import { reviewRun } from './backend/review-run.ts';
import { CONVEYOR, QUOTE_ID, hook, reviewer } from './ringi-review.fixture.test-support.ts';

export function defineReviewCases(): void {
  it('startReview starts a typed review and reviewRun checks a sheet whose route matches the matrix', async () => {
    const desk = await hook(reviewer());
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);

    expect(review.authority).toMatchObject({
      written: '取締役会',
      matches: true,
      toolCalled: true,
      expected: { route: '取締役会決裁', clause: '〔職務権限規程 §3.1〕' },
    });
    expect(review.sheet.記載漏れ).toStrictEqual([
      { text: '期待効果が記載されていない。', citations: ['稟議規程 §4.1'] },
    ]);
    expect(review.missingFields).toStrictEqual(['期待効果']);
    expect(review.missedByAgent).toStrictEqual([]);
    expect(review.sheet.規程との照合[0]?.citations).toStrictEqual(['稟議規程 §4.2']);
    // Membership, not order: search_files ranks near-equal files by its own score.
    expect(review.sheet.類似案件.map((finding) => finding.citations[0]).sort()).toStrictEqual([
      '稟議 R-2025-0112',
      '稟議 R-2026-0018',
    ]);
    expect(review.unverified).toStrictEqual([]);

    expect(desk.runs()).toBe(1);
    expect(comment).toContain('承認・否決の判断はしていません');
    expect(comment).not.toContain('⚠');
  });

  it('filing the same revision again, even at once, starts one review for the filer; a new revision starts another', async () => {
    const desk = await hook(reviewer());
    const withQuote = { ...CONVEYOR, quotes: [{ fileId: QUOTE_ID }] };
    const [first, concurrent] = await Promise.all([desk.file(withQuote), desk.file(withQuote)]);
    const later = await desk.file(withQuote);
    expect([concurrent, later]).toStrictEqual([first, first]);
    expect(desk.runs()).toBe(1);
    expect(desk.subjects()).toStrictEqual([CONVEYOR.submittedBy]);

    const { review } = await reviewRun(first, withQuote, desk);
    expect(review.sheet.類似案件.length).toBeGreaterThan(0);
    expect(review.unverified).toStrictEqual([]);

    const revised = await desk.file({ ...withQuote, revision: 2 });
    expect(revised).not.toBe(first);
    expect(desk.runs()).toBe(2);
  });

  it('reviewRun flags a 決裁区分 that disagrees with the authority matrix', async () => {
    const desk = await hook(reviewer({ misreadApprover: '本部長' }));
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(review.authority).toMatchObject({ written: '本部長', matches: false });
    expect(comment).toContain(
      '⚠ 決裁区分の不一致: レビューシートは「本部長」、職務権限規程の判定は「取締役会決裁」〔職務権限規程 §3.1〕です。',
    );
  });

  it('the quotes (見積書) ride on the review run as attachments, and a ringi without quotes sends none', async () => {
    const desk = await hook(reviewer());
    const second = { fileId: 'a0000000-0000-4000-8000-000000000012' };
    await desk.file({ ...CONVEYOR, quotes: [{ fileId: QUOTE_ID }, second] });
    const { quotes, ...withoutQuotes } = CONVEYOR;
    expect(quotes).toHaveLength(1); // the revision below drops them
    await desk.file({ ...withoutQuotes, revision: 2 });

    const starts = desk.calls
      .filter((call) => call.method === 'POST')
      .map((call) => call.json as { prompt: string; attachments?: unknown });
    expect(starts[0]?.attachments).toStrictEqual([{ fileId: QUOTE_ID }, second]);
    expect(starts[0]?.prompt).toContain(`"quotes":[{"fileId":"${QUOTE_ID}"},`);
    expect(starts[1]).not.toHaveProperty('attachments');
    expect(starts[1]?.prompt).not.toContain('"quotes"');
  });

  it('reviewRun reads the review sheet as typed output and flags a citation no tool returned', async () => {
    const desk = await hook(reviewer({ invent: '寄付金取扱基準 §9.9' }));
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(desk.outputSchemas()).toMatchObject([
      {
        type: 'object',
        required: ['記載漏れ', '規程との照合', '決裁区分', '類似案件', '総合所見'],
      },
    ]);
    expect(review.unverified).toStrictEqual(['寄付金取扱基準 §9.9']);
    expect(comment).toContain('⚠ 根拠を確認できない出典: 〔寄付金取扱基準 §9.9〕');
    expect(comment).toContain('## 総合所見');
  });

  it('reviewRun also flags a citation written inline in a finding that no tool returned', async () => {
    const desk = await hook(reviewer({ inventInline: '寄付金取扱基準 §9.9' }));
    const { review, comment } = await reviewRun(await desk.file(), CONVEYOR, desk);
    expect(review.unverified).toStrictEqual(['寄付金取扱基準 §9.9']);
    expect(comment).toContain('⚠ 根拠を確認できない出典: 〔寄付金取扱基準 §9.9〕');
  });
}
