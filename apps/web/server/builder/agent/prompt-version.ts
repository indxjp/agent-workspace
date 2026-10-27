/**
 * Where the Builder's prompt version is recorded: the shipped version's summary, because an agent
 * definition has no metadata field. Pure, so the `aw-control` door can read a run's prompt version
 * without loading the definition (which reads `prompt.md` from disk).
 */

/** Bump on every `prompt.md` change; the CI evals key on it. */
export const BUILDER_PROMPT_VERSION = '2';

const SHIPPED_SUMMARY_PREFIX = 'Shipped Builder, prompt v';

export const BUILDER_SHIPPED_SUMMARY = `${SHIPPED_SUMMARY_PREFIX}${BUILDER_PROMPT_VERSION}`;

/** The prompt version a version summary records, or `null` for any summary not made by this module. */
export function builderPromptVersionOf(summary: string): string | null {
  if (!summary.startsWith(SHIPPED_SUMMARY_PREFIX)) return null;
  const version = summary.slice(SHIPPED_SUMMARY_PREFIX.length);
  return /^\d+$/.test(version) ? version : null;
}
