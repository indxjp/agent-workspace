import { describe, expect, it } from 'vitest';

import { executeFileSearch, fileSearchSetup } from './file-search.js';

const link = { baseUrl: 'https://control.example', token: 'run-token' };
const request = (readFiles: boolean) => ({
  sessionId: 'sess-1',
  portable: { permissions: { readFiles } },
});

describe('fileSearchSetup', () => {
  it('is offered with readFiles and a control plane link, and not otherwise', () => {
    expect(fileSearchSetup(request(true), link)).toEqual({ ...link, sessionId: 'sess-1' });
    expect(fileSearchSetup(request(false), link)).toBeNull();
    expect(fileSearchSetup(request(true), undefined)).toBeNull();
  });
});

describe('executeFileSearch', () => {
  const setup = { ...link, sessionId: 'sess-1' };

  it('calls the run route with the run bearer and maps hits to path, page and snippet', async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const doFetch = (input: string, init?: RequestInit): Promise<Response> => {
      seen.push({
        url: input,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Promise.resolve(
        Response.json({
          hits: [{ path: 'manuals/a.pdf', page: 3, snippet: 'the pump', score: 0.5 }],
          pending: 2,
        }),
      );
    };
    const result = await executeFileSearch(setup, { query: 'pump', limit: 5 }, undefined, doFetch);
    expect(seen).toEqual([
      {
        url: 'https://control.example/api/sessions/sess-1/file-search?q=pump&limit=5',
        authorization: 'Bearer run-token',
      },
    ]);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('[{"path":"manuals/a.pdf","page":3,"snippet":"the pump"}]');
    expect(result.text).toContain('2 files are still being read');
  });

  it('reports a refusal or an unreachable control plane as a tool error, not a throw', async () => {
    const refused = () => Promise.resolve(new Response('{}', { status: 403 }));
    expect(await executeFileSearch(setup, { query: 'x' }, undefined, refused)).toEqual({
      text: 'File search failed (HTTP 403).',
      isError: true,
    });
    const badQuery = () =>
      Promise.resolve(
        Response.json(
          { error: { code: 'invalid_search_query', message: 'No searchable term.' } },
          { status: 400 },
        ),
      );
    expect(await executeFileSearch(setup, { query: '!!' }, undefined, badQuery)).toEqual({
      text: 'File search failed (HTTP 400, invalid_search_query).',
      isError: true,
    });
    const down = () => Promise.reject(new Error('ECONNREFUSED'));
    expect((await executeFileSearch(setup, { query: 'x' }, undefined, down)).isError).toBe(true);
  });
});
