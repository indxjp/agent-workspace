import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { caseRuns, PLACEHOLDER_KEY, sessionFetch, writeTranscripts } from './run-evals.mjs';

const BASE = 'http://127.0.0.1:8333';
const COOKIE = 'aw_session=signed.token';

/** A `fetch` that answers 204 and keeps what it was asked. */
function recording() {
  const seen: { headers: Headers; method: string | undefined }[] = [];
  const base = (_input: string | URL | Request, init?: RequestInit) => {
    seen.push({ headers: new Headers(init?.headers), method: init?.method });
    return Promise.resolve(new Response(null, { status: 204 }));
  };
  return {
    seen,
    ownerFetch: sessionFetch(base, { baseUrl: BASE, cookie: COOKIE }),
  };
}

describe('sessionFetch', () => {
  it('sends the Owner session and the origin in place of the placeholder key', async () => {
    const { seen, ownerFetch } = recording();
    await ownerFetch(`${BASE}/api/agents/x/evaluation-runs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${PLACEHOLDER_KEY}`, accept: 'application/json' },
    });
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.headers.get('authorization')).toBeNull();
    expect(request?.headers.get('cookie')).toBe(COOKIE);
    expect(request?.headers.get('origin')).toBe(BASE);
    expect(request?.headers.get('accept')).toBe('application/json');
  });

  it('sends the session on a request with no credential', async () => {
    const { seen, ownerFetch } = recording();
    await ownerFetch(new URL('/api/runs/r/events', BASE));
    expect(seen[0]?.headers.get('cookie')).toBe(COOKIE);
  });

  it('refuses another origin and another credential, sending nothing', async () => {
    const { seen, ownerFetch } = recording();
    await expect(ownerFetch('https://elsewhere.example/api/agents')).rejects.toThrow(
      /elsewhere\.example/u,
    );
    await expect(
      ownerFetch(`${BASE}/api/agents`, { headers: { authorization: 'Bearer aw_real' } }),
    ).rejects.toThrow(/another credential/u);
    expect(seen).toEqual([]);
  });
});

describe('caseRuns', () => {
  it('keeps the cases that started a run, in report order', () => {
    expect(
      caseRuns({
        results: [
          { name: 'a', runId: 'r1' },
          { name: 'b', runId: null },
          { name: 'c', runId: 'r3' },
        ],
      }),
    ).toEqual([
      { name: 'a', runId: 'r1' },
      { name: 'c', runId: 'r3' },
    ]);
  });
});

describe('writeTranscripts', () => {
  it("writes each run's frames, and the error of one that could not be read", async () => {
    const dir = path.join(await mkdtemp(path.join(tmpdir(), 'transcripts-')), 'transcripts');
    const client = {
      runs: {
        async *events(runId: string) {
          await Promise.resolve();
          yield { kind: 'runtime', id: '1', name: 'message', data: { runId } };
          if (runId === 'bad') throw new Error('the event stream ended before a "done" frame');
        },
      },
    };
    const incomplete = await writeTranscripts(
      client,
      [
        { name: 'first', runId: 'good' },
        { name: 'second', runId: 'bad' },
      ],
      dir,
    );
    expect(incomplete).toEqual(['bad']);
    expect((await readdir(dir)).sort()).toEqual(['bad.json', 'good.json']);
    const good: unknown = JSON.parse(await readFile(path.join(dir, 'good.json'), 'utf8'));
    expect(good).toEqual({
      case: 'first',
      runId: 'good',
      frames: [{ kind: 'runtime', id: '1', name: 'message', data: { runId: 'good' } }],
    });
    const bad = JSON.parse(await readFile(path.join(dir, 'bad.json'), 'utf8')) as {
      readonly case: string;
      readonly error: string;
    };
    expect(bad.case).toBe('second');
    expect(bad.error).toMatch(/done/u);
  });
});
