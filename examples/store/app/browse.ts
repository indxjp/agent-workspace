/**
 * What the home page shows for the filters in its URL (`?cat=&status=&q=`): parsed, applied to the
 * catalog and written back as a link. Pure, and it reads only the catalog, so `pnpm test` covers it.
 */
import { AREAS, type AreaId, type CatalogEntry } from '../catalog/index.ts';

/** `live` is the "Try now" filter, `soon` the coming-soon one. */
export type StatusFilter = 'live' | 'soon';

export interface Filter {
  readonly cat: AreaId | null;
  readonly status: StatusFilter | null;
  readonly q: string;
}

export type Query = Readonly<Record<string, string | readonly string[] | undefined>>;

/** The longest search the home page keeps; a longer `q` is cut to this many characters. */
export const SEARCH_QUERY_MAX_LENGTH = 120;

const first = (value: Query[string]): string | undefined =>
  typeof value === 'string' ? value : value?.[0];

/** The filter a query names; an unknown area or status is ignored, never an error. */
export function parseFilter(query: Query): Filter {
  const cat = first(query['cat']);
  const status = first(query['status']);
  return {
    cat: AREAS.find(({ id }) => id === cat)?.id ?? null,
    status: status === 'live' || status === 'soon' ? status : null,
    q: (first(query['q']) ?? '').trim().slice(0, SEARCH_QUERY_MAX_LENGTH),
  };
}

const fold = (text: string): string => text.normalize('NFKC').toLowerCase();

/** Whether every word of `q` is in the entry's slug, name, summary or area, in either language. */
function matchesSearch(entry: CatalogEntry, q: string): boolean {
  const area = AREAS.find(({ id }) => id === entry.area);
  const haystack = fold(
    [
      entry.slug,
      entry.name.ja,
      entry.name.en,
      entry.summary.ja,
      entry.summary.en,
      area?.name.ja,
      area?.name.en,
    ].join(' '),
  );
  return fold(q)
    .split(/\s+/u)
    .filter((word) => word !== '')
    .every((word) => haystack.includes(word));
}

export function filterCatalog(entries: readonly CatalogEntry[], filter: Filter): CatalogEntry[] {
  return entries.filter(
    (entry) =>
      (filter.cat === null || entry.area === filter.cat) &&
      (filter.status === null || entry.status === filter.status) &&
      matchesSearch(entry, filter.q),
  );
}

/** One shelf per area that still has an entry after filtering, in the store's area order. */
export function shelvesOf(entries: readonly CatalogEntry[], filter: Filter) {
  const kept = filterCatalog(entries, filter);
  return AREAS.map((area) => ({
    area,
    entries: kept.filter((entry) => entry.area === area.id),
  })).filter(({ entries: inArea }) => inArea.length > 0);
}

/** The home page's address for `filter`; with no filter, `/`. */
export function filterHref(filter: Filter): string {
  const params = new URLSearchParams();
  if (filter.cat !== null) params.set('cat', filter.cat);
  if (filter.status !== null) params.set('status', filter.status);
  if (filter.q !== '') params.set('q', filter.q);
  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}

export const isFiltered = (filter: Filter): boolean =>
  filter.cat !== null || filter.status !== null || filter.q !== '';
