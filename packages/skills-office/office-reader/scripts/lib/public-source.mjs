// The records of a public-source tool's answer (ADR-0170), for a use case's own skill script
// (ADR-0176). The agent does not copy the answer into the script's arguments: it calls
// `run_skill_script` with `input: { fromToolUse: "<the public-source call's id>" }`, the engine
// writes that call's answer, as the model received it, into a file the script may only read, and
// names the file in SKILL_SCRIPT_INPUT. Plain JavaScript that runs with Node alone in a run's
// sandbox; an entry imports it as
// `@indx-workspace/builtin-skills/office-reader/scripts/lib/public-source.mjs`.
//
// It never guesses: an answer that is not the public-source tool's shape, a cut answer
// (`truncated: true`), a record without an id, a repeated id and a field named `id` are each a
// TableError, which `cli.mjs` prints as `{ error, message }` with exit code 1.
import { readFileSync } from 'node:fs';
import process from 'node:process';

import { TableError } from './table.mjs';

/** The environment variable `run_skill_script` names the referenced answer's file in. */
export const TOOL_ANSWER_ENV = 'SKILL_SCRIPT_INPUT';

/** A date (`2026-11-21`) or a date and time with its offset, as the answer's dates are written. */
const DATE_OR_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/u;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const ANSWER_KEYS = new Set(['mode', 'asOf', 'notice', 'truncated', 'records']);
const ITEM_KEYS = new Set([
  'id',
  'source',
  'url',
  'title',
  'summary',
  'publishedAt',
  'retrievedAt',
  'fields',
]);

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const isDate = (value) => isText(value) && DATE_OR_DATE_TIME.test(value);
const isScalar = (value) =>
  value === null ||
  isText(value) ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value));

const notAnswer = (reason) =>
  new TableError('not_public_source', `the tool answer is not a public-source answer: ${reason}`);

/**
 * The text of the tool answer `run_skill_script` handed this call: the file named in
 * {@link TOOL_ANSWER_ENV}.
 *
 * @param {Readonly<Record<string, string | undefined>>} [env] the process environment
 * @throws {TableError} `no_tool_answer`: the call named no earlier tool call; `unreadable_file`.
 */
export function readToolAnswer(env = process.env) {
  const file = env[TOOL_ANSWER_ENV];
  if (file === undefined || file === '')
    throw new TableError(
      'no_tool_answer',
      'this script reads the answer of an earlier tool call: call run_skill_script with input: { fromToolUse: "<that call\'s id>" }',
    );
  try {
    return readFileSync(file, 'utf8');
  } catch {
    throw new TableError('unreadable_file', 'the tool answer handed to this script cannot be read');
  }
}

/** One item checked against the answer's item shape, as `{ id, ...fields }`. */
function recordOf(item, index) {
  const where = `record ${index + 1}`;
  if (!isRecord(item)) throw notAnswer(`${where} is not an object`);
  const unknown = Object.keys(item).find((key) => !ITEM_KEYS.has(key));
  if (unknown !== undefined)
    throw notAnswer(`${where} has an unknown key ${JSON.stringify(unknown)}`);
  const { id, source, url, title, summary, publishedAt, retrievedAt, fields = {} } = item;
  if (![source, url, title, summary].every(isText) || !isDate(retrievedAt))
    throw notAnswer(`${where} lacks its source, url, title, summary or retrievedAt`);
  if (publishedAt !== null && !isDate(publishedAt))
    throw notAnswer(`${where} has a publishedAt that is not a date`);
  if (!isRecord(fields)) throw notAnswer(`${where} has fields that are not an object`);
  for (const [name, value] of Object.entries(fields)) {
    if (!FIELD_NAME.test(name) || !isScalar(value))
      throw notAnswer(`${where} has a field ${JSON.stringify(name)} that is not a named scalar`);
  }
  if (!isText(id) || id === '')
    throw new TableError(
      'record_without_id',
      `${where} (${JSON.stringify(title)}) has no id, so the script cannot name it`,
      { row: index + 1 },
    );
  if (Object.hasOwn(fields, 'id'))
    throw new TableError('duplicate_field', `record ${JSON.stringify(id)} has a field named id`, {
      row: index + 1,
      column: 'id',
    });
  return Object.fromEntries([['id', id], ...Object.entries(fields)]);
}

/**
 * The records of a public-source answer (`PublicSourceAnswerSchema`), each as its id and its fields.
 *
 * @param {string} text the answer's text, as the tool returned it
 * @returns {{ asOf: string, truncated: false, records: Record<string, string | number | boolean | null>[] }}
 * @throws {TableError} `not_public_source`, `truncated_answer`, `record_without_id`, `duplicate_id`
 *   or `duplicate_field`.
 */
export function publicSourceRecords(text) {
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    throw notAnswer('it is not JSON');
  }
  if (!isRecord(answer)) throw notAnswer('it is not an object');
  const unknown = Object.keys(answer).find((key) => !ANSWER_KEYS.has(key));
  if (unknown !== undefined) throw notAnswer(`it has an unknown key ${JSON.stringify(unknown)}`);
  const { mode, asOf, notice, truncated, records } = answer;
  if (
    (mode !== 'snapshot' && mode !== 'live') ||
    !isDate(asOf) ||
    !isText(notice) ||
    typeof truncated !== 'boolean' ||
    !Array.isArray(records)
  )
    throw notAnswer('it lacks its mode, asOf, notice, truncated flag or records');
  if (truncated)
    throw new TableError(
      'truncated_answer',
      `more records answered than the tool returned (${records.length}): narrow the query or raise its limit, so no record is silently left out`,
    );
  const read = records.map(recordOf);
  const seen = new Set();
  read.forEach((record, index) => {
    if (seen.has(record.id))
      throw new TableError('duplicate_id', `two records have the id ${JSON.stringify(record.id)}`, {
        row: index + 1,
        value: record.id,
      });
    seen.add(record.id);
  });
  return { asOf, truncated: false, records: read };
}

/**
 * {@link publicSourceRecords} of the answer this call was handed ({@link readToolAnswer}).
 *
 * @param {Readonly<Record<string, string | undefined>>} [env] the process environment
 */
export function readPublicSource(env = process.env) {
  return publicSourceRecords(readToolAnswer(env));
}
