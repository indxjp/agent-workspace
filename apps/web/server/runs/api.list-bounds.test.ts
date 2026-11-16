import { afterEach, describe, expect, it } from 'vitest';
import { resetTestRunApi } from '../application-context-fixtures';
import { listRuns } from './api';
import { errorCode, get, install, listBody, seedRun } from './api.test-support';
import { InMemoryRunStore } from './memory-store';

afterEach(() => {
  resetTestRunApi();
});

/**
 * Round 4 findings 2 and 5: `from`/`to` used to be gated by `new Date(text)`, which admits
 * values PostgreSQL refuses (a signed six-digit year, year 0), values it reads as a different
 * instant than the caller meant (a zone-less timestamp, read in the web process's own time
 * zone), and values that are not ISO-8601 at all (`1`, `2026`, `Sep 12 2026`). Every probe
 * below is the verifier's; the assertion is the documented `400`, by name, on each parameter.
 * The same probes run against real PostgreSQL in `store.test.ts`, where the thrown query used
 * to happen.
 *
 * Two of the rows look redundant and are not. `.1234Z` and `.123456Z` are refused at HEAD for a
 * *second* reason — `Number("1234")` is 1234 ms, which rolls the second, and `instantOfUtcFields`
 * reads that back as a different instant — so they stay `400` even if the fraction group is
 * widened past three digits. `.0999Z` and `.0001Z` are the probes that isolate the digit rule
 * itself: a fourth digit that does not roll the second, refused only because
 * `RUN_LIST_BOUND` admits at most three of them (ADR point 12). `9999-12-31T23:59:00-00:01` does
 * the same for the upper bound: it lands, after its offset, on exactly
 * `10000-01-01T00:00:00.000Z`, one instant past `LATEST_RUN_LIST_BOUND`, where
 * `9999-12-31T23:00:00-02:00` is a whole hour past it and survives a bound moved by one
 * millisecond.
 */
describe('GET /api/runs', () => {
  it.each([
    '+275760-09-13T00:00:00.000Z',
    '-271821-04-20T00:00:00.000Z',
    '-000001-01-01T00:00:00.000Z',
    '0000-01-01T00:00:00Z',
    '0000-01-01T00:00:00.000Z',
    '2026-09-13T00:00:00',
    '2026-09-13T00:00:00.000',
    '2026-09-12',
    '1',
    '2026',
    'Sep 12 2026',
    '2026-09-12T00:00:00.1234Z',
    '2026-09-12T00:00:00.123456Z',
    '2026-09-12T00:00:00.0999Z',
    '2026-09-12T00:00:00.0001Z',
    '2026-02-30T00:00:00Z',
    '2026-09-12T24:00:00Z',
    '2026-09-12T23:59:60Z',
    '2026-09-12T00:00:00+24:00',
    '2026-09-12T00:00:00+09:60',
    '2026-09-12t00:00:00z',
    ' 2026-09-12T00:00:00Z',
    '9999-12-31T23:00:00-02:00',
    '9999-12-31T23:59:00-00:01',
    '0001-01-01T00:00:00+00:01',
  ])('from=%j, and to= the same, is 400 by name, never parsed by `new Date`', async (value) => {
    install();
    const from = await listRuns(get(`http://web/api/runs?from=${encodeURIComponent(value)}`));
    expect(from.status).toBe(400);
    expect(await errorCode(from)).toBe('invalid_from');
    const to = await listRuns(get(`http://web/api/runs?to=${encodeURIComponent(value)}`));
    expect(to.status).toBe(400);
    expect(await errorCode(to)).toBe('invalid_to');
  });
});

/**
 * The accepted side of the edges the list above refuses. `9999-12-31T23:58:59.999-00:01` is the
 * same instant as `9999-12-31T23:59:59.999Z` written with an offset — exactly
 * `LATEST_RUN_LIST_BOUND`. The pre-existing `Z` spelling below already kills an
 * `instant >= LATEST` off-by-one; what this row adds is the offset subtraction at `api.ts:486`
 * landing exactly on the bound, which no `Z` spelling in this list exercises.
 */
describe('GET /api/runs', () => {
  it.each([
    '2026-09-12T00:00:00Z',
    '2026-09-12T00:00:00.1Z',
    '2026-09-12T00:00:00.50Z',
    '2026-09-12T00:00:00.123Z',
    '2026-09-12T00:00:00+09:00',
    '2026-09-12T00:00:00.500-05:30',
    '0001-01-01T00:00:00Z',
    '0001-01-01T00:00:00-00:00',
    '9999-12-31T23:59:59.999Z',
    '9999-12-31T23:59:59.999+00:00',
    '9999-12-31T23:58:59.999-00:01',
    '2024-02-29T00:00:00Z',
  ])('from=%j, and to= the same, is accepted', async (value) => {
    install();
    const from = await listRuns(get(`http://web/api/runs?from=${encodeURIComponent(value)}`));
    expect(from.status).toBe(200);
    const to = await listRuns(get(`http://web/api/runs?to=${encodeURIComponent(value)}`));
    expect(to.status).toBe(200);
  });
});

