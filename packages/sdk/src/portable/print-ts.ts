import type { ProjectConnector } from '@indx-workspace/contracts/project-file';

import { toolNameOf } from '../define/agent.js';
import {
  agentFromVersionBody,
  type AgentFromVersionBody,
  type AgentVersionSource,
} from '../define/from-version-body.js';
import {
  isCodeTool,
  isFileGrant,
  isMcpTool,
  isOpenApiTool,
  isPostgresTool,
  isSkillReference,
} from '../define/references.js';

const PRINT_WIDTH = 100;
const SHORT_KEY = 5;
const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';

/** A version body the printer cannot write as a `defineAgent` file. Nothing is dropped silently. */
export class PrintError extends Error {
  override readonly name = 'PrintError';
  /** The path of every part the printer cannot express: a body path, or `toolModules.<module>`. */
  readonly paths: readonly string[];

  constructor(problems: readonly { readonly path: string; readonly reason: string }[]) {
    super(`cannot print as code: ${problems.map((p) => `${p.path}: ${p.reason}`).join('; ')}`);
    this.paths = Object.freeze(problems.map((problem) => problem.path));
  }
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** The words an import cannot bind, and the names the SDK import line may bind. */
const TAKEN = new Set(
  (
    'break case catch class const continue debugger default delete do else enum export extends ' +
    'false finally for function if import in instanceof new null return super switch this throw ' +
    'true try typeof var void while with yield let static await async of ' +
    'implements interface package private protected public eval arguments ' +
    'defineAgent mcp skill files'
  ).split(' '),
);

// ponytail: prettier's string width from the common wide blocks (CJK, Hangul, fullwidth, emoji);
// a long string with another wide character may break one column off. Complete: a width table.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/gu;
const COMBINING = /[\u0300-\u036f]/gu;

function width(text: string): number {
  return [...text.replace(COMBINING, '').replace(WIDE, '  ')].length;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** A string literal the way prettier (`singleQuote`) writes it: the quote needing fewer escapes. */
function literal(text: string): string {
  const singles = text.split(SINGLE_QUOTE).length;
  const doubles = text.split(DOUBLE_QUOTE).length;
  const quote = singles > doubles ? DOUBLE_QUOTE : SINGLE_QUOTE;
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    const code = text.charCodeAt(index);
    const lone =
      (isHighSurrogate(code) && !isLowSurrogate(text.charCodeAt(index + 1))) ||
      (isLowSurrogate(code) && !isHighSurrogate(text.charCodeAt(index - 1)));
    if (char === '\\' || char === quote) out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      lone
    ) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    } else out += char;
  }
  return `${quote}${out}${quote}`;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object written as `{ … }`, not as a helper call or an imported tool. */
function isObjectLiteral(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    isPlainObject(value) &&
    !(
      isMcpTool(value) ||
      isSkillReference(value) ||
      isFileGrant(value) ||
      isOpenApiTool(value) ||
      isPostgresTool(value) ||
      isCodeTool(value)
    )
  );
}

/** `base.key`, or `key` when the path is empty. */
function join(base: string, key: string): string {
  return base === '' ? key : `${base}.${key}`;
}

function unprintable(path: string, reason: string): PrintError {
  return new PrintError([{ path, reason }]);
}

/** Writes values as the TS expression a project keeps, collecting the helpers it calls. */
class Writer {
  readonly helpers = new Set<string>(['defineAgent']);

  /**
   * `identifiers` maps a module tool's name to the identifier its import binds; `connectorPaths`
   * maps a tool's name to its path in the body (`definition.resources.connectors.<n>`).
   */
  constructor(
    private readonly identifiers: ReadonlyMap<string, string>,
    private readonly connectorPaths: ReadonlyMap<string, string>,
  ) {}

  /** The body path of a value written at `path` inside the agent's `defineAgent` input. */
  private bodyPath(path: string): string {
    return join('definition.agent', path);
  }

  /**
   * `name(args)`; when the line would pass the print width, as prettier breaks it: a trailing object
   * argument is hugged (`skill('x', {` … `})`), anything else goes one argument per line.
   */
  private call(
    name: string,
    args: readonly unknown[],
    indent: number,
    column: number,
    path: string,
  ): string {
    this.helpers.add(name);
    const text = args
      .map((arg) => this.argument(arg, indent, column + name.length + 1, path))
      .join(', ');
    const flat = `${name}(${text})`;
    // the value is followed by the `,` of the array or object that holds it
    if (column + width(flat) + 1 <= PRINT_WIDTH) return flat;
    const last = args.at(-1);
    if (args.length > 1 && isObjectLiteral(last)) {
      const head = `${name}(${args
        .slice(0, -1)
        .map((arg) => this.argument(arg, indent, column, path))
        .join(', ')}, {`;
      if (column + width(head) <= PRINT_WIDTH) {
        return `${head}${this.object(Object.entries(last), indent, path).slice(1)})`;
      }
    }
    const pad = ' '.repeat(indent + 2);
    const lines = args.map((arg) => `${pad}${this.argument(arg, indent + 2, indent + 2, path)},`);
    return `${name}(\n${lines.join('\n')}\n${' '.repeat(indent)})`;
  }

