/** Name a value in an error message without stringifying something huge or throwing on a cycle. */
export function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  // The `typeof` tests are repeated rather than hoisted into a variable so TypeScript narrows
  // `value` for the `String()` call; a hoisted `const t = typeof value` does not narrow, and
  // stringifying an un-narrowed `unknown` is how '[object Object]' ends up in an error message.
  if (typeof value === 'number') return `the number ${String(value)}`;
  if (typeof value === 'boolean') return `the boolean ${String(value)}`;
  if (typeof value === 'bigint') return `the bigint ${String(value)}`;
  return `a value of type ${typeof value}`;
}
