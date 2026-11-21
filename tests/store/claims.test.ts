/**
 * The safety claims /platform makes: each one that holds names evidence that exists, a claim not
 * yet proven shows its phase, and nothing says every run is in the audit log.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAIMS, plannedMarker } from '../../examples/store/app/claims.ts';
import { featureNames, safetyTags } from '../../examples/store/app/labels.ts';
import { defineLanding } from '../../examples/store/catalog/define.ts';
import { CATALOG, FEATURED } from '../../examples/store/catalog/index.ts';
import { LANDING } from '../../examples/store/catalog/landing.generated.ts';

const root = resolve(__dirname, '../..');

describe('the safety claims', () => {
  it('holds the person, approval, network, sample-data, run-recorded and no-internet claims', () => {
    expect(CLAIMS.filter((c) => c.status.kind === 'holds').map((c) => c.id)).toEqual([
      'person',
      'approval',
      'network',
      'sampleData',
      'runRecorded',
      'noInternet',
    ]);
  });

  it('shows no claim as planned any more, and still words a planned one in the spec’s words', () => {
    expect(CLAIMS.filter((claim) => claim.status.kind === 'planned')).toEqual([]);
    expect(plannedMarker('P6', 'en')).toBe('Planned · P6');
    expect(plannedMarker('P6', 'ja')).toBe('計画 · P6');
  });

  it('holds the no-internet claim on the store test that proves each link of it', () => {
    const claim = CLAIMS.find((c) => c.id === 'noInternet');
    expect(claim?.status).toEqual({
      kind: 'holds',
      evidence: ['apps/web/server/demo/proof/no-internet.test.ts'],
    });
  });

  it('names an existing evidence file for every claim that holds', () => {
    for (const claim of CLAIMS) {
      if (claim.status.kind !== 'holds') continue;
      expect(claim.status.evidence.length, claim.id).toBeGreaterThan(0);
      for (const file of claim.status.evidence) {
        expect(existsSync(resolve(root, file)), `${claim.id}: ${file}`).toBe(true);
      }
    }
  });

  it('holds the run-recorded claim on the store test that proves it', () => {
    const claim = CLAIMS.find((c) => c.id === 'runRecorded');
    expect(claim?.status).toEqual({
      kind: 'holds',
      evidence: ['apps/web/server/demo/proof/run-recorded.test.ts'],
    });
  });

  it('never says every run is in the audit log, in either language', () => {
    for (const claim of CLAIMS) {
      for (const text of [claim.text.ja, claim.text.en]) {
        expect(text, claim.id).not.toMatch(/audit|監査/iu);
      }
    }
    expect(CLAIMS.map((c) => c.id)).not.toContain('audit');
  });

  it('words each claim in both languages', () => {
    for (const claim of CLAIMS) {
      expect(claim.text.ja.length, claim.id).toBeGreaterThan(0);
      expect(claim.text.en.length, claim.id).toBeGreaterThan(0);
    }
  });

  it('tags an entry only with what holds today, and never an audit or no-internet tag', () => {
    const soon = CATALOG.find((candidate) => candidate.status === 'soon');
    for (const each of CATALOG) {
      const tags = safetyTags(each, 'en').join(' ').toLowerCase();
      expect(tags).not.toMatch(/audit|internet/u);
    }
    expect(safetyTags(FEATURED, 'en')).toEqual([
      'Acts only within the asking person’s access',
      'Writes can wait for approval',
    ]);
    expect(featureNames(FEATURED.safety, 'en')).toContain('Structured output');
    if (soon !== undefined) expect(safetyTags(soon, 'en')).toEqual([]);
  });

  it('lets no landing field hold an unmeasured quantity, and still lets copy name things', () => {
    const [slug, page] = Object.entries(LANDING)[0] ?? [];
    if (slug === undefined || page === undefined) throw new Error('no landing copy');
    const withHeadline = (text: string) => () =>
      defineLanding({ [slug]: { ...page, headline: { ...page.headline, ja: text } } });
    for (const claim of [
      '作業を3時間短くする',
      '工数を３０％減らす',
      '二十四時間動く',
      '三割の手間',
      '２倍の速さ',
      '数時間かかる確認',
      'Saves five hours a week',
      'Answers 3x as many',
      '50 percent fewer errors',
    ]) {
      expect(withHeadline(claim), claim).toThrow(/unmeasured number/u);
    }
    for (const name of [
      'ISO 27001 の要求事項',
      'Step 1 から始める',
      '第1条から順に読む',
      '36協定の確認',
      'Excel 2019 のファイル',
      '十分に確認する',
      '一人ひとりの申請',
      '一件ずつ確認する',
      '役割と割り当て',
    ]) {
      expect(withHeadline(name), name).not.toThrow();
    }
  });

  /** Wording of a measured result or a quote that needs no numeral; ordinary Japanese stays allowed. */
  const UNMEASURED_WORDING =
    /[一二三四五六七八九十数]割|[0-9０-９一二三四五六七八九十数]+倍|(?:時間|工数|手間)を(?:削減|短縮|半減)|お客様の声|導入企業|saves? (?:time|hours)|(?:twice|times) as (?:fast|many|much)|faster|percent|testimonial|customers say|[“”]/iu;

  it('tells measured-result wording from ordinary words', () => {
    for (const ordinary of [
      '役割',
      '割り当て',
      '分割',
      '確認に時間をとられる',
      'saves a redline',
    ]) {
      expect(ordinary).not.toMatch(UNMEASURED_WORDING);
    }
    for (const claim of ['三割', '２倍', '時間を削減', 'saves time', 'twice as fast', '“great”']) {
      expect(claim).toMatch(UNMEASURED_WORDING);
    }
  });

  it('words no landing copy as a measured result or a customer quote, in either language', () => {
    for (const [slug, page] of Object.entries(LANDING)) {
      const texts = [
        page.headline,
        page.audience,
        page.problem,
        ...page.steps.map((step) => step.text),
        ...page.outputs,
        ...page.faq.flatMap(({ q, a }) => [q, a]),
        ...page.limits,
      ].flatMap(({ ja, en }) => [ja, en]);
      for (const text of texts) expect(text, slug).not.toMatch(UNMEASURED_WORDING);
    }
  });
});
