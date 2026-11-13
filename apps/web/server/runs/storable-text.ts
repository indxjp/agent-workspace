/**
 * Make text PostgreSQL can store. `text` and `jsonb` refuse U+0000, and `jsonb` also refuses an
 * unpaired UTF-16 surrogate (a half of an emoji cut by a truncation, or a lone `\ud800` escape a
 * model wrote). Callers that must keep going with whatever they were handed use this instead of
 * failing the whole write; callers that must refuse use the detectors in
 * `sessions/transcript.ts` and `agent-versions/pipeline.ts`.
 */

/** What replaces each character that cannot be stored; visible, so the loss is not silent. */
const REPLACEMENT = '\uFFFD';

/** A UTF-16 surrogate without its partner. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` with every U+0000 and every unpaired surrogate replaced by U+FFFD. */
export function storableText(text: string): string {
  return text.replaceAll('\u0000', REPLACEMENT).replace(UNPAIRED_SURROGATE, REPLACEMENT);
}

/** Nesting beyond this is returned as it is: the database refuses it on its own terms. */
const MAX_DEPTH = 128;

/**
 * A copy of the JSON-shaped `value` in which every string and every object key went through
 * {@link storableText}. Anything that is not an array or a plain object is returned unchanged.
 */
export function storableJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return storableText(value);
  if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => storableJson(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[storableText(key)] = storableJson(item, depth + 1);
  }
  return copy;
}
