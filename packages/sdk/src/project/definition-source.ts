/** A TypeScript string literal: single-quoted, with `\` and `'` escaped. */
export function tsString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** TypeScript the starter files print as it is: an identifier or a call, never text. */
export class Code {
  constructor(readonly code: string) {}
}

/** A value the starter files print: text, a boolean, code, or a list or object of them. */
type PrintedValue =
  string | boolean | Code | readonly PrintedValue[] | { readonly [key: string]: PrintedValue };

/** `Array.isArray` for a readonly list, which it does not narrow. */
function isList(value: PrintedValue): value is readonly PrintedValue[] {
  return Array.isArray(value);
}

/** Prints one value whose first line starts at `indent`; a list or an object spans lines. */
function printValue(value: PrintedValue, indent: string): string {
  if (typeof value === 'string') return tsString(value);
  if (typeof value === 'boolean') return String(value);
  if (value instanceof Code) return value.code;
  if (isList(value)) {
    const items = value.map((item) => `${indent}  ${printValue(item, `${indent}  `)},\n`);
    return `[\n${items.join('')}${indent}]`;
  }
  return `{\n${printProperties(value, `${indent}  `)}${indent}}`;
}

/** Prints an object literal's properties, one per line with a trailing comma, at `indent`. */
function printProperties(entries: Readonly<Record<string, PrintedValue>>, indent: string): string {
  return Object.entries(entries)
    .map(([key, value]) => `${indent}${key}: ${printValue(value, indent)},\n`)
    .join('');
}

/**
 * A starter definition file: the SDK import, a blank line, any local imports and a blank line,
 * any `//` comment lines, and `export default defineX({ … });`.
 */
export function definitionFile(
  define: string,
  properties: Readonly<Record<string, PrintedValue>>,
  imports: { readonly sdk?: readonly string[]; readonly local?: readonly string[] } = {},
  comment: readonly string[] = [],
): string {
  const names = [define, ...(imports.sdk ?? [])].join(', ');
  const local = imports.local ?? [];
  return (
    `import { ${names} } from '@indx-workspace/sdk/define';\n\n` +
    (local.length === 0 ? '' : `${local.join('\n')}\n\n`) +
    comment.map((line) => `// ${line}\n`).join('') +
    `export default ${define}({\n${printProperties(properties, '  ')}});\n`
  );
}
