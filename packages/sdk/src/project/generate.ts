/**
 * The generators' pure half (issue #1505): the `name:type` field grammar of
 * `aw generate resource`, the code each field becomes, and the placeholder values of the `app`,
 * `resource` and `agent` template directories, and since issue #1514 the `--on` grammar and the
 * values of the `recipe` template, and since issue #1519 the `channel` template and its route
 * edits. `aw` and `create` render through these, so the
 * same arguments give the same files; writing them, and recording them in `aw-generated.json`,
 * is the caller's job.
 *
 * The field types are the app kit's builders (`@indx-workspace/app`), named here because the SDK
 * may not import the app kit; a parity test in the app kit holds the two lists equal.
 */
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';

import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
import { renderTemplateDirectory, type ProjectFile } from './template.js';

/** The app kit's field builders, one per field type, in the order its field table lists them. */
export const GENERATOR_FIELD_TYPES = Object.freeze([
  'text',
  'richText',
  'number',
  'money',
  'bool',
  'date',
  'dateTime',
  'enumOf',
  'person',
  'ref',
  'files',
  'tags',
] as const);

/** One of {@link GENERATOR_FIELD_TYPES}: the builder a field is written with. */
export type GeneratorFieldType = (typeof GENERATOR_FIELD_TYPES)[number];

/**
 * One parsed `name:type` argument. `args` are the parenthesised arguments as written (already
 * validated for the type): `text`'s maximum, `number`'s minimum and maximum, `money`'s currency,
 * `enumOf`'s values, `ref`'s resource.
 */
export interface FieldSpec {
  readonly name: string;
  readonly type: GeneratorFieldType;
  readonly args: readonly string[];
  readonly optional: boolean;
}

/** The placeholder values of one template directory, keyed as its `{{key}}` tokens. */
export type TemplateValues = Readonly<Record<string, string>>;

/** The kinds of page `aw generate page` writes. */
export const GENERATOR_PAGE_KINDS = Object.freeze(['dashboard', 'list', 'custom'] as const);

/** One of {@link GENERATOR_PAGE_KINDS}. */
export type GeneratorPageKind = (typeof GENERATOR_PAGE_KINDS)[number];

/**
 * The template directories under `templates/`: one per generator, the resource's pages (written
 * by `generate resource` with the same values as `resource`), and one per page kind.
 */
export type GeneratorTemplate =
  | 'app'
  | 'resource'
  | 'resource-pages'
  | 'agent'
  | 'recipe'
  | 'channel'
  | `page/${GeneratorPageKind}`;

/** A lowercase snake_case name: every resource, field and enum value becomes a SQL identifier. */
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/u;
/** PostgreSQL's identifier limit; the names are ASCII, so bytes and characters agree. */
const IDENTIFIER_MAX = 63;
/** The app's data lives in the schema `app_<name>`, which must fit {@link IDENTIFIER_MAX}. */
const APP_NAME_MAX = IDENTIFIER_MAX - 'app_'.length;
/** The app kit's limits a generated field must stay within (`text()`, `enumOf()`, a resource). */
const TEXT_MAX_LIMIT = 100_000;
const ENUM_MAX_VALUES = 100;
const RESOURCE_MAX_FIELDS = 100;
/** The columns every resource table has, which no field may be named (the app kit's list). */
const RESERVED_FIELD_NAMES: readonly string[] = [
  'id',
  'workspace_id',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
];
/**
 * The words a resource name may not be: the generated route files bind the resource to a
 * variable of its own name, and these are not identifiers in a strict-mode module.
 */
const RESERVED_WORDS: readonly string[] = [
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
];
/** A page's route segment: lower-case words joined by `-` or `_`, as `open-tickets`. */
const PAGE_NAME = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
/** The longest page name: a manifest entry's name. */
const PAGE_NAME_MAX = 64;
/** The route segments a page may not take: `app/api/` holds the generated routes. */
const RESERVED_PAGE_NAMES: readonly string[] = ['api'];
/** The id a generated test puts in a `person()` or `ref()` field. */
const SAMPLE_ID = '00000000-0000-4000-8000-000000000001';

/** `name:type`, `name:type(args)`, either with a trailing `?` for an optional field. */
const FIELD_ARGUMENT = /^([^:]*):([A-Za-z]+)(?:\((.*)\))?(\?)?$/su;

/** How one CLI spelling parses: its builder, whether it takes arguments, and how they check. */
interface FieldRule {
  readonly type: GeneratorFieldType;
  readonly parentheses: 'none' | 'optional' | 'required';
  readonly usage: string;
  /** The refusal of `args`, or `undefined` when they are valid. */
  readonly check?: (args: readonly string[]) => string | undefined;
}