  /** A call's argument; an object is written on one line, as prettier keeps `{ revision: 2 }`. */
  private argument(arg: unknown, indent: number, column: number, path: string): string {
    if (!isObjectLiteral(arg)) return this.expr(arg, indent, column, path);
    const entries = Object.entries(arg).map(
      ([key, value]) => `${key}: ${this.expr(value, indent, column, join(path, key))}`,
    );
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }

  /** `column` is where the value starts on its line; a continuation line is indented from `indent`. */
  expr(value: unknown, indent: number, column: number, path: string): string {
    if (typeof value === 'string') return literal(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      return String(value);
    }
    if (Array.isArray(value)) return this.list(value, indent, column, path);
    if (isMcpTool(value)) return this.call('mcp', [value.connector], indent, column, path);
    if (isSkillReference(value)) {
      const args =
        value.revision === undefined ? [value.name] : [value.name, { revision: value.revision }];
      return this.call('skill', args, indent, column, path);
    }
    if (isFileGrant(value)) {
      const args = value.access === 'read' ? [value.path] : [value.path, value.access];
      return this.call('files', args, indent, column, path);
    }
    if (isOpenApiTool(value) || isPostgresTool(value) || isCodeTool(value)) {
      const identifier = this.identifiers.get(toolNameOf(value));
      if (identifier === undefined) {
        throw unprintable(
          this.connectorPaths.get(toolNameOf(value)) ?? this.bodyPath(path),
          'a tool with no module to import it from',
        );
      }
      return identifier;
    }
    if (isObjectLiteral(value)) return this.object(Object.entries(value), indent, path);
    throw unprintable(this.bodyPath(path), `a ${typeof value} has no TS literal`);
  }

  object(entries: readonly (readonly [string, unknown])[], indent: number, path: string): string {
    const kept = entries.filter(([, value]) => value !== undefined);
    if (kept.length === 0) return '{}';
    const inner = indent + 2;
    const lines = kept.map(([key, value]) => {
      const name = IDENTIFIER.test(key) ? key : literal(key);
      const text = this.expr(value, inner, inner + name.length + 2, join(path, key));
      const head = `${' '.repeat(inner)}${name}:`;
      // prettier moves a string that does not fit after its key onto the next line, unless the key
      // is short (under tabWidth + 3 columns).
      return typeof value === 'string' &&
        width(name) >= SHORT_KEY &&
        width(head) + 1 + width(text) + 1 > PRINT_WIDTH
        ? `${head}\n${' '.repeat(inner + 2)}${text},`
        : `${head} ${text},`;
    });
    return `{\n${lines.join('\n')}\n${' '.repeat(indent)}}`;
  }

  private list(items: readonly unknown[], indent: number, column: number, path: string): string {
    if (items.length === 0) return '[]';
    const inner = indent + 2;
    const parts = items.map((item, index) =>
      this.expr(item, inner, inner, join(path, String(index))),
    );
    // prettier always breaks an array of several objects (or arrays) that each hold several entries.
    const forced =
      items.length > 1 &&
      (items.every((item) => isObjectLiteral(item) && Object.keys(item).length > 1) ||
        items.every((item) => Array.isArray(item) && item.length > 1));
    const flat = `[${parts.join(', ')}]`;
    if (!forced && !flat.includes('\n') && column + width(flat) + 1 <= PRINT_WIDTH) return flat;
    const pad = ' '.repeat(inner);
    return `[\n${parts.map((part) => `${pad}${part},`).join('\n')}\n${' '.repeat(indent)}]`;
  }
}

/** What one `import` line binds: a default, and/or `{ … }` names. */
interface ImportClause {
  readonly defaultName?: string;
  readonly names: readonly string[];
}

/** The import line prettier would write for `clause` from `specifier`. */
function importLine(clause: ImportClause, specifier: string): string {
  const from = ` from ${literal(specifier)};`;
  const head = clause.defaultName === undefined ? '' : `${clause.defaultName}, `;
  if (clause.names.length === 0) return `import ${clause.defaultName ?? ''}${from}`;
  const flat = `import ${head}{ ${clause.names.join(', ')} }${from}`;
  if (width(flat) <= PRINT_WIDTH) return flat;
  return `import ${head}{\n${clause.names.map((name) => `  ${name},`).join('\n')}\n}${from}`;
}

