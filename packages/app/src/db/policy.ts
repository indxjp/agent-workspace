/**
 * The decisions both resource stores make the same way (issue #1502): paging, filters, input
 * parsing, the access check of every operation and the agent intersection rule. Pure: the
 * PostgreSQL store and the in-memory store differ only in where the records are kept.
 */
import type { z } from 'zod';

import { allows, isPersonFieldRule, type Person } from '../person.js';
import type { AccessOperation, DefinedResource } from '../resource.js';
import { createInputSchema, updateInputSchema } from '../schemas.js';
import { encodeCursor, readCursor, type KeysetPosition } from './cursor.js';
import { AppStoreError } from './errors.js';
import type { CommittedEvent, OnCommitted, Page } from './port.js';

/** A record's field values by field name, an unset optional field as `null`. */
export type FieldValues = Readonly<Record<string, unknown>>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const QUERY_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The `k` of a resource list's cursors: `<app>.<plural>`, and `<app>.<plural>:search`. */
export function listKeyOf(appName: string, resource: DefinedResource, search = false): string {
  return `${appName}.${resource.plural}${search ? ':search' : ''}`;
}

/** A record id as the stores keep it (lower case), or `undefined` when it is not a UUID. */
export function recordIdOf(id: string): string | undefined {
  return UUID.test(id) ? id.toLowerCase() : undefined;
}

/** How many records a page holds and where it starts. */
export interface PageRequest {
  readonly limit: number;
  readonly after: KeysetPosition | null;
}

/**
 * Reads a page's `limit` and `cursor`.
 *
 * @throws {AppStoreError} `invalid_limit` outside 1–200; `invalid_cursor` for a cursor not minted
 *   for this list in this workspace.
 */
export function pageRequestOf(
  options: { readonly cursor?: string; readonly limit?: number },
  key: string,
  workspaceId: string,
): PageRequest {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppStoreError('invalid_limit');
  }
  if (options.cursor === undefined) return { limit, after: null };
  const read = readCursor(options.cursor, key, workspaceId);
  if (!read.ok) throw new AppStoreError('invalid_cursor');
  return { limit, after: read.position };
}

/** The page of `rows`, fetched as `limit + 1` so the extra row says whether another page follows. */
export function pageOf<R extends { readonly id: string; readonly created_at: string }>(
  rows: readonly R[],
  request: PageRequest,
  key: string,
  workspaceId: string,
): Page<R> {
  const items = rows.slice(0, request.limit);
  const last = items.at(-1);
  const more = rows.length > request.limit && last !== undefined;
  return {
    items,
    nextCursor: more
      ? encodeCursor(key, workspaceId, { createdAt: last.created_at, id: last.id })
      : null,
  };
}

/**
 * The `where` of a list: each key an `enumOf()` field, each value one of its values.
 *
 * @throws {AppStoreError} `invalid_query`, with the offending keys as `details`.
 */
export function filtersOf(
  resource: DefinedResource,
  where: Readonly<Record<string, string>> | undefined,
): readonly (readonly [string, string])[] {
  const entries = Object.entries(where ?? {});
  const refused = entries.flatMap(([key, value]) => {
    const field = Object.hasOwn(resource.fields, key) ? resource.fields[key] : undefined;
    const ok = field?.type === 'enumOf' && field.zod.safeParse(value).success;
    return ok ? [] : [`where.${key}`];
  });
  if (refused.length > 0) throw new AppStoreError('invalid_query', { details: refused });
  return entries.sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * The text of a search.
 *
 * @throws {AppStoreError} `search_unsupported` when the resource declares no search;
 *   `invalid_query` for a blank or overlong text.
 */
export function searchTextOf(resource: DefinedResource, query: string): string {
  if (resource.search.length === 0) throw new AppStoreError('search_unsupported');
  const text = typeof query === 'string' ? query.trim() : '';
  if (text === '' || text.length > QUERY_MAX) {
    throw new AppStoreError('invalid_query', { details: ['q'] });
  }
  return text;
}

/**
 * Who of the workspace may read records: everyone the read rules admit without a record (`all`),
 * or only the people a listed `person()` field names. The stores turn the fields into a predicate,
 * so a page is filtered where it is read and stays full.
 */
export interface ReadScope {
  readonly all: boolean;
  readonly personFields: readonly string[];
}

/**
 * The read scope of `person`.
 *
 * @throws {AppStoreError} `forbidden` when an agent acts for the person and the resource does not
 *   let agents read.
 */
export function readScopeOf(resource: DefinedResource, person: Person): ReadScope {
  if (person.via === 'agent' && !resource.agents.read) {
    throw new AppStoreError('forbidden', { details: ['agents.read'] });
  }
  const rules = resource.access.read;
  return {
    all: allows(
      rules.filter((rule) => !isPersonFieldRule(rule)),
      person,
    ),
    personFields: rules.filter(isPersonFieldRule),
  };
}

/** Whether `row` is inside `scope` for `person`. */
export function isVisible(scope: ReadScope, person: Person, row: FieldValues): boolean {
  return scope.all || scope.personFields.some((field) => row[field] === person.principalId);
}

/**
 * Refuses a write the person may not make to `row` (an existing record, or the record a create
 * would make).
 *
 * @throws {AppStoreError} `forbidden`.
 */
export function assertAllowed(
  operation: Exclude<AccessOperation, 'read'>,
  resource: DefinedResource,
  person: Person,
  row: FieldValues,
): void {
  if (!allows(resource.access[operation], person, row)) throw new AppStoreError('forbidden');
}

/**
 * The agent half of every write: an agent writes only when the resource lists fields agents may
 * write, only those fields, and only in a run. The person's own access is checked as well, by
 * {@link assertAllowed}, so an agent never exceeds the person (narrow, never widen).
 *
 * @throws {AppStoreError} `forbidden`, naming `agents.write`, `run_id` or each `fields:<name>`.
 */
export function assertAgentMayWrite(
  resource: DefinedResource,
  person: Person,
  fields: readonly string[],
): void {
  if (person.via !== 'agent') return;
  const writable = resource.agents.write;
  if (writable === false) throw new AppStoreError('forbidden', { details: ['agents.write'] });
  if (person.runId === undefined || person.runId === '') {
    throw new AppStoreError('forbidden', { details: ['run_id'] });
  }
  const outside = fields.filter((field) => !writable.includes(field));
  if (outside.length > 0) {
    throw new AppStoreError('forbidden', { details: outside.map((field) => `fields:${field}`) });
  }
}

function pathOf(issue: z.core.$ZodIssue): string[] {
  const base = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => (base === '' ? key : `${base}.${key}`));
  }
  return [base === '' ? '$' : base];
}

