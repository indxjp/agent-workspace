/** The home page's filters (`?cat=&status=&q=`): parsing, applying and writing them back. */
import { describe, expect, it } from 'vitest';

import { CATALOG, COUNTS } from '../../examples/store/catalog/index.ts';
import {
  filterCatalog,
  filterHref,
  parseFilter,
  SEARCH_QUERY_MAX_LENGTH,
  shelvesOf,
} from '../../examples/store/app/browse.ts';

describe('the store filters', () => {
  it('reads the query and ignores what it does not know', () => {
    expect(parseFilter({ cat: 'finance', status: 'live', q: ' ringi ' })).toEqual({
      cat: 'finance',
      status: 'live',
      q: 'ringi',
    });
    expect(parseFilter({ cat: 'nope', status: 'all', q: ['a', 'b'] })).toEqual({
      cat: null,
      status: null,
      q: 'a',
    });
    expect(parseFilter({})).toEqual({ cat: null, status: null, q: '' });
  });

  it('keeps at most SEARCH_QUERY_MAX_LENGTH characters of the search', () => {
    expect(SEARCH_QUERY_MAX_LENGTH).toBe(120);
    const long = 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 30);
    expect(parseFilter({ q: long }).q).toBe('a'.repeat(SEARCH_QUERY_MAX_LENGTH));
  });

  it('shows every entry when nothing is filtered, on a shelf per area', () => {
    const none = parseFilter({});
    expect(filterCatalog(CATALOG, none)).toHaveLength(COUNTS.total);
    expect(shelvesOf(CATALOG, none)).toHaveLength(COUNTS.areas);
  });

  it('filters by status to the live and the coming-soon counts', () => {
    expect(filterCatalog(CATALOG, parseFilter({ status: 'live' }))).toHaveLength(COUNTS.live);
    expect(filterCatalog(CATALOG, parseFilter({ status: 'soon' }))).toHaveLength(COUNTS.soon);
  });

  it('filters by area to one shelf of that area’s entries', () => {
    const shelves = shelvesOf(CATALOG, parseFilter({ cat: 'finance' }));
    expect(shelves.map(({ area }) => area.id)).toEqual(['finance']);
    expect(shelves[0]?.entries).toHaveLength(COUNTS.byArea.finance.total);
  });

  it('searches names and summaries in either language, every word, width-insensitive', () => {
    const ringi = filterCatalog(CATALOG, parseFilter({ q: '稟議' }));
    expect(ringi.map((entry) => entry.slug)).toContain('ringi-review');
    expect(filterCatalog(CATALOG, parseFilter({ q: 'RINGI review' })).map((e) => e.slug)).toContain(
      'ringi-review',
    );
    expect(filterCatalog(CATALOG, parseFilter({ q: 'ringi zzzzzz' }))).toEqual([]);
  });

  it('combines filters and writes them back as a link', () => {
    const filter = parseFilter({ cat: 'finance', status: 'live', q: 'ringi' });
    expect(filterCatalog(CATALOG, filter).map((entry) => entry.slug)).toEqual(['ringi-review']);
    expect(
      parseFilter(Object.fromEntries(new URL(filterHref(filter), 'http://x').searchParams)),
    ).toEqual(filter);
    expect(filterHref(parseFilter({}))).toBe('/');
  });
});
