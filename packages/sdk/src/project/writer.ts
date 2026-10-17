import { isScalar, parseDocument } from 'yaml';

import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
import { PROJECT_FILE_NAME } from './reader.js';
import { YAML_OPTIONS } from './yaml-options.js';

/** One value {@link writeProjectFileText} writes plain: text, a finite number or a boolean. */
type ProjectFileScalar = string | number | boolean;

/**
 * What {@link writeProjectFileText} writes: a mapping of text, finite numbers, booleans, lists of
 * those or of non-empty mappings, and further mappings (an empty one is written `{}` as a key's
 * value), up to 32 levels deep. A list never holds a list. A list of mappings is an eval file's
 * `cases:` (issue #620).
 */
export type ProjectFileMapping = {
  readonly [key: string]:
    ProjectFileScalar | readonly (ProjectFileScalar | ProjectFileMapping)[] | ProjectFileMapping;
};

/** YAML's limit on an implicit block mapping key, in characters; a longer key does not read back. */
const MAX_KEY_LENGTH = 1024;

/** How deep the written mappings may nest. The project file needs a handful of levels. */
const MAX_DEPTH = 32;

function refuse(path: string, message: string): never {
  const issue: ProjectRenderIssue = { path, message };
  throw new ProjectRenderError(PROJECT_FILE_NAME, [issue]);
}

/** Whether `value` has a C0 or C1 control character, or a Unicode line or paragraph separator. */
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });
}

/**
 * Whether `text`, written plain, reads back as `expected` under the core schema. Asking the parser
 * rather than listing YAML's indicators is what keeps `true`, `null`, `1.0`, `~`, `has # hash` and
 * `[bracket` from being written as something else.
 */
function readsBack(text: string, expected: ProjectFileScalar): boolean {
  const document = parseDocument(text, YAML_OPTIONS);
  return (
    document.errors.length === 0 &&
    document.warnings.length === 0 &&
    isScalar(document.contents) &&
    document.contents.value === expected
  );
}

/**
 * Quote only where the plain form would read back as something else. Keeping the common case
 * unquoted is what lets the rendered file match the examples the documentation prints. A value
 * with a control character takes the double-quoted form, whose escapes are JSON's.
 */
function writeScalar(value: string): string {
  // A line break or a tab cannot survive the plain or single-quoted form unchanged.
  if (hasControlCharacter(value)) return JSON.stringify(value);
  if (readsBack(value, value)) return value;
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A number as it reads back: an unsafe integer would read back rounded, and NaN or an infinity has
 * no form the core schema reads as the same number.
 */
function writeNumber(value: number, path: string): string {
  if (Number.isInteger(value) && !Number.isSafeInteger(value))
    refuse(path, 'must be a safe integer');
  const text = String(value);
  if (!Number.isFinite(value) || !readsBack(text, value)) refuse(path, 'must be a finite number');
  return text;
}

/** The written form of a scalar at `path`, or `undefined` when `value` is not one. */
function writeValue(value: unknown, path: string): string | undefined {
  if (typeof value === 'string') return writeScalar(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return writeNumber(value, path);
  return undefined;
}

/** A plain object: one whose prototype is `Object.prototype` or `null`, so never an array. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The dotted path of `key` under `prefix`, the root's prefix being the empty string. */
function childPath(prefix: string, key: string): string {
  return prefix === '' ? key : `${prefix}.${key}`;
}

/**
 * Appends `items` as a block sequence one level under `indent`; an empty list is written `[]` on
 * the key's own line, which `written` already holds. A mapping item starts on its dash line and
 * continues two spaces past the dash.
 */
function writeList(
  items: readonly unknown[],
  written: string,
  indent: string,
  path: string,
  depth: number,
  lines: string[],
): void {
  if (items.length === 0) {
    lines.push(`${written} []`);
    return;
  }
  lines.push(written);
  items.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    const text = writeValue(item, itemPath);
    if (text !== undefined) {
      lines.push(`${indent}  - ${text}`);
      return;
    }
    if (!isPlainObject(item) || Object.keys(item).length === 0) {
      refuse(itemPath, 'a list item must be text, a number, a boolean or a non-empty mapping');
    }
    const itemLines: string[] = [];
    writeMapping(item, `${indent}    `, itemPath, depth + 1, itemLines);
    const [first = '', ...rest] = itemLines;
    lines.push(`${indent}  - ${first.trimStart()}`, ...rest);
  });
}

/**
 * Appends `mapping`'s lines at `indent`, refusing — before anything is returned — every value the
 * canonical form cannot write so that it reads back the same: anything but text, a finite number,
 * a boolean, a list of those or a plain object (an empty one as a key's value is written `{}`).
 */
function writeMapping(
  mapping: Readonly<Record<string, unknown>>,
  indent: string,
  prefix: string,
  depth: number,
  lines: string[],
): void {
  if (depth > MAX_DEPTH) refuse(prefix, `must nest at most ${MAX_DEPTH} mappings deep`);
  for (const [key, value] of Object.entries(mapping)) {
    const path = childPath(prefix, key);
    if (key.length > MAX_KEY_LENGTH) {
      refuse(path, `a key must be at most ${MAX_KEY_LENGTH} characters`);
    }
    const written = `${indent}${writeScalar(key)}:`;
    const text = writeValue(value, path);
    if (text !== undefined) {
      lines.push(`${written} ${text}`);
    } else if (Array.isArray(value)) {
      writeList(value, written, indent, path, depth, lines);
    } else if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${written} {}`);
        continue;
      }
      lines.push(written);
      writeMapping(value, `${indent}  `, path, depth + 1, lines);
    } else {
      refuse(path, 'must be text, a number, a boolean, a list of those or a non-empty mapping');
    }
  }
}

/**
 * Writes a project file in the canonical form `readProjectFileText` reads back: each
 * header line as a `#` comment, then the mapping in block style, two spaces per level.
 *
 * @throws {ProjectRenderError} when the input has a value the form cannot hold: an integer that is
 * not safe, NaN or an infinity, a value that is not text, a number, a boolean, a list of those or a
 * mapping, a list item that is a list or an empty mapping, a key longer than 1024 characters,
 * mappings nested deeper than 32, or a header line with a line break or another control character.
 * A {@link ProjectFileMapping} is checked at compile time; an eval case's `toolInput`, which the
 * contract types as `unknown` values, is checked here at run time.
 */
export function writeProjectFileText(
  document: ProjectFileMapping | Readonly<Record<string, unknown>>,
  header: readonly string[] = [],
): string {
  const input: unknown = document;
  if (!isPlainObject(input)) refuse('(root)', 'must be a mapping');
  const headerInput: unknown = header;
  if (!Array.isArray(headerInput)) refuse('(header)', 'must be a list of lines');
  const lines = headerInput.map((comment: unknown, index) => {
    if (typeof comment !== 'string' || hasControlCharacter(comment)) {
      refuse(`(header).${index}`, 'must be one line of text with no control character');
    }
    return comment === '' ? '#' : `# ${comment}`;
  });
  writeMapping(input, '', '', 1, lines);
  return `${lines.join('\n')}\n`;
}
