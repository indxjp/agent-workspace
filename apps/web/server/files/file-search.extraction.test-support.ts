import { describe, expect, it } from 'vitest';
import { file, createSearchFixture } from './file-search.index.test-support';
import { searchFiles } from './search';

describe('searchFiles', () => {
  it(
    'extracts on demand, finds Japanese text, and does not extract again',
    extractsDemandFindsJapaneseTextDoesNotExtract,
  );

  it('answers null for a query with no searchable term', answersNullQueryNoSearchableTerm);

  it(
    'declares what the budget left undone, and a retry converges',
    declaresWhatBudgetLeftUndoneRetryConverges,
  );

  it('extracts again when a file changes', extractsAgainWhenFileChanges);

  it(
    'records a marker for an unsupported or unparseable file and never retries it',
    recordsMarkerUnsupportedUnparseableFileNeverRetriesIt,
  );

  it(
    'restricts a run to its granted folders, and extracts only those',
    restrictsRunGrantedFoldersExtractsOnlyThose,
  );

  describe('.attachments/ (surface visitors’ uploads, issue #1575)', () => {
    const SID = '44444444-4444-4444-8444-444444444444';
    const scan = `.attachments/${SID}/u1/scan.txt`;
    const query = { query: 'zebracorn', limit: 10 };

    it('never extracts or returns a reserved file in a whole-workspace search', async () => {
      const { open, texts, put, catalog, cached } = await createSearchFixture([
        file(scan, 'zebracorn invoice'),
        file(`.ATTACHMENTS/${SID}/u2/other.txt`, 'zebracorn receipt'),
      ]);
      await put();
      const result = await searchFiles({ open, texts, catalog }, { ...query, grants: null });
      expect(result?.hits).toEqual([]);
      expect(cached.size).toBe(0);
    });

    it('still finds the same word in an ordinary file', async () => {
      const { open, texts, put, catalog } = await createSearchFixture([
        file(scan, 'zebracorn invoice'),
        file('notes/zoo.txt', 'zebracorn sighting'),
      ]);
      await put();
      const result = await searchFiles({ open, texts, catalog }, { ...query, grants: null });
      expect(result?.hits.map((hit) => hit.path)).toEqual(['notes/zoo.txt']);
    });

    it('lets a run search the attachment its grants name', async () => {
      const { open, texts, put, catalog } = await createSearchFixture([
        file(scan, 'zebracorn invoice'),
        file(`.attachments/${SID}/u2/other.txt`, 'zebracorn receipt'),
      ]);
      await put();
      const result = await searchFiles({ open, texts, catalog }, { ...query, grants: [scan] });
      expect(result?.hits.map((hit) => hit.path)).toEqual([scan]);
    });
  });
});

async function extractsDemandFindsJapaneseTextDoesNotExtract() {
  const files = [file('manuals/pump.txt', '保守手順書 第3章')];
  const { open, texts, put, catalog } = await createSearchFixture(files);
  await put();
  const first = await searchFiles(
    { open, texts, catalog },
    { query: '手順', limit: 10, grants: null },
  );
  expect(first?.hits.map((hit) => hit.path)).toEqual(['manuals/pump.txt']);
  expect(first?.hits[0]?.snippet).toContain('手順');
  expect(first?.pending).toBe(0);
  expect(await texts.listStale()).toEqual([]);
}

async function answersNullQueryNoSearchableTerm() {
  const { open, texts, catalog } = await createSearchFixture([]);
  await expect(
    searchFiles({ open, texts, catalog }, { query: '&|!', limit: 10, grants: null }),
  ).resolves.toBeNull();
}

async function declaresWhatBudgetLeftUndoneRetryConverges() {
  const files = [file('a.txt', 'pump'), file('b.txt', 'pump'), file('c.txt', 'pump')];
  const { open, texts, put, catalog } = await createSearchFixture(files);
  await put();
  const run = () =>
    searchFiles({ open, texts, catalog, budget: 2 }, { query: 'pump', limit: 10, grants: null });
  expect((await run())?.pending).toBe(1);
  const second = await run();
  expect(second?.pending).toBe(0);
  expect(second?.hits).toHaveLength(3);
}

async function extractsAgainWhenFileChanges() {
  const files = [file('a.txt', 'alpha')];
  const { open, texts, put, catalog } = await createSearchFixture(files);
  await put();
  const deps = { open, texts, catalog };
  await searchFiles(deps, { query: 'alpha', limit: 10, grants: null });
  const changed = files[0];
  if (changed === undefined) throw new Error('unreachable');
  changed.body = 'bravo';
  changed.version = 2;
  await put();
  expect((await searchFiles(deps, { query: 'bravo', limit: 10, grants: null }))?.hits).toHaveLength(
    1,
  );
  expect((await searchFiles(deps, { query: 'alpha', limit: 10, grants: null }))?.hits).toHaveLength(
    0,
  );
}

async function recordsMarkerUnsupportedUnparseableFileNeverRetriesIt() {
  const files = [
    file('photo.png', 'x', 'image/png'),
    file('broken.pdf', 'not a pdf', 'application/pdf'),
  ];
  const { open, texts, put, catalog, cached } = await createSearchFixture(files);
  await put();
  const result = await searchFiles(
    { open, texts, catalog },
    { query: 'x', limit: 10, grants: null },
  );
  expect(result).toEqual({ hits: [], pending: 0 });
  expect(cached.get('photo.png')?.passages).toEqual([{ page: null, text: '', terms: '' }]);
  expect(cached.get('broken.pdf')?.passages).toEqual([{ page: null, text: '', terms: '' }]);
  expect(await texts.listStale()).toEqual([]);
}

async function restrictsRunGrantedFoldersExtractsOnlyThose() {
  const files = [file('manuals/a.txt', 'pump'), file('hr/b.txt', 'pump')];
  const { open, texts, put, catalog, cached } = await createSearchFixture(files);
  await put();
  const result = await searchFiles(
    { open, texts, catalog },
    { query: 'pump', limit: 10, grants: ['manuals'] },
  );
  expect(result?.hits.map((hit) => hit.path)).toEqual(['manuals/a.txt']);
  expect(cached.has('hr/b.txt')).toBe(false);
}
