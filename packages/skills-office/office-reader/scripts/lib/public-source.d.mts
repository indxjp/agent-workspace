// Types for the public-source records reader (public-source.mjs), plain JavaScript so it runs with
// Node alone inside a run's sandbox (ADR-0176). Use cases and this package's tests import it through
// these declarations.

/** The environment variable `run_skill_script` names the referenced answer's file in. */
export const TOOL_ANSWER_ENV: 'SKILL_SCRIPT_INPUT';

/** One record: the item's id and its fields. */
export type PublicSourceRecord = { readonly id: string } & Readonly<
  Record<string, string | number | boolean | null>
>;

export interface PublicSourceRecords {
  /** The snapshot's date, or the time of a live read. */
  readonly asOf: string;
  /** Always `false`: a cut answer is refused as `truncated_answer`. */
  readonly truncated: false;
  readonly records: readonly PublicSourceRecord[];
}

/**
 * The text of the tool answer `run_skill_script` handed this call.
 *
 * @throws {import('./table.mjs').TableError} `no_tool_answer` or `unreadable_file`.
 */
export function readToolAnswer(env?: Readonly<Record<string, string | undefined>>): string;

/**
 * The records of a public-source answer, each as its id and its fields.
 *
 * @throws {import('./table.mjs').TableError} `not_public_source`, `truncated_answer`,
 *   `record_without_id`, `duplicate_id` or `duplicate_field`.
 */
export function publicSourceRecords(text: string): PublicSourceRecords;

/** {@link publicSourceRecords} of the answer this call was handed. */
export function readPublicSource(
  env?: Readonly<Record<string, string | undefined>>,
): PublicSourceRecords;
