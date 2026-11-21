/**
 * What a live card may say about how it was verified (spec, "Real-model verification gate (R1)"):
 * "verified with the scripted model" until its entry has a passed real-model record, and never
 * "live" without one. The rule is `cardVerification`; the evidence is `real-model-runs.json`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAINTENANCE_FETCH_TIMEOUT_MS,
  maintenanceSlugs,
  tryChoice,
  verificationLabel,
} from '../../examples/store/app/verification.ts';
import { RECORDINGS } from '../../examples/store/catalog/recordings.generated.ts';
import { CATALOG } from '../../examples/store/catalog/index.ts';
import {
  REAL_MODEL_EVIDENCE,
  cardState,
  cardVerification,
  realModelEvidenceSchema,
  type RealModelRun,
} from '../../examples/store/catalog/verification.ts';

const LIVE = CATALOG.filter((entry) => entry.status === 'live').map((entry) => entry.slug);
const [FIRST, SECOND] = LIVE;
if (FIRST === undefined || SECOND === undefined)
  throw new Error('the catalog needs two live entries');

const record = (entry: string, date: string, result: 'pass' | 'fail'): RealModelRun => ({
  entry,
  runId: `run-${date}`,
  date,
  result,
  reason: result === 'pass' ? 'the moment happened' : 'a tool did not run',
  environment: 'staging',
  sourceHash: 'a'.repeat(64),
});

const kinds = (runs: readonly RealModelRun[]) =>
  Object.fromEntries(LIVE.map((slug) => [slug, cardVerification(slug, runs).kind]));

describe('the committed evidence', () => {
  it('parses, and every record names a live entry', () => {
    const file = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../examples/store/catalog/real-model-runs.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as unknown;
    const parsed = realModelEvidenceSchema.parse(file);
    expect(parsed).toEqual(REAL_MODEL_EVIDENCE);
    for (const run of parsed.runs) expect(LIVE).toContain(run.entry);
  });

  it('flips exactly the entries whose latest committed record passed', () => {
    const latest = new Map<string, RealModelRun>();
    for (const run of REAL_MODEL_EVIDENCE.runs) {
      const seen = latest.get(run.entry);
      if (seen === undefined || seen.date < run.date) latest.set(run.entry, run);
    }
    const passed = LIVE.filter((slug) => latest.get(slug)?.result === 'pass');
    const states = kinds(REAL_MODEL_EVIDENCE.runs);
    expect(LIVE.filter((slug) => states[slug] === 'real-model')).toEqual(passed);
  });
});

describe('a live card', () => {
  it('is verified with the scripted model, and its label never says real Claude, until a record passed', () => {
    expect(new Set(Object.values(kinds([])))).toEqual(new Set(['scripted-model']));
    const committed = kinds(REAL_MODEL_EVIDENCE.runs);
    for (const slug of LIVE.filter((other) => committed[other] === 'scripted-model')) {
      expect(verificationLabel(slug, 'en')).toBe('Verified with the scripted model');
      expect(verificationLabel(slug, 'ja')).not.toContain('Claude');
    }
  });

  it('flips exactly the entry whose record passed', () => {
    const states = kinds([record(FIRST, '2026-12-01T00:00:00.000Z', 'pass')]);
    expect(states[FIRST]).toBe('real-model');
    for (const slug of LIVE.filter((other) => other !== FIRST)) {
      expect(states[slug]).toBe('scripted-model');
    }
  });

  it('carries the passed run and its date', () => {
    expect(cardVerification(FIRST, [record(FIRST, '2026-12-01T00:00:00.000Z', 'pass')])).toEqual({
      kind: 'real-model',
      runId: 'run-2026-12-01T00:00:00.000Z',
      date: '2026-12-01T00:00:00.000Z',
    });
  });

  it('is not flipped by a failed record', () => {
    expect(cardVerification(FIRST, [record(FIRST, '2026-12-01T00:00:00.000Z', 'fail')]).kind).toBe(
      'scripted-model',
    );
  });

  it('reverts when a later run failed, whatever order the records are in, and returns with a later pass', () => {
    const passed = record(FIRST, '2026-12-01T00:00:00.000Z', 'pass');
    const failed = record(FIRST, '2026-12-08T00:00:00.000Z', 'fail');
    const passedAgain = record(FIRST, '2026-12-15T00:00:00.000Z', 'pass');
    expect(cardVerification(FIRST, [passed, failed]).kind).toBe('scripted-model');
    expect(cardVerification(FIRST, [failed, passed]).kind).toBe('scripted-model');
    expect(cardVerification(FIRST, [passed, failed, passedAgain]).kind).toBe('real-model');
    // Another entry's failure does not touch this card.
    expect(
      cardVerification(FIRST, [passed, record(SECOND, '2026-12-08T00:00:00.000Z', 'fail')]).kind,
    ).toBe('real-model');
  });
});

describe('a card under maintenance', () => {
  const passed = record(FIRST, '2026-12-01T00:00:00.000Z', 'pass');

  it('says "Under maintenance" in both languages, whatever its verification kind', () => {
    expect(cardState(FIRST, [FIRST], []).kind).toBe('maintenance');
    expect(cardState(FIRST, [FIRST], [passed]).kind).toBe('maintenance');
    expect(verificationLabel(FIRST, 'en', [FIRST])).toBe('Under maintenance');
    expect(verificationLabel(FIRST, 'ja', [FIRST])).toBe('メンテナンス中');
  });

  it('touches only the entries listed, and an empty list changes nothing', () => {
    expect(cardState(SECOND, [FIRST], [passed]).kind).toBe('scripted-model');
    expect(cardState(FIRST, [], [passed])).toEqual(cardVerification(FIRST, [passed]));
    expect(verificationLabel(SECOND, 'en', [FIRST])).toBe(verificationLabel(SECOND, 'en'));
    expect(verificationLabel(SECOND, 'en', [FIRST])).not.toBe('Under maintenance');
  });
});

describe('the maintenance list the store reads', () => {
  const answering = (answer: () => Promise<Response>) => {
    vi.stubGlobal('fetch', answer);
    return maintenanceSlugs('https://platform.example.test');
  };
  afterEach(() => vi.unstubAllGlobals());

  it('is the platform’s list when it answers the contract', async () => {
    expect(await answering(() => Promise.resolve(Response.json({ maintenance: [FIRST] })))).toEqual(
      [FIRST],
    );
  });

  it('is empty when the platform hangs: the request carries a timeout and its abort is caught', async () => {
    const hanging = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    vi.useFakeTimers();
    // Node arms `AbortSignal.timeout` on its own internal timer, which fake timers do not replace,
    // so it is rebuilt here on the faked `setTimeout`: the abort then fires when the fake clock
    // passes the timeout instead of after three real seconds. The production call is unchanged.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      }, ms);
      return controller.signal;
    });
    try {
      let settled = false;
      const pending = answering(hanging as () => Promise<Response>).finally(() => {
        settled = true;
      });
      expect(timeout).toHaveBeenCalledWith(MAINTENANCE_FETCH_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(MAINTENANCE_FETCH_TIMEOUT_MS - 1);
      expect(settled, 'the request gave up before its timeout').toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual([]);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('is empty, and the card unchanged, when the platform cannot say', async () => {
    expect(await answering(() => Promise.reject(new Error('down')))).toEqual([]);
    expect(await answering(() => Promise.resolve(Response.json({ wrong: 1 })))).toEqual([]);
    expect(await answering(() => Promise.resolve(new Response('no', { status: 500 })))).toEqual([]);
  });
});

describe('the Try it section for an entry under maintenance', () => {
  it('shows the unavailable fallback with the entry’s recording, and the live demo otherwise', () => {
    const recorded = RECORDINGS.find((recording) => recording.lang === 'en');
    expect(recorded).toBeDefined();
    const slug = recorded?.slug ?? '';
    expect(tryChoice(slug, [slug], RECORDINGS, 'en')).toEqual({
      kind: 'unavailable',
      recording: recorded,
    });
    expect(tryChoice(slug, [], RECORDINGS, 'en')).toEqual({ kind: 'live' });
    expect(tryChoice(slug, ['other'], RECORDINGS, 'en')).toEqual({ kind: 'live' });
  });
});
