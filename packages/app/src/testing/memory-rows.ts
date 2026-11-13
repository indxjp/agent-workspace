/** The pure row helpers the in-memory stores share: ordering, paging position, copying, search. */
import type { DefinedResource } from '../resource.js';
import type { PageRequest } from '../db/policy.js';

/** A kept row: its values, its id and the time it was made, which order every list. */
export type KeyedRow = Record<string, unknown> & {
  readonly id: string;
  readonly created_at: string;
};

/** What a list orders by: an id and the time it was made. */
interface Keyed {
  readonly id: string;
  readonly created_at: string;
}

const WORD = /[\p{L}\p{N}]+/gu;

function wordsOf(value: unknown): string[] {
  if (typeof value === 'string') return value.toLowerCase().match(WORD) ?? [];
  if (Array.isArray(value)) return value.flatMap(wordsOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(wordsOf);
  return [];
}

export function matchesSearch(resource: DefinedResource, row: KeyedRow, text: string): boolean {
  const words = new Set(resource.search.flatMap((field) => wordsOf(row[field])));
  const terms = text.split(/\s+/u).filter((term) => term !== '');
  const wanted = terms.filter((term) => !term.startsWith('-')).flatMap(wordsOf);
  const unwanted = terms.filter((term) => term.startsWith('-')).flatMap(wordsOf);
  return (
    wanted.length > 0 &&
    wanted.every((word) => words.has(word)) &&
    !unwanted.some((word) => words.has(word))
  );
}

/** Newest first; equal times by id, descending, as PostgreSQL orders `uuid`. */
export function newestFirst(a: Keyed, b: Keyed): number {
  const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether `row` comes after the cursor of `request`, newest first. */
export function isAfter(row: Keyed, request: PageRequest): boolean {
  const after = request.after;
  if (after === null) return true;
  const byTime = Date.parse(row.created_at) - Date.parse(after.createdAt);
  return byTime < 0 || (byTime === 0 && row.id < after.id);
}

/** A deep copy, so a caller cannot change what a store keeps. */
export function copyOf<T>(value: T): T {
  return structuredClone(value);
}
