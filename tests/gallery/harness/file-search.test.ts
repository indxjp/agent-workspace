/**
 * The `search_files` double keeps what the use cases depend on: the platform's own terms and
 * extraction, the contract's query rules, and the grant boundary. The data is the manual-search
 * use case's manuals (PDF and Markdown, Japanese).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createFileSearch } from './file-search.ts';
import { scriptedWorkspace } from './scripted-workspace.ts';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'manual-search', 'data');

interface Hit {
  readonly path: string;
  readonly page: number | null;
  readonly snippet: string;
}

const hitsOf = async (grants: string[], args: Record<string, unknown>): Promise<Hit[]> =>
  JSON.parse((await createFileSearch({ root: DATA, grants }).call(args)).text) as Hit[];

describe('search_files double', () => {
  it('finds Japanese text in a PDF page and its Markdown copy, and cuts a snippet around it', async () => {
    const hits = await hitsOf(['manuals'], { query: '定期点検 周期' });
    expect(hits.map((hit) => hit.path).sort()).toStrictEqual([
      'manuals/hydraulic-unit.md',
      'manuals/hydraulic-unit.pdf',
    ]);
    const pdf = hits.find((hit) => hit.path.endsWith('.pdf'));
    expect(pdf).toMatchObject({ page: 2 });
    expect(pdf?.snippet).toContain('定期点検は 6か月 ごと');
  });

  it('needs every word of the query and answers an empty list for a miss', async () => {
    expect(await hitsOf(['manuals'], { query: '定期点検 社員食堂' })).toStrictEqual([]);
    expect(await hitsOf(['manuals'], { query: '社員食堂' })).toStrictEqual([]);
  });

  it('never searches a file outside the grants', async () => {
    const search = createFileSearch({ root: DATA, grants: ['manuals/safety-rules.pdf'] });
    expect(search.searchablePaths()).toStrictEqual(['manuals/safety-rules.pdf']);
    expect(await hitsOf(['manuals/safety-rules.pdf'], { query: '定期点検 周期' })).toStrictEqual(
      [],
    );
    expect(createFileSearch({ root: DATA, grants: [] }).searchablePaths()).toStrictEqual([]);
  });

  it('refuses a query the route would answer invalid_search_query, as the adapter words it', async () => {
    const search = createFileSearch({ root: DATA, grants: ['manuals'] });
    for (const args of [{ query: '？！' }, { query: '   ' }, {}, { query: '定期点検', limit: 0 }]) {
      expect(await search.call(args), JSON.stringify(args)).toStrictEqual({
        text: 'File search failed (HTTP 400, invalid_search_query).',
        isError: true,
      });
    }
  });

  it('honours the limit', async () => {
    expect(await hitsOf(['manuals'], { query: '定期点検 周期', limit: 1 })).toHaveLength(1);
  });
});

describe('search_files under a run fileScope (issue #1539)', () => {
  it('searches only the narrowed grants, and refuses a scope that widens them', async () => {
    const search = createFileSearch({ root: DATA, grants: ['manuals'] });
    const args = { query: '定期点検 周期' };
    const only = JSON.parse(
      (await search.call(args, { fileScope: ['manuals/hydraulic-unit.md'] })).text,
    ) as Hit[];
    expect(only.map((hit) => hit.path)).toStrictEqual(['manuals/hydraulic-unit.md']);
    const none = JSON.parse(
      (await search.call(args, { fileScope: ['manuals/safety-rules.pdf'] })).text,
    ) as Hit[];
    expect(none).toStrictEqual([]);
    expect(() => search.call(args, { fileScope: ['hr'] })).toThrow(/run_file_scope_not_granted/u);
  });

  it('gives two runs of one agent different views, and a run with no scope the whole grant', async () => {
    const search = createFileSearch({ root: DATA, grants: ['manuals'] });
    const workspace = scriptedWorkspace(
      async ({ builtin, prompt }) => (await builtin('search_files', { query: prompt })).text,
      {},
      { search_files: search.call },
    );
    const pathsOf = async (fileScope?: string[]): Promise<string[]> => {
      const started = await workspace.aw.runs.start(workspace.agentId, {
        prompt: '定期点検 周期',
        ...(fileScope === undefined ? {} : { fileScope }),
      });
      const result = await workspace.aw.runs.result(started.run.id);
      return (JSON.parse(result.text ?? '[]') as Hit[]).map((hit) => hit.path).sort();
    };
    expect(await pathsOf(['manuals/hydraulic-unit.pdf'])).toStrictEqual([
      'manuals/hydraulic-unit.pdf',
    ]);
    expect(await pathsOf(['manuals/hydraulic-unit.md'])).toStrictEqual([
      'manuals/hydraulic-unit.md',
    ]);
    expect(await pathsOf()).toStrictEqual([
      'manuals/hydraulic-unit.md',
      'manuals/hydraulic-unit.pdf',
    ]);
    expect(workspace.runs.map((run) => run.fileScope)).toStrictEqual([
      ['manuals/hydraulic-unit.pdf'],
      ['manuals/hydraulic-unit.md'],
      null,
    ]);
  });
});
