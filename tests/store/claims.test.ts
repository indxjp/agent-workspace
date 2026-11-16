/**
 * The safety claims /platform makes: each one that holds names evidence that exists, a claim not
 * yet proven shows its phase, and nothing says every run is in the audit log.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLAIMS, plannedMarker } from '../../examples/store/app/claims.ts';
import { featuresUsed, safetyTags } from '../../examples/store/app/labels.ts';
import { CATALOG, FEATURED } from '../../examples/store/catalog/index.ts';

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
    expect(featuresUsed(FEATURED, 'en')).toContain('Structured output');
    if (soon !== undefined) expect(safetyTags(soon, 'en')).toEqual([]);
  });
});
