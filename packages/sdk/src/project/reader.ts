/**
 * The text form of `agent-workspace.yaml`, read by a real YAML parser (`yaml`, core schema) and
 * then held to a closed set of constructs.
 *
 * The project file decides where an environment's database, bucket, key service and identity
 * provider live, so a reader that silently *mis*-understands a developer's file would point an
 * environment at the wrong store — the exact failure the file exists to prevent. Parsing is
 * therefore left to a maintained YAML 1.2 implementation, and everything YAML allows that could
 * make one file mean two things is refused rather than interpreted:
 *
 * - anchors and aliases, a value written once and read in two places;
 * - a tag other than the core schema's own (`!!str`, `!!int`, `!!float`, `!!bool`, `!!null`,
 *   `!!map`, `!!seq`), and any `%TAG` or `%YAML` directive;
 * - a duplicate key, which YAML readers resolve differently;
 * - a second document in the same file;
 * - a key that is not text;
 * - anything the parser itself reports as an error or a warning (tabs in indentation included);
 * - collections nested more than 32 levels deep.
 *
 * Every refusal names the line and the column, and `ProjectFileReading.locate` lets a schema do
 * the same for the fields it refuses, at any depth. Whether a value has the right *shape* is the
 * schema's question, not this module's.
 *
 * The reader moved here from the CLI so that `aw` and `agent-workspace` read one file one way
 * (`docs/adr/0103-…`). `docs/adr/0089-…` records the parser choice and this list.
 */
import {
  Composer,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  Parser,
  type ParsedNode,
} from 'yaml';
import type { z } from 'zod';

import { YAML_OPTIONS } from './yaml-options.js';

/** A one-based line and column in the file's text. */
export interface ProjectFilePosition {
  readonly line: number;
  readonly column: number;
}

/** What {@link readProjectFileText} returns, before any schema sees the value. */
export interface ProjectFileReading {
  /** The document's root, as plain objects, arrays and core-schema scalars. */
  readonly value: unknown;
  /**
   * Where a dotted path's deepest existing key or sequence item is written, so a schema refusal can
   * name its line. A path that leaves the document at its first segment resolves to the start of the document.
   */
  readonly locate: (path: readonly string[]) => ProjectFilePosition;
}

/** The project file's name; the reader names it in its refusals unless the caller names another. */
export const PROJECT_FILE_NAME = 'agent-workspace.yaml';

/**
 * A refusal of `agent-workspace.yaml` (or of the file `label` names, such as `evals/<agent>.yaml`):
 * by the reader, before any field has been looked at, or by a schema, at the field it refused. The
 * message always begins `<label> line L, column C: `.
 */
export class ProjectFileError extends Error {
  override readonly name = 'ProjectFileError';
  readonly line: number;
  readonly column: number;
  /** The dotted path of the refused field when a schema refused it; `undefined` for the reader. */
  readonly path: string | undefined;

  constructor(
    position: ProjectFilePosition,
    detail: string,
    path?: string,
    label: string = PROJECT_FILE_NAME,
  ) {
    super(`${label} line ${position.line}, column ${position.column}: ${detail}`);
    this.line = position.line;
    this.column = position.column;
    this.path = path;
  }
}

/** The shorthand tags of the YAML 1.2 core schema; every other tag is refused. */
const CORE_TAGS: ReadonlySet<string> = new Set([
  '!!str',
  '!!int',
  '!!float',
  '!!bool',
  '!!null',
  '!!map',
  '!!seq',
]);

/** A source token of the parser's concrete syntax tree that carries an offset. */
interface OffsetToken {
  readonly type: string;
  readonly offset: number;
  readonly source: string;
}

function isOffsetToken(value: unknown): value is OffsetToken {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<keyof OffsetToken, unknown>>;
  return (
    typeof candidate.type === 'string' &&
    typeof candidate.offset === 'number' &&
    typeof candidate.source === 'string'
  );
}

/**
 * Every anchor, alias, non-core tag and directive in the concrete syntax tree. The tree is walked
 * generically rather than shape by shape, so a construct nested in a flow collection or a
 * block scalar's header is found as surely as one at the top level.
 */
function* refusedTokens(node: unknown): Generator<OffsetToken> {
  if (Array.isArray(node)) {
    for (const item of node) yield* refusedTokens(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  if (isOffsetToken(node)) {
    if (node.type === 'anchor' || node.type === 'alias' || node.type === 'directive') yield node;
    if (node.type === 'tag' && !CORE_TAGS.has(node.source)) yield node;
  }
  for (const child of Object.values(node)) yield* refusedTokens(child);
}

/** How deep the file's collections may nest. The project file needs a handful of levels. */
const MAX_NESTING_DEPTH = 32;

/** The concrete-syntax-tree token types that open a collection, one nesting level each. */
const COLLECTION_TOKEN_TYPES: ReadonlySet<string> = new Set([
  'block-map',
  'block-seq',
  'flow-collection',
]);

/** A collection token of the concrete syntax tree. Unlike a source token it has no `source`. */
interface CollectionToken {
  readonly type: string;
  readonly offset: number;
}

function isCollectionToken(value: object): value is CollectionToken {
  const candidate = value as Partial<Record<keyof CollectionToken, unknown>>;
  return (
    typeof candidate.type === 'string' &&
    COLLECTION_TOKEN_TYPES.has(candidate.type) &&
    typeof candidate.offset === 'number'
  );
}

/**
 * The first collection nested deeper than {@link MAX_NESTING_DEPTH}, found without recursion so
 * that no depth of input can exhaust the stack. Every later step recurses, so it runs first.
 */
function firstTooDeep(tokens: readonly unknown[]): CollectionToken | undefined {
  const pending: { readonly node: unknown; readonly depth: number }[] = tokens.map((node) => ({
    node,
    depth: 0,
  }));
  let found: CollectionToken | undefined;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node } = next;
    if (typeof node !== 'object' || node === null) continue;
    let depth = next.depth;
    if (isCollectionToken(node)) {
      depth += 1;
      if (depth > MAX_NESTING_DEPTH) {
        if (found === undefined || node.offset < found.offset) found = node;
        continue;
      }
    }
    const children: readonly unknown[] = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) pending.push({ node: child, depth });
  }
  return found;
}