/** `my-crm` as `myCrm`, for the identifier a default import is bound to. */
function camelCase(name: string): string {
  const text = name.replace(/[^A-Za-z0-9]+(.)?/gu, (_, next: string | undefined) =>
    (next ?? '').toUpperCase(),
  );
  return /^[A-Za-z]/u.test(text) ? text : `tool${text}`;
}

/**
 * The `import` lines for the tools an agent takes from project modules, and the identifier each
 * tool is bound to. An export keeps its own name unless that is taken (an SDK helper, a keyword or
 * an earlier import), in which case it is imported `as <name>Tool`.
 */
function moduleImports(imports: AgentFromVersionBody['imports']): {
  readonly lines: readonly string[];
  readonly identifiers: ReadonlyMap<string, string>;
} {
  const taken = new Set(TAKEN);
  const identifiers = new Map<string, string>();
  const clauses = new Map<string, { defaultName?: string; names: string[] }>();
  for (const entry of imports) {
    if (
      /[\\%:\p{Cc}\p{Cf}]/u.test(entry.module) ||
      entry.module.split('/').some((part) => ['', '.', '..'].includes(part))
    ) {
      throw unprintable(`toolModules.${entry.module}`, 'must be a project-relative path');
    }
    const preferred =
      entry.exportName !== 'default' && IDENTIFIER.test(entry.exportName)
        ? entry.exportName
        : camelCase(entry.name);
    let local = preferred;
    for (let attempt = 1; taken.has(local); attempt += 1) {
      local = `${preferred}Tool${attempt === 1 ? '' : attempt}`;
    }
    taken.add(local);
    identifiers.set(entry.name, local);
    const clause = clauses.get(entry.module) ?? { names: [] };
    clauses.set(entry.module, clause);
    if (entry.exportName === 'default') clause.defaultName = local;
    else {
      const exported = IDENTIFIER.test(entry.exportName)
        ? entry.exportName
        : literal(entry.exportName);
      clause.names.push(local === exported ? local : `${exported} as ${local}`);
    }
  }
  const lines = [...clauses]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([module, clause]) => importLine(clause, `../${module}`));
  return { lines, identifiers };
}

/**
 * The TS source of one agent file: `export default defineAgent({ … })` with the keys in
 * `DefineAgentInput`'s order and the instructions read from `./<name>.md` beside it, and the
 * `agent-workspace.yaml` connector entries its `mcp()` tools need. The text is prettier-clean
 * (`singleQuote`, `trailingComma: all`, width 100). Module tools are imported from their module
 * (`import { crm } from '../tools/crm.ts'`), never written inline.
 *
 * @throws {PrintError} naming the path of every part of the body `agentFromVersionBody()` could not
 *   write back; nothing is dropped silently.
 * @throws {DefinitionError} when the body, a module's tool or a surface is refused.
 */
export function printDefineAgent(
  source: AgentVersionSource,
  options: { readonly importPath: string },
): { readonly text: string; readonly connectors: Readonly<Record<string, ProjectConnector>> } {
  const { value, dropped } = agentFromVersionBody(source);
  if (dropped.length > 0) throw new PrintError(dropped);
  const { agent } = value;
  const { lines, identifiers } = moduleImports(value.imports);
  const permissions = Object.entries(agent.permissions ?? {}).filter(([, on]) => on === true);
  const connectorPaths = new Map(
    source.body.definition.resources.connectors.map((name, index) => [
      name,
      `definition.resources.connectors.${index}`,
    ]),
  );
  const writer = new Writer(identifiers, connectorPaths);
  const body = writer.object(
    [
      ['name', agent.name],
      ['description', agent.description],
      ['subagents', agent.subagents],
      ['knowledge', agent.knowledge],
      ['instructions', { file: `./${agent.name}.md` }],
      ['model', agent.model],
      ['engine', agent.engine],
      ['permissions', permissions.length === 0 ? undefined : Object.fromEntries(permissions)],
      ['tools', agent.tools?.length === 0 ? undefined : agent.tools],
      ['skills', agent.skills?.length === 0 ? undefined : agent.skills],
      ['files', agent.files],
      ['limits', agent.limits],
    ],
    0,
    '',
  );
  const sdk = importLine({ names: [...writer.helpers].sort() }, options.importPath);
  const imports = lines.length === 0 ? sdk : `${sdk}\n\n${lines.join('\n')}`;
  return {
    text: `${imports}\n\nexport default defineAgent(${body});\n`,
    connectors: value.connectors,
  };
}
