/**
 * `aw-app sql` (issue #1505): the migration SQL of one generated resource, for `aw generate
 * resource`. `aw` may not import the app kit, so it spawns this bin from the project's own install
 * and writes what it prints as `db/migrations/<NNNN>_create_<plural>.sql`.
 *
 * The spec is what the generator parsed from the command line (`@indx-workspace/sdk/project`'s
 * `FieldSpec`s), so the table is built by the same builders, with the same options, as the
 * `resources/<name>.ts` file the generator writes from it. Pure apart from its two output streams.
 */
import { GENERATOR_FIELD_TYPES, type FieldSpec } from '@indx-workspace/sdk/project';
import { z } from 'zod';

import { createTableSql } from '../db/create-table-sql.js';
import {
  bool,
  date,
  dateTime,
  enumOf,
  files,
  money,
  number,
  person,
  ref,
  richText,
  tags,
  text,
  type AnyField,
} from '../fields/index.js';
import { defineResource, type DefinedResource } from '../resource.js';

/** Where the bin writes; `process.stdout` and `process.stderr` in the bin, strings in a test. */
export interface AwAppIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** The exit codes: done, the spec or app name was refused, the command line was misused. */
export const AW_APP_EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 });

const USAGE =
  'usage: aw-app sql --app <name> <resource-spec-json>\n' +
  '       aw-app migrate --app <name> --dir <migrations-folder>\n' +
  "       aw-app recipe-on '<cron>' [--tz <iana-time-zone>]\n";

/** The most characters of spec JSON the bin reads: far above a 100-field resource. */
const SPEC_MAX_LENGTH = 200_000;

const NameSchema = z.string().min(1).max(63);

const FieldSpecSchema = z.strictObject({
  name: NameSchema,
  type: z.enum(GENERATOR_FIELD_TYPES),
  args: z.array(z.string().max(1000)).max(100),
  optional: z.boolean(),
});

/** One generated resource as `aw generate resource` parsed it: its name, fields and board. */
const ResourceSpecSchema = z.strictObject({
  name: NameSchema,
  fields: z.array(FieldSpecSchema).min(1).max(100),
  board: NameSchema.optional(),
});

/** What `aw-app sql` reads: the resource's name, its parsed fields, and its board field. */
export interface ResourceSpec {
  readonly name: string;
  readonly fields: readonly FieldSpec[];
  readonly board?: string;
}

/** The `{ optional: true }` a builder takes for an optional spec, or nothing. */
function optionalOf(spec: FieldSpec): { optional?: true } {
  return spec.optional ? { optional: true } : {};
}

/** The builder call the generator's `renderFieldCode` writes for `spec`, made here. */
function fieldOf(spec: FieldSpec): AnyField {
  const [first = '', second = ''] = spec.args;
  const optional = optionalOf(spec);
  switch (spec.type) {
    case 'text':
      return text({ ...(spec.args.length === 0 ? {} : { max: Number(first) }), ...optional });
    case 'number':
      return number({
        ...(spec.args.length === 0 ? {} : { min: Number(first), max: Number(second) }),
        ...optional,
      });
    case 'money':
      return money({ currency: first, ...optional });
    case 'enumOf': {
      // An empty list is refused by the builder, through the empty value it then holds.
      const [head = '', ...tail] = spec.args;
      return enumOf([head, ...tail], optional);
    }
    case 'ref':
      return ref(first, optional);
    case 'richText':
      return richText(optional);
    case 'bool':
      return bool(optional);
    case 'date':
      return date(optional);
    case 'dateTime':
      return dateTime(optional);
    case 'person':
      return person(optional);
    case 'files':
      return files(optional);
    case 'tags':
      return tags(optional);
  }
}

/**
 * The resource the generated `resources/<name>.ts` defines: the spec's fields, the template's
 * access and agent settings, search over the `text` and `richText` fields (as the template
 * writes it), and the board.
 *
 * @throws {DefinitionError} when a builder or `defineResource` refuses the spec.
 */
export function resourceFromSpec(spec: ResourceSpec): DefinedResource {
  const fields = Object.fromEntries(spec.fields.map((field) => [field.name, fieldOf(field)]));
  const search = spec.fields
    .filter((field) => field.type === 'text' || field.type === 'richText')
    .map((field) => field.name);
  return defineResource({
    name: spec.name,
    fields,
    access: { read: 'member', create: 'member', update: 'member', delete: 'role:admin' },
    agents: { read: true, write: false },
    ...(search.length === 0 ? {} : { search }),
    ...(spec.board === undefined ? {} : { board: spec.board }),
  });
}

/** The spec argument, parsed and validated; the refusal's text when it is not one. */
function readSpec(text: string): ResourceSpec | string {
  if (text.length > SPEC_MAX_LENGTH) return 'the resource spec is too long';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'the resource spec is not JSON';
  }
  const parsed = ResourceSpecSchema.safeParse(json);
  if (parsed.success) {
    const { board, ...rest } = parsed.data;
    return board === undefined ? rest : { ...rest, board };
  }
  const reasons = parsed.error.issues.map(
    (issue) =>
      `${issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.')}: ${issue.message}`,
  );
  return `the resource spec is refused: ${reasons.join('; ')}`;
}

/** `--app <name>` and the one spec argument, or `undefined` when the line is not that. */
function sqlArguments(
  argv: readonly string[],
): { readonly appName: string; readonly spec: string } | undefined {
  const rest = [...argv];
  let appName: string | undefined;
  const positionals: string[] = [];
  while (rest.length > 0) {
    const token = rest.shift() ?? '';
    if (token === '--app' && appName === undefined && rest.length > 0) appName = rest.shift();
    else if (token.startsWith('--app=') && appName === undefined) appName = token.slice(6);
    else if (token.startsWith('--')) return undefined;
    else positionals.push(token);
  }
  const [spec] = positionals;
  return appName === undefined || spec === undefined || positionals.length !== 1
    ? undefined
    : { appName, spec };
}

function refused(io: AwAppIo, message: string): number {
  io.stderr(`error: ${message}\n`);
  return AW_APP_EXIT.refused;
}

/**
 * Runs `aw-app <argv>`. The one subcommand, `sql --app <name> <resource-spec-json>`, prints
 * `createTableSql(resourceFromSpec(spec), name)` on stdout. A refused spec or app name goes to
 * stderr with exit code 1, a misused command line with 2; nothing is printed on stdout then.
 */
export function runAwApp(argv: readonly string[], io: AwAppIo): number {
  const [subcommand, ...rest] = argv;
  if (subcommand === '--help' || subcommand === '-h') {
    io.stdout(USAGE);
    return AW_APP_EXIT.ok;
  }
  const parsed = subcommand === 'sql' ? sqlArguments(rest) : undefined;
  if (parsed === undefined) {
    io.stderr(USAGE);
    return AW_APP_EXIT.usage;
  }
  const spec = readSpec(parsed.spec);
  if (typeof spec === 'string') return refused(io, spec);
  let sql: string;
  try {
    sql = createTableSql(resourceFromSpec(spec), parsed.appName);
  } catch (error) {
    if (error instanceof Error) return refused(io, error.message);
    throw error;
  }
  io.stdout(sql);
  return AW_APP_EXIT.ok;
}