const integerIn = (text: string, min: number, max: number): number | undefined => {
  if (!/^-?\d+$/u.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
};

const checkText = (args: readonly string[]): string | undefined =>
  args.length === 1 && integerIn(args[0] ?? '', 1, TEXT_MAX_LIMIT) !== undefined
    ? undefined
    : `the maximum must be one whole number from 1 to ${String(TEXT_MAX_LIMIT)}`;

const checkNumber = (args: readonly string[]): string | undefined => {
  const [min, max] = args.map((arg) =>
    integerIn(arg, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
  );
  if (args.length !== 2 || min === undefined || max === undefined) {
    return 'the bounds must be two whole numbers, the minimum then the maximum';
  }
  return min <= max ? undefined : 'the minimum must not be greater than the maximum';
};

const checkMoney = (args: readonly string[]): string | undefined =>
  args.length === 1 && /^[A-Z]{3}$/u.test(args[0] ?? '')
    ? undefined
    : 'the currency must be one ISO 4217 code such as JPY';

const checkEnum = (args: readonly string[]): string | undefined => {
  if (args.length === 0 || args.every((arg) => arg === '')) {
    return 'an enum needs at least one value';
  }
  if (args.length > ENUM_MAX_VALUES) return `an enum has at most ${String(ENUM_MAX_VALUES)} values`;
  const bad = args.find((arg) => !isSnakeCase(arg));
  if (bad !== undefined) return `the value "${bad}" must be snake_case`;
  return new Set(args).size === args.length ? undefined : 'the values must be unique';
};

const checkRef = (args: readonly string[]): string | undefined =>
  args.length === 1 && isSnakeCase(args[0] ?? '')
    ? undefined
    : 'the resource it refers to must be one snake_case name';

/** The CLI spelling of each field type. `enum` is the one that differs from its builder. */
const FIELD_RULES: Readonly<Record<string, FieldRule>> = Object.freeze({
  text: { type: 'text', parentheses: 'optional', usage: 'text or text(max)', check: checkText },
  richText: { type: 'richText', parentheses: 'none', usage: 'richText' },
  number: {
    type: 'number',
    parentheses: 'optional',
    usage: 'number or number(min,max)',
    check: checkNumber,
  },
  money: { type: 'money', parentheses: 'required', usage: 'money(JPY)', check: checkMoney },
  bool: { type: 'bool', parentheses: 'none', usage: 'bool' },
  date: { type: 'date', parentheses: 'none', usage: 'date' },
  dateTime: { type: 'dateTime', parentheses: 'none', usage: 'dateTime' },
  enum: { type: 'enumOf', parentheses: 'required', usage: 'enum(a,b,…)', check: checkEnum },
  person: { type: 'person', parentheses: 'none', usage: 'person' },
  ref: { type: 'ref', parentheses: 'required', usage: 'ref(resource)', check: checkRef },
  files: { type: 'files', parentheses: 'none', usage: 'files' },
  tags: { type: 'tags', parentheses: 'none', usage: 'tags' },
} satisfies Record<string, FieldRule>);

function isSnakeCase(name: string): boolean {
  return SNAKE_CASE.test(name) && name.length <= IDENTIFIER_MAX;
}

/** Why `name` cannot be a field's name, or `undefined` when it can. */
function fieldNameRefusal(name: string): string | undefined {
  if (!isSnakeCase(name)) {
    return `the field name "${name}" must be snake_case, 1-${String(IDENTIFIER_MAX)} characters`;
  }
  return RESERVED_FIELD_NAMES.includes(name)
    ? `the field name "${name}" is reserved for a column every resource has (${RESERVED_FIELD_NAMES.join(', ')})`
    : undefined;
}

/** Why the type part of an argument is refused, or `undefined` when it is valid. */
function typeRefusal(rule: FieldRule, args: string | undefined): string | undefined {
  if (args === undefined) {
    return rule.parentheses === 'required' ? `write it as ${rule.usage}` : undefined;
  }
  if (rule.parentheses === 'none') return `${rule.usage} takes no arguments`;
  return rule.check?.(splitArgs(args));
}

function splitArgs(args: string): readonly string[] {
  return args.trim() === '' ? [] : args.split(',').map((arg) => arg.trim());
}

/** The issues of one argument, or its spec. */
function readFieldSpec(argument: string): FieldSpec | ProjectRenderIssue[] {
  const match = FIELD_ARGUMENT.exec(argument);
  if (match === null) {
    return [
      {
        path: argument,
        message: 'must be name:type, such as title:text or status:enum(new,closed)',
      },
    ];
  }
  const [, name = '', spelling = '', args, optional] = match;
  const rule = Object.hasOwn(FIELD_RULES, spelling) ? FIELD_RULES[spelling] : undefined;
  const reasons = [
    fieldNameRefusal(name),
    rule === undefined
      ? `the type "${spelling}" is not one of ${Object.keys(FIELD_RULES).join(', ')}`
      : typeRefusal(rule, args),
  ].filter((reason) => reason !== undefined);
  if (rule === undefined || reasons.length > 0) {
    return reasons.map((message) => ({ path: argument, message }));
  }
  return Object.freeze({
    name,
    type: rule.type,
    args: Object.freeze(args === undefined ? [] : splitArgs(args)),
    optional: optional === '?',
  });
}

/**
 * Parses one `aw generate resource` field argument: `title:text`, `title:text(200)`,
 * `count:number(0,10)`, `amount:money(JPY)`, `done:bool`, `due:date`, `at:dateTime`,
 * `status:enum(new,closed)`, `owner:person`, `parent:ref(ticket)`, `notes:richText`,
 * `attachments:files` or `labels:tags`; a trailing `?` makes the field optional.
 *
 * @returns The spec, frozen.
 * @throws {ProjectRenderError} listing every reason the argument is refused; each issue's path is
 *   the argument as written.
 */
export function parseFieldSpec(argument: string): FieldSpec {
  const read = readFieldSpec(argument);
  if (Array.isArray(read)) throw new ProjectRenderError('the field', read);
  return read;
}

/**
 * Parses every field argument of one resource, refusing a repeated name as well as each bad
 * argument, all at once.
 *
 * @throws {ProjectRenderError} listing every refused argument; each path is the argument.
 */
export function parseFieldSpecs(argumentList: readonly string[]): readonly FieldSpec[] {
  const issues: ProjectRenderIssue[] = [];
  const specs: FieldSpec[] = [];
  const seen = new Set<string>();
  for (const argument of argumentList) {
    const read = readFieldSpec(argument);
    if (Array.isArray(read)) {
      issues.push(...read);
    } else if (seen.has(read.name)) {
      issues.push({ path: argument, message: `repeats the field "${read.name}"` });
    } else {
      seen.add(read.name);
      specs.push(read);
    }
  }
  if (issues.length > 0) throw new ProjectRenderError('the fields', issues);
  return Object.freeze(specs);
}

function optionsObject(parts: readonly string[]): string {
  return parts.length === 0 ? '' : `{ ${parts.join(', ')} }`;
}

/** The builder call of one spec, without the field name. */
function builderCall(spec: FieldSpec): string {
  const optional = spec.optional ? ['optional: true'] : [];
  const [first = '', second = ''] = spec.args;
  switch (spec.type) {
    case 'text':
      return `text(${optionsObject([...(spec.args.length === 0 ? [] : [`max: ${first}`]), ...optional])})`;
    case 'number':
      return `number(${optionsObject([...(spec.args.length === 0 ? [] : [`min: ${first}`, `max: ${second}`]), ...optional])})`;
    case 'money':
      return `money(${optionsObject([`currency: '${first}'`, ...optional])})`;
    case 'enumOf':
      return `enumOf([${spec.args.map((value) => `'${value}'`).join(', ')}]${spec.optional ? ', { optional: true }' : ''})`;
    case 'ref':
      return `ref('${first}'${spec.optional ? ', { optional: true }' : ''})`;
    default:
      return `${spec.type}(${optionsObject(optional)})`;
  }
}

/**
 * The line of a resource file's `fields` that a spec becomes, such as
 * `status: enumOf(['new', 'closed'])` or `title: text({ max: 200, optional: true })`. Every
 * literal in it was validated by {@link parseFieldSpec}, so it needs no escaping.
 */
export function renderFieldCode(spec: FieldSpec): string {
  return `${spec.name}: ${builderCall(spec)}`;
}

/** A value a generated test may create a record with, as TypeScript source. */
function sampleValue(spec: FieldSpec): string {
  const [first = '', second = ''] = spec.args;
  switch (spec.type) {
    case 'text':
      return `'${'example'.slice(0, spec.args.length === 0 ? undefined : Number(first))}'`;
    case 'richText':
      return `[{ type: 'paragraph', text: 'Example' }]`;
    case 'number':
      return spec.args.length === 0
        ? '0'
        : String(Math.min(Math.max(0, Number(first)), Number(second)));
    case 'money':
      return `{ amount: '100', currency: '${first}' }`;
    case 'bool':
      return 'true';
    case 'date':
      return `'2026-01-01'`;
    case 'dateTime':
      return `'2026-01-01T09:00:00Z'`;
    case 'enumOf':
      return `'${first}'`;
    case 'person':
    case 'ref':
      return `'${SAMPLE_ID}'`;
    case 'files':
    case 'tags':
      return '[]';
  }
}

/** Why `name` cannot name a resource, or `undefined` when it can. */
function resourceNameRefusal(name: string): string | undefined {
  // The plural (`name + 's'`) is the table and route name, so it must fit the limit too.
  if (!SNAKE_CASE.test(name) || name.length > IDENTIFIER_MAX - 1) {
    return `must be snake_case, 1-${String(IDENTIFIER_MAX - 1)} characters`;
  }
  return RESERVED_WORDS.includes(name)
    ? 'is a reserved word in TypeScript, and the route files bind the resource to its name'
    : undefined;
}

/** Why `name` cannot name an app or an agent (a kebab name key), or `undefined`. */
function nameKeyRefusal(name: string, max: number): string | undefined {
  return NAME_KEY_PATTERN.test(name) && name.length <= max
    ? undefined
    : `must be lower-case kebab, 1-${String(max)} characters`;
}

function refuseIf(subject: string, issues: readonly (ProjectRenderIssue | undefined)[]): void {
  const found = issues.filter((issue) => issue !== undefined);
  if (found.length > 0) throw new ProjectRenderError(subject, found);
}

function issueAt(path: string, message: string | undefined): ProjectRenderIssue | undefined {
  return message === undefined ? undefined : { path, message };
}

function boardRefusal(specs: readonly FieldSpec[], board: string | undefined): string | undefined {
  if (board === undefined) return undefined;
  return specs.some((spec) => spec.name === board && spec.type === 'enumOf')
    ? undefined
    : `must name an enum field of the resource; "${board}" is not one`;
}

function fieldListRefusal(specs: readonly FieldSpec[]): string | undefined {
  if (specs.length === 0) return 'a resource needs at least one field, such as title:text';
  if (specs.length > RESOURCE_MAX_FIELDS) {
    return `a resource has at most ${String(RESOURCE_MAX_FIELDS)} fields`;
  }
  const names = specs.map((spec) => spec.name);
  return new Set(names).size === names.length ? undefined : 'a field name is repeated';
}

/** The line width the generated files are written to, as Prettier would print them. */
const PRINT_WIDTH = 100;

/** `import { a, b } from 'module';`, on one line when it fits and one name per line when not. */
function importStatement(names: readonly string[], module: string): string {
  const line = `import { ${names.join(', ')} } from '${module}';`;
  return line.length <= PRINT_WIDTH
    ? line
    : `import {\n${names.map((name) => `  ${name},\n`).join('')}} from '${module}';`;
}

/** The two `app.config.ts` lines that add one resource to the app: its import and its entry. */
export function appConfigLines(resource: string): {
  readonly import: string;
  readonly entry: string;
} {
  return Object.freeze({
    import: `import ${resource} from './resources/${resource}.ts';`,
    entry: `    ${resource},`,
  });
}

/**
 * The values of the `app` template: the app's name, its schema `app_<name>` (hyphens as
 * underscores) and the `app.config.ts` lines of the resources it starts with.
 *
 * @throws {ProjectRenderError} when the app name or a resource name is refused.
 */
export function renderAppSpec(appName: string, resources: readonly string[] = []): TemplateValues {
  refuseIf('the app', [
    issueAt('name', nameKeyRefusal(appName, APP_NAME_MAX)),
    ...resources.map((resource) => issueAt(resource, resourceNameRefusal(resource))),
  ]);
  const lines = resources.map(appConfigLines);
  return Object.freeze({
    appName,
    schema: `app_${appName.replaceAll('-', '_')}`,
    imports: lines.map((line) => `${line.import}\n`).join(''),
    resources: lines.map((line) => `${line.entry}\n`).join(''),
  });
}

/** `work_item` or `open-tickets` as a component name's start: `WorkItem`, `OpenTickets`. */
function pascalCase(name: string): string {
  return name
    .split(/[-_]/u)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** `open-tickets` as a heading: `Open tickets`. */
function titleOf(name: string): string {
  const sentence = name.split(/[-_]/u).join(' ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * The values of the `resource` template for a resource and its parsed fields: its file's imports
 * and fields, its `search` (the `text` and `richText` fields) and `board`, its plural, and the
 * record its generated test creates. The same values render `resource-pages`: the component
 * names (`component`, `components`) and the list page's part, `ResourceBoard` when the resource
 * has a `board` and `ResourceList` otherwise (`listPart`).
 *
 * @throws {ProjectRenderError} listing every reason: a refused name, no or repeated fields, or a
 *   `board` that is not an enum field (path `--board`).
 */
export function renderResourceSpec(
  name: string,
  specs: readonly FieldSpec[],
  options: { readonly board?: string } = {},
): TemplateValues {
  refuseIf('the resource', [
    issueAt('name', resourceNameRefusal(name)),
    issueAt('fields', fieldListRefusal(specs)),
    issueAt('--board', boardRefusal(specs, options.board)),
  ]);
  const builders = [...new Set(specs.map((spec) => spec.type))].sort();
  const searchable = specs
    .filter((spec) => spec.type === 'text' || spec.type === 'richText')
    .map((spec) => `'${spec.name}'`);
  return Object.freeze({
    name,
    plural: `${name}s`,
    component: pascalCase(name),
    components: pascalCase(`${name}s`),
    listPart: options.board === undefined ? 'ResourceList' : 'ResourceBoard',
    imports: importStatement(['defineResource', ...builders].sort(), '@indx-workspace/app'),
    fields: specs.map((spec) => `    ${renderFieldCode(spec)},\n`).join(''),
    options: [
      ...(searchable.length === 0 ? [] : [`  search: [${searchable.join(', ')}],\n`]),
      ...(options.board === undefined ? [] : [`  board: '${options.board}',\n`]),
    ].join(''),
    sample: specs
      .filter((spec) => !spec.optional)
      .map((spec) => `  ${spec.name}: ${sampleValue(spec)},\n`)
      .join(''),
  });
}

/** Why `name` cannot name a page, or `undefined` when it can. */
function pageNameRefusal(name: string): string | undefined {
  if (!PAGE_NAME.test(name) || name.length > PAGE_NAME_MAX) {
    return `must be lower-case words joined by - or _, 1-${String(PAGE_NAME_MAX)} characters`;
  }
  return RESERVED_PAGE_NAMES.includes(name)
    ? `is reserved: app/${name}/ holds the generated routes`
    : undefined;
}

function isPageKind(kind: string): kind is GeneratorPageKind {
  return (GENERATOR_PAGE_KINDS as readonly string[]).includes(kind);
}

/** Why the `--resource` of a page is refused, or `undefined`. */
function pageResourceRefusal(
  kind: GeneratorPageKind,
  resource: string | undefined,
): string | undefined {
  if (kind !== 'list') {
    return resource === undefined ? undefined : 'only a list page shows a resource';
  }
  if (resource === undefined) return 'a list page needs the resource it lists, --resource <name>';
  return resourceNameRefusal(resource);
}

/**
 * The values of a `page/<kind>` template: the page's route segment (`route`), its component name
 * and heading, and for a `list` page the resource it lists. Whether that resource exists, and
 * whether the name is taken by a resource's own pages, is the caller's to check.
 *
 * @throws {ProjectRenderError} listing every reason: a refused name, an unknown `--kind`, or a
 *   `--resource` missing from a list page, given to another kind, or not a resource name.
 */
export function renderPageSpec(
  name: string,
  options: { readonly kind: string; readonly resource?: string | undefined },
): { readonly kind: GeneratorPageKind; readonly values: TemplateValues } {
  const { kind, resource } = options;
  const known = isPageKind(kind) ? kind : undefined;
  const issues = [
    issueAt('name', pageNameRefusal(name)),
    known === undefined
      ? issueAt('--kind', `must be one of ${GENERATOR_PAGE_KINDS.join(', ')}`)
      : issueAt('--resource', pageResourceRefusal(known, resource)),
  ].filter((issue) => issue !== undefined);
  if (known === undefined || issues.length > 0) throw new ProjectRenderError('the page', issues);
  return Object.freeze({
    kind: known,
    values: Object.freeze({
      route: name,
      component: pascalCase(name),
      title: titleOf(name),
      ...(resource === undefined ? {} : { resource }),
    }),
  });
}

/**
 * The values of the `agent` template: an agent wired to the app's MCP connector (named as the
 * app) whose instructions name the `<resource>_*` tools of the resources it works with.
 *
 * The connector has no per-tool allowlist, so the agent reaches every tool of the app; each call
 * is still limited to what the person may do (`access` ∩ `agents.write`).
 *
 * @throws {ProjectRenderError} listing every refused name, or no resources (path `--tools`).
 */
export function renderAgentSpec(
  name: string,
  options: { readonly appName: string; readonly resources: readonly string[] },
): TemplateValues {
  refuseIf('the agent', [
    issueAt('name', nameKeyRefusal(name, 64)),
    issueAt('app', nameKeyRefusal(options.appName, APP_NAME_MAX)),
    issueAt(
      '--tools',
      options.resources.length === 0
        ? 'name at least one resource, such as --tools ticket'
        : undefined,
    ),
    ...options.resources.map((resource) => issueAt(resource, resourceNameRefusal(resource))),
  ]);
  const resources = [...new Set(options.resources)];
  const toolLines = resources.map(
    (resource) =>
      `    '${resource}s: ${resource}_list and ${resource}_get read them, ${resource}_search finds them when the resource is searchable, and ${resource}_update changes the fields agents may write.',\n`,
  );
  return Object.freeze({
    name,
    appName: options.appName,
    resources: resources.map((resource) => `${resource}s`).join(', '),
    instructions: toolLines.join(''),
  });
}

/** A recipe's name, as the app kit's `defineRecipe` takes it: lower-case kebab, from a letter. */
const RECIPE_NAME = /^[a-z][a-z0-9-]{0,62}$/u;
/** The committed writes a recipe can start on, as the app kit's `resourceEvent` takes them. */
const RECIPE_RESOURCE_EVENTS: readonly string[] = ['created', 'updated', 'deleted'];
/** One cron field as a literal may hold it: no quote, no backslash, no space. */
const CRON_FIELD = /^[0-9A-Za-z*/,?#-]+$/u;
/** An IANA time zone as a literal may hold it (`Asia/Tokyo`, `UTC`, `Etc/GMT+9`). */
const TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/u;

/** What starts a generated recipe: a committed write to a resource, or a cron slot. */
export type RecipeTriggerSpec =
  | { readonly kind: 'resourceEvent'; readonly resource: string; readonly event: string }
  | { readonly kind: 'schedule'; readonly cron: string; readonly timezone: string };

/** The `--on` and `--tz` of `aw generate recipe`, and the resources the app has. */
export interface RecipeSpecOptions {
  /** `resource:<resource>.<created|updated|deleted>` or `schedule:<cron>`. */
  readonly on: string;
  /** The schedule's IANA time zone; `UTC` when not given. Only a schedule takes one. */
  readonly tz?: string | undefined;
  /** The app's resources (`resources/<name>.ts`); a `resource:` trigger must name one. */
  readonly resources: readonly string[];
}

function resourceTrigger(
  rest: string,
  resources: readonly string[],
): RecipeTriggerSpec | ProjectRenderIssue[] {
  const dot = rest.lastIndexOf('.');
  const resource = dot === -1 ? rest : rest.slice(0, dot);
  const event = dot === -1 ? '' : rest.slice(dot + 1);
  const issues = [
    issueAt('--on', resourceNameRefusal(resource)),
    issueAt(
      '--on',
      RECIPE_RESOURCE_EVENTS.includes(event)
        ? undefined
        : `the event must be one of ${RECIPE_RESOURCE_EVENTS.join(', ')}, as resource:${resource}.created`,
    ),
    issueAt(
      '--on',
      resources.includes(resource)
        ? undefined
        : `names no resource of this app: ${resource} (it has ${resources.length === 0 ? 'none' : resources.join(', ')})`,
    ),
  ].filter((issue) => issue !== undefined);
  return issues.length > 0 ? issues : { kind: 'resourceEvent', resource, event };
}

function scheduleTrigger(
  rest: string,
  tz: string | undefined,
): RecipeTriggerSpec | ProjectRenderIssue[] {
  const fields = rest.trim().split(/\s+/u);
  const timezone = tz ?? 'UTC';
  const issues = [
    issueAt(
      '--on',
      fields.length === 5
        ? undefined
        : 'a schedule has exactly five cron fields, as schedule:*/5 * * * *',
    ),
    issueAt(
      '--on',
      fields.every((field) => CRON_FIELD.test(field))
        ? undefined
        : 'a cron field holds only digits, letters and * / , ? # -',
    ),
    issueAt(
      '--tz',
      TIME_ZONE.test(timezone) ? undefined : 'must be an IANA time zone such as Asia/Tokyo',
    ),
  ].filter((issue) => issue !== undefined);
  return issues.length > 0 ? issues : { kind: 'schedule', cron: fields.join(' '), timezone };
}

/** The trigger `--on` names, or every reason it does not name one. */
function recipeTrigger(options: RecipeSpecOptions): RecipeTriggerSpec | ProjectRenderIssue[] {
  const colon = options.on.indexOf(':');
  const kind = colon === -1 ? options.on : options.on.slice(0, colon);
  const rest = colon === -1 ? '' : options.on.slice(colon + 1);
  if (kind === 'schedule') return scheduleTrigger(rest, options.tz);
  const tzIssue = issueAt(
    '--tz',
    options.tz === undefined ? undefined : 'only a schedule: trigger takes a time zone',
  );
  if (kind === 'resource') {
    const read = resourceTrigger(rest, options.resources);
    if (tzIssue === undefined) return read;
    return Array.isArray(read) ? [...read, tzIssue] : [tzIssue];
  }
  const message =
    kind === 'trigger'
      ? 'trigger:<name> is not available yet: a trigger reaches an app through an entry agent'
      : 'must be resource:<resource>.<created|updated|deleted> or schedule:<cron>';
  return [{ path: '--on', message }, ...(tzIssue === undefined ? [] : [tzIssue])];
}

/** `enrich-contact` as the variable `app.config.ts` binds it to: `enrichContactRecipe`. */
function recipeVariable(name: string): string {
  const pascal = pascalCase(name);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}Recipe`;
}

/** The two `app.config.ts` lines that add one recipe to the app: its import and its entry. */
export function appConfigRecipeLines(recipe: string): {
  readonly import: string;
  readonly entry: string;
} {
  const variable = recipeVariable(recipe);
  return Object.freeze({
    import: `import ${variable} from './recipes/${recipe}.ts';`,
    entry: `    ${variable},`,
  });
}

/**
 * The values of the `recipe` template and the trigger they were made from: the recipe's name,
 * its `on` (`resourceEvent('contact', 'created')` or `schedule('0 9 * * 1', 'UTC')`), the
 * builder it imports, the environment variable naming its example step's agent, and the input its
 * generated test starts it with. Whether croner accepts the cron is the app kit's to check
 * (`aw-app recipe-on`); the grammar, the characters and the resource are checked here.
 *
 * @throws {ProjectRenderError} listing every reason: a refused name, an `--on` that is neither
 *   trigger (or the deferred `trigger:`), an unknown event or resource, a cron that is not five
 *   plain fields, or a `--tz` that is not a time zone or is given without a schedule.
 */
export function renderRecipeSpec(
  name: string,
  options: RecipeSpecOptions,
): { readonly trigger: RecipeTriggerSpec; readonly values: TemplateValues } {
  const nameIssue = issueAt(
    'name',
    RECIPE_NAME.test(name) ? undefined : 'must be lower-case kebab from a letter, 1-63 characters',
  );
  const trigger = recipeTrigger(options);
  const issues = [
    ...(nameIssue === undefined ? [] : [nameIssue]),
    ...(Array.isArray(trigger) ? trigger : []),
  ];
  if (Array.isArray(trigger) || issues.length > 0)
    throw new ProjectRenderError('the recipe', issues);
  const resourceEvent = trigger.kind === 'resourceEvent';
  return Object.freeze({
    trigger,
    values: Object.freeze({
      name,
      title: titleOf(name),
      builder: resourceEvent ? 'resourceEvent' : 'schedule',
      on: resourceEvent
        ? `resourceEvent('${trigger.resource}', '${trigger.event}')`
        : `schedule('${trigger.cron}', '${trigger.timezone}')`,
      when: resourceEvent
        ? `when a ${trigger.resource} is ${trigger.event}`
        : `on each slot of its schedule, in ${trigger.timezone}`,
      agentVariable: `AW_${name.replaceAll('-', '_').toUpperCase()}_AGENT_ID`,
      input: resourceEvent
        ? [
            '{',
            `    resource: '${trigger.resource}',`,
            `    event: '${trigger.event}',`,
            `    record: { id: '${SAMPLE_ID}' },`,
            '  }',
          ].join('\n')
        : `{ slot: '2026-01-01T00:05:00.000Z' }`,
    }),
  });
}

/** One `ref()` field of a resource file: the field and the resource it refers to. */
export interface RefFieldSpec {
  readonly field: string;
  readonly resource: string;
}

/** `name: ref('target'` at the start of a line, as `aw generate resource` writes a field. */
const REF_FIELD_LINE = /^\s*([a-z][a-z0-9_]*)\s*:\s*ref\(\s*['"]([a-z][a-z0-9_]*)['"]/gmu;

/**
 * The `ref()` fields of a resource file's source, in order, as `aw generate resource` writes them
 * (one field per line). A field written another way is not found, and `aw generate channel`
 * then asks for `--key` or refuses.
 */
export function refFieldsOf(source: string): readonly RefFieldSpec[] {
  return [...source.matchAll(REF_FIELD_LINE)].map((match) => ({
    field: match[1] ?? '',
    resource: match[2] ?? '',
  }));
}

/** `support_ticket` as a variable with a suffix: `supportTicketChannel`. */
function variableOf(name: string, suffix: string): string {
  const pascal = pascalCase(name);
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}${suffix}`;
}

/** What {@link renderChannelSpec} reads besides the resource's name. */
export interface ChannelSpecOptions {
  /** `--key`: the `ref()` field whose value is the channel key; found when not given. */
  readonly key?: string | undefined;
  /** The resource's `ref()` fields, from {@link refFieldsOf}. */
  readonly refs: readonly RefFieldSpec[];
}

/** One edit of a generated route file: the import it adds, and the line it replaces. */
export interface ChannelRouteEdit {
  readonly path: string;
  readonly import: string;
  readonly replaced: string;
  readonly added: string;
}

/**
 * The two edits `aw generate channel` makes to a resource's generated route files: each imports
 * the channel and passes `{ publish: <channel> }` to `resourceRoutes` or `resourceItemRoutes`, so
 * every write of the resource through either publishes.
 */
export function channelRouteEdits(name: string): readonly ChannelRouteEdit[] {
  const variable = variableOf(name, 'Channel');
  const importLine = `import ${variable} from '@/channels/${name}';`;
  const routes = [
    [`app/api/${name}s/route.ts`, 'GET, POST', 'resourceRoutes'],
    [`app/api/${name}s/[id]/route.ts`, 'GET, PATCH, DELETE', 'resourceItemRoutes'],
  ] as const;
  return routes.map(([path, methods, factory]) => ({
    path,
    import: importLine,
    replaced: `export const { ${methods} } = ${factory}(${name});`,
    added: `export const { ${methods} } = ${factory}(${name}, { publish: ${variable} });`,
  }));
}

/** The `ref()` field the key is in: `--key` when given, else the first to another resource. */
function channelKey(name: string, options: ChannelSpecOptions): RefFieldSpec | string {
  const others = options.refs.filter((ref) => ref.resource !== name);
  if (options.key === undefined) {
    return (
      others[0] ??
      'channel_key_required: the resource has no ref() field to another resource to key the channel on; add one, such as room:ref(room), or name it with --key <refField>'
    );
  }
  const named = options.refs.find((ref) => ref.field === options.key);
  if (named === undefined) {
    return `channel_key_required: ${options.key} is not a ref() field of the resource (it has ${options.refs.length === 0 ? 'none' : options.refs.map((ref) => ref.field).join(', ')})`;
  }
  return named.resource === name
    ? `channel_key_required: ${options.key} refers to the resource itself, a thread's root, not a channel`
    : named;
}

/**
 * The values of the `channel` template for a resource and its `ref()` fields: the channel's name
 * (the resource's), its key field and the resource that field refers to, whose `read` access on
 * the key's record admits a subscriber, and the variable each file binds.
 *
 * @throws {ProjectRenderError} with the code `channel_key_required` when the resource has no
 *   `ref()` field to another resource, or `--key` names none; and for a refused name.
 */
export function renderChannelSpec(name: string, options: ChannelSpecOptions): TemplateValues {
  const key = channelKey(name, options);
  const nameIssue = issueAt('name', resourceNameRefusal(name));
  if (typeof key === 'string' || nameIssue !== undefined) {
    const issues = [nameIssue, typeof key === 'string' ? issueAt('--key', key) : undefined];
    throw new ProjectRenderError(
      'the channel',
      issues.filter((issue) => issue !== undefined),
    );
  }
  return Object.freeze({
    name,
    plural: `${name}s`,
    component: pascalCase(name),
    keyField: key.field,
    target: key.resource,
    targetVariable: variableOf(key.resource, 'Resource'),
    variable: variableOf(name, 'Channel'),
  });
}

/**
 * Renders one generator's template directory (`templates/<kind>/`, copied beside this module by
 * the build) with values from {@link renderAppSpec}, {@link renderResourceSpec} (for `resource`
 * and `resource-pages`), {@link renderPageSpec} (for `page/<kind>`), {@link renderAgentSpec},
 * {@link renderRecipeSpec} (for `recipe`) or {@link renderChannelSpec} (for `channel`).
 *
 * @throws {ProjectRenderError} when the template uses a value `values` lacks.
 */
export function renderGeneratorTemplate(
  kind: GeneratorTemplate,
  values: TemplateValues,
): readonly ProjectFile[] {
  return renderTemplateDirectory(
    new URL(`./templates/${kind}/`, import.meta.url),
    values,
    `the ${kind}`,
  );
}
