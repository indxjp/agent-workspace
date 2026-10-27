// scripts/ci/debt-review.mjs (audit W4-3): the quarterly review issue body.
import { describe, expect, it } from 'vitest';

import {
  countProposedAdrs,
  countSuppressions,
  measure,
  quarterOf,
  render,
  reviewDates,
} from '../../scripts/ci/debt-review.mjs';

describe('debt-review', () => {
  it('maps a date to its quarter', () => {
    expect(quarterOf('2026-10-18')).toBe('2026-Q4');
    expect(quarterOf('2027-03-31')).toBe('2027-Q1');
  });

  it('sums suppression counts', () => {
    expect(
      countSuppressions({ a: { x: { count: 2 }, y: { count: 1 } }, b: { x: { count: 4 } } }),
    ).toBe(7);
  });

  it('extracts review dates, soonest first', () => {
    expect(
      reviewDates({
        b: 'review by 2027-02-01',
        a: 'Owner decision, review by 2027-01-18',
        c: 'none',
      }),
    ).toEqual([
      { entry: 'a', date: '2027-01-18' },
      { entry: 'b', date: '2027-02-01' },
    ]);
  });

  it('counts proposed ADRs by their Status line only', () => {
    expect(
      countProposedAdrs([
        'Status: proposed',
        'Status: accepted\nproposed later',
        'Status: D3 proposed',
      ]),
    ).toBe(2);
  });

  it('renders a marker keyed by quarter and flags overdue osv reviews', () => {
    // A fixed review entry, not .osv-baseline.json's: the baseline empties as advisories are fixed
    // or withdrawn (sprintf-js's GHSA-hp3w-g68c-fv3c was withdrawn on 2026-10-22).
    const m = {
      ...measure('2027-01-18'),
      osvReviews: [{ entry: 'example@1.0.0 GHSA-0000-0000-0000', date: '2027-01-18' }],
    };
    const body = render(m);
    expect(body.startsWith('<!-- debt-review:2027-Q1 -->')).toBe(true);
    expect(body).toContain('Overdue osv reviews: example@1.0.0');
    expect(render({ ...m, date: '2026-10-18' })).toContain('No osv review date has passed.');
  });

  it('shows the storage story gaps row', () => {
    const m = measure('2027-01-18');
    expect(m.storyGaps).toBeGreaterThanOrEqual(0);
    expect(m.storyGaps).toBeLessThanOrEqual(37);
    expect(render({ ...m, storyGaps: 5 })).toContain('| storage story gaps | 5 |');
  });

  it('shows the storage-bridge markers row', () => {
    const m = measure('2027-01-18');
    expect(m.storageBridges).toBeGreaterThan(0);
    expect(render({ ...m, storageBridges: 3 })).toContain('| `storage-bridge` markers | 3 |');
  });

  it('shows the storage-limits allowlist row', () => {
    const m = measure('2027-01-18');
    expect(m.storageLimitsAllowlist).toBeGreaterThan(0);
    expect(render({ ...m, storageLimitsAllowlist: 4 })).toContain(
      '| storage-limits allowlist entries | 4 |',
    );
  });

  it('shows the catalog-fakes allowlist row', () => {
    const m = measure('2027-01-18');
    expect(m.catalogFakesAllowlist).toBeGreaterThan(0);
    expect(render({ ...m, catalogFakesAllowlist: 6 })).toContain(
      '| catalog-fakes allowlist sites | 6 |',
    );
  });

  it('shows the route-error-boundary allowlist row', () => {
    const m = measure('2027-01-18');
    expect(m.routeBoundaryAllowlist).toBeGreaterThan(0);
    expect(render({ ...m, routeBoundaryAllowlist: 7 })).toContain(
      '| route-error-boundary allowlist entries | 7 |',
    );
  });
});