describe('GET /api/runs', () => {
  it('reads a from/to bound with an offset as the UTC instant it names, whatever the process time zone', async () => {
    // One run at exactly 2026-09-12T15:00:00.000Z, one a millisecond earlier. A bound written as
    // `2026-09-13T00:00:00+09:00` names the former instant exactly: as `from=` it keeps the run at
    // it and drops the one before; as `to=` (inclusive) it keeps both, and the millisecond before
    // it, written with the same offset, keeps only the earlier run. Nothing here depends on
    // `process.env.TZ` because nothing here is parsed in local time (round 4 finding 5).
    const at = Date.parse('2026-09-12T15:00:00.000Z');
    const clock = [at - 1, at];
    let tick = 0;
    const store = new InMemoryRunStore({
      now: (): Date => {
        const instant = clock[tick];
        if (instant === undefined) throw new Error('the controlled clock was read too many times');
        tick += 1;
        return new Date(instant);
      },
    });
    const harness = install({}, store);
    const before = await seedRun(harness.store);
    const exact = await seedRun(harness.store);

    const ids = async (query: string): Promise<string[]> =>
      (await listBody(await listRuns(get(`http://web/api/runs?${query}`)))).runs.map(
        (run) => run['id'] as string,
      );
    const tokyoMidnight = encodeURIComponent('2026-09-13T00:00:00+09:00');
    const tokyoMidnightLessOneMs = encodeURIComponent('2026-09-12T23:59:59.999+09:00');
    expect(await ids(`from=${tokyoMidnight}`)).toEqual([exact.id]);
    expect(await ids(`to=${tokyoMidnight}`)).toEqual([exact.id, before.id]);
    expect(await ids(`to=${tokyoMidnightLessOneMs}`)).toEqual([before.id]);
    expect(await ids(`from=${tokyoMidnightLessOneMs}`)).toEqual([exact.id, before.id]);
    // The same instant written three more ways answers the same rows.
    for (const spelling of [
      '2026-09-12T15:00:00Z',
      '2026-09-12T15:00:00.000Z',
      '2026-09-12T09:30:00-05:30',
    ]) {
      expect(await ids(`from=${encodeURIComponent(spelling)}`)).toEqual([exact.id]);
      expect(await ids(`to=${encodeURIComponent(spelling)}`)).toEqual([exact.id, before.id]);
    }
    // A fractional part is honoured at the millisecond: one ms later excludes the exact run
    // from `from=` and changes nothing for `to=`.
    const nextMs = encodeURIComponent('2026-09-12T15:00:00.001Z');
    expect(await ids(`from=${nextMs}`)).toEqual([]);
    expect(await ids(`to=${nextMs}`)).toEqual([exact.id, before.id]);
  });
});

describe('GET /api/runs', () => {
  it('reads a one- and a two-digit fraction as tenths and hundredths of a second, not as milliseconds', async () => {
    // `parseRunListBound` right-pads the fractional part before reading it as milliseconds, so
    // `.5` and `.50` both mean 500 ms. Dropping the padding would read them as 5 ms and 50 ms —
    // a silent 495 ms shift of the bound, in the direction that serves rows the caller excluded.
    // Three runs, not two: with only `.499` and `.500` the `to=` direction cannot tell 500 ms
    // from 5 ms, because both bounds keep the same pair. The `.005` run is what separates them.
    const base = Date.parse('2026-09-12T15:00:00.000Z');
    const clock = [base + 5, base + 499, base + 500];
    let tick = 0;
    const store = new InMemoryRunStore({
      now: (): Date => {
        const instant = clock[tick];
        if (instant === undefined) throw new Error('the controlled clock was read too many times');
        tick += 1;
        return new Date(instant);
      },
    });
    const harness = install({}, store);
    const fiveMs = await seedRun(harness.store);
    const justBefore = await seedRun(harness.store);
    const atHalf = await seedRun(harness.store);

    const ids = async (query: string): Promise<string[]> =>
      (await listBody(await listRuns(get(`http://web/api/runs?${query}`)))).runs.map(
        (run) => run['id'] as string,
      );
    for (const spelling of ['2026-09-12T15:00:00.5Z', '2026-09-12T15:00:00.50Z']) {
      const bound = encodeURIComponent(spelling);
      // `from` is inclusive at 500 ms, so the run one millisecond before it is out.
      expect(await ids(`from=${bound}`)).toEqual([atHalf.id]);
      // `to` is inclusive at 500 ms too, so all three are in — including the 5 ms run a
      // padding-free reading would have made the only match.
      expect(await ids(`to=${bound}`)).toEqual([atHalf.id, justBefore.id, fiveMs.id]);
    }
  });
});