function parseWith(schema: z.ZodType, input: unknown): Record<string, unknown> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = [...new Set(result.error.issues.flatMap(pathOf))];
    throw new AppStoreError('invalid_body', { details });
  }
  return result.data as Record<string, unknown>;
}

const NEGATIVE_ZERO_AMOUNT = /^-0(?:\.0+)?$/u;

/**
 * A value as both stores keep it, so they read back alike: a time in UTC milliseconds, ids in
 * lower case, no negative zero. These are the normalisations PostgreSQL applies on its own.
 */
function normalised(type: string, value: unknown): unknown {
  if (value === null) return null;
  switch (type) {
    case 'dateTime':
      return new Date(value as string).toISOString();
    case 'number':
      return Object.is(value, -0) ? 0 : value;
    case 'money': {
      const money = value as { amount: string; currency: string };
      return NEGATIVE_ZERO_AMOUNT.test(money.amount)
        ? { ...money, amount: money.amount.slice(1) }
        : money;
    }
    case 'person':
    case 'ref':
      return (value as string).toLowerCase();
    case 'files':
      return (value as string[]).map((id) => id.toLowerCase());
    default:
      return value;
  }
}

function normalisedValues(resource: DefinedResource, values: FieldValues): FieldValues {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      normalised(resource.fields[key]?.type ?? '', value),
    ]),
  );
}

/** The field names `values` sets, in the resource's field order. */
function namedFields(resource: DefinedResource, values: FieldValues): string[] {
  return Object.keys(resource.fields).filter((key) => Object.hasOwn(values, key));
}

/** What a create writes, and the field names its audit row lists. */
export interface PreparedWrite {
  readonly values: FieldValues;
  readonly fields: readonly string[];
}

/**
 * Validates a create for `person`: the agent rule, the body, every default filled in and every
 * unset optional field `null`, then the create rule on the record it would make.
 *
 * @throws {AppStoreError} `invalid_body` or `forbidden`.
 */
export function prepareCreate(
  resource: DefinedResource,
  person: Person,
  input: unknown,
): PreparedWrite {
  assertAgentMayWrite(resource, person, []);
  const parsed = parseWith(createInputSchema(resource), input);
  assertAgentMayWrite(resource, person, namedFields(resource, parsed));
  const values = normalisedValues(
    resource,
    Object.fromEntries(
      Object.entries(resource.fields).map(([key, field]) => [
        key,
        Object.hasOwn(parsed, key) ? parsed[key] : (field.options['default'] ?? null),
      ]),
    ),
  );
  assertAllowed('create', resource, person, values);
  return { values, fields: namedFields(resource, values).filter((key) => values[key] !== null) };
}

/**
 * Validates an update's patch for `person`: the agent rule and the body. The update rule is
 * checked on the stored record, by {@link assertAllowed}.
 *
 * @throws {AppStoreError} `invalid_body` or `forbidden`.
 */
export function prepareUpdate(
  resource: DefinedResource,
  person: Person,
  patch: unknown,
): PreparedWrite {
  assertAgentMayWrite(resource, person, []);
  const parsed = parseWith(updateInputSchema(resource), patch);
  const fields = namedFields(resource, parsed);
  assertAgentMayWrite(resource, person, fields);
  return { values: normalisedValues(resource, parsed), fields };
}

/** Runs `hook` after a committed write, so its failure never reaches the caller of the write. */
export async function notifyCommitted(
  hook: OnCommitted | undefined,
  resource: string,
  event: CommittedEvent,
  row: Readonly<Record<string, unknown>>,
  person: Person,
): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook(resource, event, structuredClone(row), person);
  } catch {
    // The write is committed; the hook is the one to report why it failed (see OnCommitted).
  }
}