function refusedTokenDetail(token: OffsetToken, label: string): string {
  if (token.type === 'anchor' || token.type === 'alias') {
    return `an ${token.type} is not accepted in ${label}; write the value out in full`;
  }
  if (token.type === 'directive') return `a directive is not accepted in ${label}`;
  return (
    `the tag ${token.source} is not accepted in ${label}; only the core schema's ` +
    `${[...CORE_TAGS].join(', ')} are accepted`
  );
}

/** One reason to refuse the document, at the offset it begins. */
interface Refusal {
  readonly offset: number;
  readonly detail: string;
}

/** Define rather than assign, so a key named `__proto__` is a key and never a prototype. */
function defineEntry(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Reads the file's text into the untrusted value a schema then validates. `label` is the file the
 * refusals name: `agent-workspace.yaml` unless another file is read with the same rules.
 *
 * @throws {ProjectFileError} at the earliest construct the file may not use.
 */
export function readProjectFileText(
  text: string,
  label: string = PROJECT_FILE_NAME,
): ProjectFileReading {
  const lineCounter = new LineCounter();
  const position = (offset: number): ProjectFilePosition => {
    const { line, col } = lineCounter.linePos(offset);
    return { line, column: col };
  };

  const tokens = Array.from(new Parser(lineCounter.addNewLine).parse(text));
  const tooDeep = firstTooDeep(tokens);
  if (tooDeep !== undefined) {
    throw new ProjectFileError(
      position(tooDeep.offset),
      `${label} may nest at most ${MAX_NESTING_DEPTH} levels deep`,
      undefined,
      label,
    );
  }
  // `forceDoc` makes an empty or comment-only file one empty document rather than none, so its
  // stream-level errors still have a document to arrive on.
  const documents = Array.from(new Composer(YAML_OPTIONS).compose(tokens, true, text.length));

  const contents = documents[0]?.contents ?? null;
  const keyRefusals: Refusal[] = [];
  const toValue = (node: ParsedNode | null): unknown => {
    // An alias is refused from the syntax tree, with its own position; it is never followed.
    if (node === null || isAlias(node)) return null;
    if (isScalar(node)) return node.value;
    if (isSeq(node)) return node.items.map((item) => toValue(item));
    const mapping: Record<string, unknown> = {};
    for (const pair of node.items) {
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== 'string') {
        keyRefusals.push({ offset: key?.range[0] ?? node.range[0], detail: 'a key must be text' });
        continue;
      }
      if (Object.hasOwn(mapping, key.value)) {
        keyRefusals.push({
          offset: key.range[0],
          detail: `duplicate key ${JSON.stringify(key.value)}`,
        });
        continue;
      }
      defineEntry(mapping, key.value, toValue(pair.value));
    }
    return mapping;
  };
  const value = toValue(contents);

  // Every reason is gathered and the earliest one reported, so the developer is sent to the first
  // line that needs fixing whichever check happens to notice it. The sort is stable and a refused
  // construct is listed first, so at one offset its message wins over the parser's own.
  const refusals: Refusal[] = [
    ...keyRefusals,
    ...Array.from(refusedTokens(tokens), (token) => ({
      offset: token.offset,
      detail: refusedTokenDetail(token, label),
    })),
    ...documents.flatMap((document) =>
      [...document.errors, ...document.warnings].map((problem) => ({
        offset: problem.pos[0],
        detail: problem.message,
      })),
    ),
    ...documents.slice(1).map((extra) => ({
      offset: extra.range[0],
      detail: `a second document is not accepted in ${label}; the file holds exactly one`,
    })),
  ];
  const [first] = refusals.toSorted((left, right) => left.offset - right.offset);
  if (first !== undefined) {
    throw new ProjectFileError(position(first.offset), first.detail, undefined, label);
  }

  const start = contents === null ? { line: 1, column: 1 } : position(contents.range[0]);
  return {
    value,
    locate: (path) => {
      let found = start;
      let node: ParsedNode | null = contents;
      for (const segment of path) {
        if (isSeq(node)) {
          const item = node.items[Number(segment)];
          if (item === undefined) break;
          found = position(item.range[0]);
          node = item;
          continue;
        }
        if (!isMap(node)) break;
        const pair = node.items.find((item) => isScalar(item.key) && item.key.value === segment);
        if (pair === undefined || !isScalar(pair.key)) break;
        found = position(pair.key.range[0]);
        node = pair.value;
      }
      return found;
    },
  };
}

/** The first issue a schema raised, located at the field (or unknown key) it names. */
export function schemaRefusal(
  reading: ProjectFileReading,
  error: z.ZodError,
  fallback: string,
  label?: string,
): ProjectFileError {
  const [issue] = error.issues;
  if (issue === undefined) {
    return new ProjectFileError(reading.locate([]), fallback, undefined, label);
  }
  const path = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') {
    const [key] = issue.keys;
    if (key !== undefined) path.push(key);
  }
  const dotted = path.length === 0 ? '(root)' : path.join('.');
  return new ProjectFileError(reading.locate(path), `${dotted} ${issue.message}`, dotted, label);
}
