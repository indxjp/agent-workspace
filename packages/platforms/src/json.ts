const JSON_STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
const STRING_ARRAY = new RegExp(
  String.raw`\[\n\s*(${JSON_STRING}(?:,\n\s*${JSON_STRING})*)\n\s*\]`,
  'gu',
);

/**
 * Two-space JSON with string-only arrays on one line, so committed goldens are Prettier-stable.
 */
// ponytail: assumes a collapsed array fits in 100 columns (true for the emitted files); Prettier-stable goldens are the guard.
export function prettyJson(value: unknown): string {
  const text = JSON.stringify(value, null, 2).replace(STRING_ARRAY, (_, items: string) => {
    return `[${items.replaceAll(/,\n\s*/gu, ', ')}]`;
  });
  return `${text}\n`;
}
