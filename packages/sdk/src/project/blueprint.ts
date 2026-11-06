/**
 * App blueprints (ADR-0166): a versioned npm release of app parts, which an app installs and then
 * receives each new version of as a proposal.
 *
 * - **The manifest.** {@link parseBlueprintManifest} reads `blueprint.json` with the strict
 *   {@link BlueprintManifestSchema} (D5): the parts and where each kind may live (D2), the slots the
 *   installing app binds (D3), and the ordered migrations.
 * - **The app-kit range.** {@link appKitSatisfies} matches the installed `@indx-workspace/app`
 *   against `appKit`'s narrow grammar: an exact version, `^x.y.z` or `~x.y.z`, with npm's meaning.
 * - **Install.** {@link planBlueprintInstall} says what `aw blueprint add` writes and records, or
 *   refuses before anything is written (D6).
 * - **Update.** {@link planBlueprintUpdate} compares, per file, the hash recorded at install, the
 *   file on disk and the new version, and proposes `add`, `update`, `remove` or `conflict` (D7). An
 *   edited file is never overwritten: a changed one gets a `<file>.blueprint-<version>` sidecar.
 * - **Migrations.** {@link destructiveMigrations} names the DDL that is not expand-only (D8).
 *
 * Pure: no file is read or written and no hash is computed. The caller reads the package, renders
 * its files, and hashes each one (sha256, lower-case hex) before planning.
 */
import { SecretNameSchema } from '@indx-workspace/contracts/secret-reference';
import type { PortableAgent } from '@indx-workspace/contracts/portable-agent';
import { NAME_KEY_PATTERN } from '@indx-workspace/contracts/project-file';
import { z } from 'zod';

import { parseAgentMarkdown } from '../portable/markdown.js';
import { ProjectRenderError, type ProjectRenderIssue } from './errors.js';
import {
  EXACT_SEMVER,
  generatedEntryKey,
  ProjectPathSchema,
  type BlueprintSource,
  type GeneratedEntry,
  type GeneratedManifest,
} from './generated-manifest.js';
import { ProjectFileError } from './reader.js';

/** The manifest's file name, at the package root. It is never written into the app (D2). */
export const BLUEPRINT_MANIFEST_FILE = 'blueprint.json';

/** The kinds of part a blueprint holds (ADR-0166 D2); migrations are listed on their own. */
export const BLUEPRINT_PART_KINDS = Object.freeze([
  'resource',
  'recipe',
  'page',
  'agent',
  'skill',
  'test',
] as const);

/** One of {@link BLUEPRINT_PART_KINDS}. */
export type BlueprintPartKind = (typeof BLUEPRINT_PART_KINDS)[number];

/** The most parts and migrations together: the generated-file manifest's per-entry limit. */
export const BLUEPRINT_MAX_FILES = 200;
const SLOTS_MAX = 64;

/** The entry-name grammar of `aw-generated.json`, which names the entry `blueprint:<name>`. */
const ENTRY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const FILE_NAME = '[a-z0-9][a-z0-9_-]{0,63}';

/** Where each part kind may live in the package, and so in the app (D2). */
const PART_ROOTS: Readonly<Record<BlueprintPartKind, { pattern: RegExp; shape: string }>> = {
  resource: {
    pattern: new RegExp(`^resources/${FILE_NAME}\\.ts$`, 'u'),
    shape: 'resources/<name>.ts',
  },
  recipe: { pattern: new RegExp(`^recipes/${FILE_NAME}\\.ts$`, 'u'), shape: 'recipes/<name>.ts' },
  page: { pattern: /^app\/./u, shape: 'app/**' },
  agent: { pattern: /^agents\/[^/]+\.agent\.md$/u, shape: 'agents/<name>.agent.md' },
  skill: { pattern: /^skills\/./u, shape: 'skills/**' },
  test: { pattern: /^tests\/./u, shape: 'tests/**' },
};

/** A migration in the package: `migrations/<NNNN>_<tag>.sql`. */
const MIGRATION_PATH = /^migrations\/\d{4}_([a-z0-9_]{1,100})\.sql$/u;

/** The app's migrations directory, where a blueprint migration lands renumbered (D6). */
const APP_MIGRATIONS_DIR = 'db/migrations';

/**
 * A path in the package: inside it (the generated-file manifest's path rules: relative, `/`
 * separators, no `.` or `..` segment, no backslash), and never an environment file.
 */
const BlueprintPathSchema = ProjectPathSchema.refine(
  (path) => path.split('/').every((segment) => !/^\.env/iu.test(segment)),
  { message: 'must not be an environment file: a blueprint carries no secret values' },
);

const PartSchema = z
  .strictObject({ path: BlueprintPathSchema, kind: z.enum(BLUEPRINT_PART_KINDS) })
  .superRefine((part, context) => {
    const root = PART_ROOTS[part.kind];
    if (!root.pattern.test(part.path)) {
      context.addIssue({
        code: 'custom',
        path: ['path'],
        message: `a ${part.kind} part must be at ${root.shape}`,
      });
    }
  });

const SlotNameSchema = z
  .string()
  .regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters');

/** A connector of this name in the installer's `agent-workspace.yaml`; its URL is bound there. */
const ConnectorSlotSchema = z.strictObject({
  slot: SlotNameSchema,
  kind: z.literal('mcp'),
  /** The parts need the signed identity assertion (ADR-0142). */
  identity: z.boolean().optional(),
});

/** A secret reference, never a value (ADR-0133 D4). */
const SecretSlotSchema = z.strictObject({ slot: SecretNameSchema });

/** An agent the blueprint creates; each has an `agents/<name>.agent.md` part. */
const AgentSlotSchema = z.strictObject({ name: SlotNameSchema });

/**
 * `appKit`: the range of `@indx-workspace/app` the parts are written for. An exact version, or
 * `^x.y.z` / `~x.y.z`; a pre-release only as an exact version.
 */
const APP_KIT_RANGE = /^[~^](0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function addIssue(
  context: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  context.addIssue({ code: 'custom', path: [...path], message });
}

function checkUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  at: (index: number) => readonly (string | number)[],
  what: string,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) addIssue(context, at(index), `${what} ${value} is listed twice`);
    seen.add(value);
  });
}

function agentNameOf(path: string): string | undefined {
  return /^agents\/([^/]+)\.agent\.md$/u.exec(path)?.[1];
}

/**
 * The strict schema of `blueprint.json` (ADR-0166 D5). Unknown keys are refused at every level,
 * so a manifest cannot carry a connector URL, a secret value or any other field.
 */
export const BlueprintManifestSchema = z
  .strictObject({
    name: z
      .string()
      .regex(ENTRY_NAME, 'must be 1-64 of [a-z0-9_-], starting with a letter or digit'),
    version: z.string().max(256).regex(EXACT_SEMVER, 'must be an exact semver version'),
    appKit: z
      .string()
      .max(256)
      .refine((range) => APP_KIT_RANGE.test(range) || EXACT_SEMVER.test(range), {
        message: 'must be an exact version, ^x.y.z or ~x.y.z',
      }),
    parts: z.array(PartSchema).min(1).max(BLUEPRINT_MAX_FILES),
    slots: z.strictObject({
      connectors: z.array(ConnectorSlotSchema).max(SLOTS_MAX),
      secrets: z.array(SecretSlotSchema).max(SLOTS_MAX),
      agents: z.array(AgentSlotSchema).max(SLOTS_MAX),
    }),
    migrations: z
      .array(
        BlueprintPathSchema.refine((path) => MIGRATION_PATH.test(path), {
          message: 'must be migrations/<NNNN>_<tag>.sql',
        }),
      )
      .max(BLUEPRINT_MAX_FILES),
  })
  .superRefine((manifest, context) => {
    const paths = [...manifest.parts.map((part) => part.path), ...manifest.migrations];
    if (paths.length > BLUEPRINT_MAX_FILES) {
      addIssue(context, [], `a blueprint holds at most ${String(BLUEPRINT_MAX_FILES)} files`);
    }
    checkUnique(
      manifest.parts.map((part) => part.path),
      context,
      (index) => ['parts', index, 'path'],
      'the part',
    );
    checkUnique(manifest.migrations, context, (index) => ['migrations', index], 'the migration');
    checkUnique(
      manifest.slots.connectors.map((slot) => slot.slot),
      context,
      (index) => ['slots', 'connectors', index, 'slot'],
      'the connector slot',
    );
    checkUnique(
      manifest.slots.secrets.map((slot) => slot.slot),
      context,
      (index) => ['slots', 'secrets', index, 'slot'],
      'the secret slot',
    );
    const agentSlots = manifest.slots.agents.map((slot) => slot.name);
    checkUnique(agentSlots, context, (index) => ['slots', 'agents', index, 'name'], 'the agent');
    const agentParts = new Set(
      manifest.parts.flatMap((part) =>
        part.kind === 'agent' ? [agentNameOf(part.path) ?? ''] : [],
      ),
    );
    agentSlots.forEach((name, index) => {
      if (!agentParts.has(name)) {
        addIssue(
          context,
          ['slots', 'agents', index, 'name'],
          `needs the part agents/${name}.agent.md`,
        );
      }
    });
    manifest.parts.forEach((part, index) => {
      const name = agentNameOf(part.path);
      if (part.kind === 'agent' && name !== undefined && !agentSlots.includes(name)) {
        addIssue(
          context,
          ['parts', index, 'path'],
          `the agent ${name} must be listed in slots.agents`,
        );
      }
    });
  });

/** A parsed `blueprint.json`. */
export type BlueprintManifest = z.infer<typeof BlueprintManifestSchema>;

/**
 * Reads `blueprint.json`. A file that is not JSON, or that the strict schema refuses, is refused.
 *
 * @throws {ProjectRenderError} naming each refused place (dotted path, `(root)` for the file).
 */
export function parseBlueprintManifest(text: string): BlueprintManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectRenderError(BLUEPRINT_MANIFEST_FILE, [
      { path: '(root)', message: 'is not JSON' },
    ]);
  }
  const parsed = BlueprintManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProjectRenderError(
      BLUEPRINT_MANIFEST_FILE,
      parsed.error.issues.map((issue) => ({
        path: issue.path.length === 0 ? '(root)' : issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return parsed.data;
}

interface Semver {
  readonly core: readonly [string, string, string];
  readonly prerelease: string | undefined;
}

function parseSemver(text: string): Semver | undefined {
  const match = EXACT_SEMVER.exec(text);
  if (match === null) return undefined;
  const [, major = '', minor = '', patch = '', prerelease] = match;
  return { core: [major, minor, patch], prerelease };
}

/** Compares two numeric identifiers without leading zeros: by length, then digit by digit. */
function compareNumber(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCore(left: Semver, right: Semver): number {
  for (const index of [0, 1, 2] as const) {
    const order = compareNumber(left.core[index], right.core[index]);
    if (order !== 0) return order;
  }
  return 0;
}

/**
 * Whether the installed app-kit `version` lies in a blueprint's `appKit` `range` (ADR-0166 D5).
 * The range is an exact version, `^x.y.z` or `~x.y.z`, with npm's meaning: `^1.2.3` is
 * `>=1.2.3 <2.0.0`, `^0.9.0` is `>=0.9.0 <0.10.0`, `^0.0.3` is `0.0.3` only, and `~1.2.3` is
 * `>=1.2.3 <1.3.0`. A pre-release matches only exactly. Anything else, a malformed range or
 * version included, does not match.
 */
export function appKitSatisfies(range: string, version: string): boolean {
  const have = parseSemver(version);
  if (have === undefined) return false;
  const exact = parseSemver(range);
  if (exact !== undefined)
    return exact.prerelease === have.prerelease && compareCore(exact, have) === 0;
  if (!APP_KIT_RANGE.test(range) || have.prerelease !== undefined) return false;
  const operator = range[0];
  const wanted = parseSemver(range.slice(1));
  if (wanted === undefined || compareCore(have, wanted) < 0) return false;
  const [major, minor] = wanted.core;
  if (operator === '~' || (major === '0' && minor !== '0')) {
    return have.core[0] === major && have.core[1] === minor;
  }
  if (major === '0') return compareCore(have, wanted) === 0;
  return have.core[0] === major;
}

/** One expand-only rule a statement broke: the migration, the rule's name and the statement. */
export interface DestructiveMigration {
  readonly path: string;
  readonly rule: string;
  readonly statement: string;
}

/** Whether a statement adds a `CHECK` without `NOT VALID`, which scans an existing table. */
function addsValidatedCheck(code: string): boolean {
  return code
    .split(/;|,\s*(?=ADD\b)/iu)
    .some((clause) =>
      /\bADD\s+(?:CONSTRAINT\s+\S+\s+)?CHECK\b(?![\s\S]*\bNOT\s+VALID\b)/iu.test(clause),
    );
}

// shortcut: a copy of the expand-only LINT_RULES of scripts/migrations.mjs (the source of truth),
// because a package cannot import a repository script; tests/blueprint-migration-rules.test.ts
// holds the two equal. Upgrade when that classifier moves into a package both can import.
const EXPAND_ONLY_RULES: readonly (readonly [string, { test(code: string): boolean }])[] = [
  ['DROP', /\bDROP\s+(?!DEFAULT\b|NOT\s+NULL\b)/iu],
  ['RENAME', /\bRENAME\b/iu],
  ['SET NOT NULL', /\bSET\s+NOT\s+NULL\b/iu],
  ['ALTER COLUMN TYPE', /\bALTER\s+COLUMN\s+\S+\s+(?:SET\s+DATA\s+)?TYPE\b/iu],
  ['CHECK without NOT VALID', { test: addsValidatedCheck }],
];

/**
 * The rules only a blueprint's migrations are held to (ADR-0166 D8): the repository's own
 * migrations are reviewed in this repository, a blueprint's come from a package. A blueprint
 * migration adds schema and backfills; it never empties a table, deletes rows, or runs SQL the
 * guard cannot read (a `DO` block, `EXECUTE`), and it may not change how string literals are read.
 */
const BLUEPRINT_ONLY_RULES: readonly (readonly [string, RegExp])[] = [
  ['TRUNCATE', /\bTRUNCATE\b/iu],
  ['DELETE', /\bDELETE\s+FROM\b/iu],
  ['DO', /(?:^|;)\s*DO\b/iu],
  ['EXECUTE', /\bEXECUTE\b(?!\s+(?:FUNCTION|PROCEDURE)\b)/iu],
  ['standard_conforming_strings', /\b(?:standard_conforming_strings|backslash_quote)\b/iu],
];

const STATEMENT_BREAKPOINT = '--> statement-breakpoint';
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/u;
const IDENTIFIER_CHARACTER = /[\w$\u0080-￿]/u;

/**
 * Where the quoted text that starts at `at` ends (the index after its closing quote), or the
 * text's length when it is not closed. `'…'` doubles its quote, as does `"…"`; `E'…'` also takes a
 * backslash escape; `$tag$…$tag$` ends only at the same tag.
 */
function quotedEnd(sql: string, at: number): number {
  const quote = sql[at];
  if (quote === '$') {
    const tag = DOLLAR_TAG.exec(sql.slice(at))?.[0] ?? '$';
    const close = sql.indexOf(tag, at + tag.length);
    return close === -1 ? sql.length : close + tag.length;
  }
  const before = at > 0 ? sql[at - 1] : undefined;
  const escapes =
    quote === "'" &&
    (before === 'E' || before === 'e') &&
    (at < 2 || !IDENTIFIER_CHARACTER.test(sql[at - 2] ?? ''));
  for (let index = at + 1; index < sql.length; index += 1) {
    const character = sql[index];
    if (escapes && character === '\\') index += 1;
    else if (character === quote) {
      if (sql[index + 1] !== quote) return index + 1;
      index += 1;
    }
  }
  return sql.length;
}

/** Where the `/* … *\/` comment that starts at `at` ends; comments nest, as in PostgreSQL. */
function blockCommentEnd(sql: string, at: number): number {
  let depth = 0;
  for (let index = at; index < sql.length - 1; index += 1) {
    const pair = sql.slice(index, index + 2);
    if (pair === '/*') {
      depth += 1;
      index += 1;
    } else if (pair === '*/') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * The statements of a migration as code: split at each `--> statement-breakpoint` comment, with
 * every comment taken out. It reads the SQL as PostgreSQL does, so a `--` or `/*` inside a quoted
 * string, a quoted name or a dollar-quoted body stays text and cannot hide the code after it.
 * Quoted text is kept, so a rule still sees a word written inside a function body. A comment that
 * is not closed is kept as code: the guard never takes out what it cannot bound.
 */
function migrationStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  let code = '';
  let index = 0;
  while (index < sql.length) {
    const character = sql[index] ?? '';
    const pair = sql.slice(index, index + 2);
    if (pair === '--') {
      const newline = sql.indexOf('\n', index);
      const end = newline === -1 ? sql.length : newline;
      if (sql.startsWith(STATEMENT_BREAKPOINT, index)) {
        statements.push(code);
        code = sql.slice(index + STATEMENT_BREAKPOINT.length, end);
      }
      index = end;
    } else if (pair === '/*') {
      const end = blockCommentEnd(sql, index);
      if (end === -1) {
        code += sql.slice(index);
        index = sql.length;
      } else {
        code += ' ';
        index = end;
      }
    } else if (
      character === "'" ||
      character === '"' ||
      (character === '$' &&
        DOLLAR_TAG.test(sql.slice(index)) &&
        !IDENTIFIER_CHARACTER.test(sql[index - 1] ?? ''))
    ) {
      const end = quotedEnd(sql, index);
      code += sql.slice(index, end);
      index = end;
    } else {
      code += character;
      index += 1;
    }
  }
  statements.push(code);
  return statements;
}

/**
 * The statements of one migration that are not expand-only (ADR-0166 D8): a `DROP` (other than
 * `DROP DEFAULT` or `DROP NOT NULL`), a `RENAME`, a `SET NOT NULL`, an `ALTER COLUMN … TYPE`, or a
 * `CHECK` added without `NOT VALID`, as `pnpm migrations:lint` refuses them; and, for a blueprint
 * only, a `TRUNCATE`, a `DELETE FROM`, a `DO` block, an `EXECUTE` (other than a trigger's
 * `EXECUTE FUNCTION`), or a change to `standard_conforming_strings` or `backslash_quote`.
 * Statements are split at `--> statement-breakpoint` and read with their comments removed by a
 * reader that respects quoted strings, quoted names and dollar quoting. The repository lint's
 * `-- safe:` exception does not apply.
 *
 * @returns One finding per statement and rule broken; empty for an expand-only migration.
 */
export function destructiveMigrations(path: string, sql: string): readonly DestructiveMigration[] {
  const findings: DestructiveMigration[] = [];
  for (const code of migrationStatements(sql)) {
    const statement = code.trim().split('\n')[0] ?? '';
    for (const [rule, pattern] of [...EXPAND_ONLY_RULES, ...BLUEPRINT_ONLY_RULES]) {
      if (pattern.test(code)) findings.push(Object.freeze({ path, rule, statement }));
    }
  }
  return Object.freeze(findings);
}

/** One file of a blueprint release: its path in the package, its rendered text and its sha256. */
export interface BlueprintFile {
  readonly path: string;
  readonly contents: string;
  /** The sha256 of `contents`, lower-case hex, computed by the caller. */
  readonly sha256: string;
}

/** One version of a blueprint, fetched, verified and rendered by the caller. */
export interface BlueprintRelease {
  readonly manifest: BlueprintManifest;
  /** Every listed part and migration, and nothing else (not `package.json` or `blueprint.json`). */
  readonly files: readonly BlueprintFile[];
  readonly source: BlueprintSource;
}

/** What the planners need to know about the installing app. */
export interface BlueprintAppState {
  /** Every file path in the app, relative to its root. */
  readonly paths: readonly string[];
  /** The installed `@indx-workspace/app` version; `undefined` when it is not installed. */
  readonly appKitVersion: string | undefined;
  /** The app's `aw-generated.json`. */
  readonly manifest: GeneratedManifest;
  /** The agents the project defines already. */
  readonly agents: readonly string[];
  /** The connectors and secrets `agent-workspace.yaml` defines, for each slot's status. */
  readonly connectors: readonly string[];
  readonly secrets: readonly string[];
  /** The index the app's next migration takes in its journal. */
  readonly nextMigrationIndex: number;
}

/** A file to write: where in the app, its text, and its path in the package. */
export interface BlueprintWrite {
  readonly path: string;
  readonly contents: string;
  readonly from: string;
}

/** A migration to write and append to the journal: its index, its tag and where it lands. */
export interface BlueprintMigrationWrite {
  /** Its path in the package: `migrations/<NNNN>_<tag>.sql`. */
  readonly from: string;
  /** Its path in the app: `db/migrations/<tag>.sql`. */
  readonly path: string;
  /** Its journal index. */
  readonly idx: number;
  /** Its journal tag, `<idx as NNNN>_<the package tag>`, as `aw generate resource` writes one. */
  readonly tag: string;
}

/** A connector or secret slot, and whether `agent-workspace.yaml` binds it already (D3). */
export interface BlueprintSlotStatus {
  readonly kind: 'connector' | 'secret';
  readonly slot: string;
  readonly bound: boolean;
}

/** The resources and recipes whose `app.config.ts` lines the caller adds or removes. */
export interface BlueprintWiring {
  readonly resources: readonly string[];
  readonly recipes: readonly string[];
}

/** What `aw blueprint add` writes and records. */
export interface BlueprintInstallPlan {
  /** `blueprint:<name>`. */
  readonly key: string;
  /** Every part and migration, at its path in the app, sorted by path. */
  readonly writes: readonly BlueprintWrite[];
  readonly migrations: readonly BlueprintMigrationWrite[];
  readonly slots: readonly BlueprintSlotStatus[];
  readonly wiring: BlueprintWiring;
  /**
   * The entry to record: each written file's sha256, the source and the migrations. Its `edits`
   * are empty: the caller adds the journal and `app.config.ts` edits it makes.
   */
  readonly entry: GeneratedEntry;
}

/** What `update` proposes for one file (ADR-0166 D7). */
export type BlueprintFileAction = 'add' | 'update' | 'remove' | 'conflict' | 'unchanged';

/** One file of an update's proposal. */
export interface BlueprintFileChange {
  /** The file's path in the app. */
  readonly path: string;
  readonly action: BlueprintFileAction;
  /** The file's path in the package, when the new version has the file. */
  readonly from?: string;
  /**
   * Where `--yes` writes the new version's text: the file itself for `add` and `update`, and the
   * `<file>.blueprint-<version>` sidecar for a `conflict` the new version changes. Absent when
   * nothing is written.
   */
  readonly write?: string;
  /** The new version's text, when it has the file. */
  readonly contents?: string;
}

/** The app as `update` finds it: the app state, and the sha256 of each recorded file on disk. */
export interface BlueprintLocalState extends BlueprintAppState {
  /** Each recorded file's sha256 on disk; a recorded file that is missing has no key. */
  readonly hashes: Readonly<Record<string, string>>;
}

/** What `aw blueprint update` proposes. */
export interface BlueprintUpdatePlan {
  readonly key: string;
  readonly from: BlueprintSource;
  readonly to: BlueprintSource;
  /** Every file of the installed and the new version, sorted by path. */
  readonly changes: readonly BlueprintFileChange[];
  /** The new version's new migrations, renumbered from the app's next journal index. */
  readonly migrations: readonly BlueprintMigrationWrite[];
  readonly slots: readonly BlueprintSlotStatus[];
  /**
   * The `app.config.ts` wiring to add (the parts added), to remove (the parts removed unedited),
   * and to keep (the parts the new version drops that the developer edited: the file becomes
   * theirs, D7, so its wiring stays and its edits leave the entry).
   */
  readonly wiring: {
    readonly add: BlueprintWiring;
    readonly remove: BlueprintWiring;
    readonly keep: BlueprintWiring;
  };
  /**
   * The entry to record after `--yes`: the new version's hash for every file it has (a conflicted
   * one included, D7), the source, the migrations, and the installed entry's edits; the caller
   * adds and reverts the edits of the parts added and removed.
   */
  readonly entry: GeneratedEntry;
}

/** The sidecar a conflicted file's new version is written to: `<file>.blueprint-<version>`. */
export function blueprintSidecarPath(path: string, version: string): string {
  return `${path}.blueprint-${version}`;
}

function refuse(name: string, issues: readonly ProjectRenderIssue[]): ProjectRenderError {
  return new ProjectRenderError(`the blueprint ${name}`, issues);
}

/** An agent part read as ADR-0133's `.agent.md`, or `undefined` with the refusal recorded. */
function readAgentPart(
  file: BlueprintFile,
  issues: ProjectRenderIssue[],
): PortableAgent | undefined {
  try {
    return parseAgentMarkdown(file.contents, file.path);
  } catch (error) {
    if (!(error instanceof ProjectFileError)) throw error;
    issues.push({ path: file.path, message: error.message });
    return undefined;
  }
}

/** The connectors, secrets and tools of one agent part that a blueprint may not carry. */
function checkAgentPart(
  file: BlueprintFile,
  manifest: BlueprintManifest,
  issues: ProjectRenderIssue[],
): void {
  const agent = readAgentPart(file, issues);
  if (agent === undefined) return;
  if (agent.name !== agentNameOf(file.path)) {
    issues.push({ path: file.path, message: `names the agent ${agent.name}, not its file's name` });
  }
  const secrets = new Set(manifest.slots.secrets.map((slot) => slot.slot));
  agent.tools.forEach((tool, index) => {
    const at = `${file.path}: tools.${String(index)}`;
    const connectorUrl =
      (tool.kind === 'mcp' && tool.transport !== 'stdio') ||
      (tool.kind === 'openapi' && tool.baseUrl !== undefined);
    if (connectorUrl) {
      issues.push({
        path: at,
        message:
          'carries a connector URL; the installing app binds connectors in agent-workspace.yaml',
      });
    }
    const secretRef =
      tool.kind === 'openapi' || (tool.kind === 'mcp' && tool.transport !== 'stdio')
        ? tool.auth?.secretRef
        : undefined;
    if (secretRef !== undefined && !secrets.has(secretRef)) {
      issues.push({
        path: at,
        message: `refers to the secret ${secretRef}, which slots.secrets does not list`,
      });
    }
  });
}

/**
 * What both planners check of a release: its app-kit range, that its files are exactly the ones
 * its manifest lists, that each is text, and that each agent part carries only references.
 */
function checkRelease(
  release: BlueprintRelease,
  appKitVersion: string | undefined,
): ProjectRenderIssue[] {
  const { manifest, files, source } = release;
  const issues: ProjectRenderIssue[] = [];
  if (source.version !== manifest.version) {
    issues.push({
      path: 'version',
      message: `is ${manifest.version}, but the package is version ${source.version}`,
    });
  }
  if (appKitVersion === undefined) {
    issues.push({
      path: 'appKit',
      message: `needs @indx-workspace/app ${manifest.appKit}, which the app does not have`,
    });
  } else if (!appKitSatisfies(manifest.appKit, appKitVersion)) {
    issues.push({
      path: 'appKit',
      message: `needs @indx-workspace/app ${manifest.appKit}; the app has ${appKitVersion}`,
    });
  }
  const kinds = new Map<string, BlueprintPartKind | 'migration'>([
    ...manifest.parts.map((part) => [part.path, part.kind] as const),
    ...manifest.migrations.map((path) => [path, 'migration'] as const),
  ]);
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) issues.push({ path: file.path, message: 'is in the package twice' });
    seen.add(file.path);
    const kind = kinds.get(file.path);
    if (kind === undefined) {
      issues.push({ path: file.path, message: `is not a part ${BLUEPRINT_MANIFEST_FILE} lists` });
      continue;
    }
    if (file.contents.includes('\0')) {
      issues.push({ path: file.path, message: 'is not a text file' });
    } else if (kind === 'agent') {
      checkAgentPart(file, manifest, issues);
    }
  }
  for (const path of kinds.keys()) {
    if (!seen.has(path)) {
      issues.push({
        path,
        message: `is listed in ${BLUEPRINT_MANIFEST_FILE} but missing from the package`,
      });
    }
  }
  return issues;
}

function destructiveIssues(file: BlueprintFile): ProjectRenderIssue[] {
  return destructiveMigrations(file.path, file.contents).map((finding) => ({
    path: finding.path,
    message: `is not expand-only (${finding.rule}): ${finding.statement}`,
  }));
}

/** The new migrations, renumbered from the app's next journal index. */
function renumber(paths: readonly string[], nextIndex: number): BlueprintMigrationWrite[] {
  return paths.map((from, offset) => {
    const idx = nextIndex + offset;
    const tag = `${String(idx).padStart(4, '0')}_${MIGRATION_PATH.exec(from)?.[1] ?? ''}`;
    return Object.freeze({ from, idx, tag, path: `${APP_MIGRATIONS_DIR}/${tag}.sql` });
  });
}

function slotStatuses(manifest: BlueprintManifest, app: BlueprintAppState): BlueprintSlotStatus[] {
  const connectors = new Set(app.connectors);
  const secrets = new Set(app.secrets);
  return [
    ...manifest.slots.connectors.map((slot) => ({
      kind: 'connector' as const,
      slot: slot.slot,
      bound: connectors.has(slot.slot),
    })),
    ...manifest.slots.secrets.map((slot) => ({
      kind: 'secret' as const,
      slot: slot.slot,
      bound: secrets.has(slot.slot),
    })),
  ].map((status) => Object.freeze(status));
}

function wiringOf(manifest: BlueprintManifest, paths: ReadonlySet<string>): BlueprintWiring {
  const named = (kind: BlueprintPartKind): readonly string[] =>
    Object.freeze(
      manifest.parts
        .filter((part) => part.kind === kind && paths.has(part.path))
        .map((part) => /([^/]+)\.ts$/u.exec(part.path)?.[1] ?? part.path)
        .sort(),
    );
  return Object.freeze({ resources: named('resource'), recipes: named('recipe') });
}

/** The path each recorded file belongs to, across every entry but `except`. */
function recordedPaths(manifest: GeneratedManifest, except: string): Map<string, string> {
  const owners = new Map<string, string>();
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (key === except) continue;
    for (const path of Object.keys(entry.files)) owners.set(path, key);
  }
  return owners;
}

/** Refuses a destination the app has already, or another entry records. */
function collisionIssues(
  destinations: readonly string[],
  app: BlueprintAppState,
  key: string,
): ProjectRenderIssue[] {
  const existing = new Set(app.paths);
  const owners = recordedPaths(app.manifest, key);
  return destinations.flatMap((path) => {
    const owner = owners.get(path);
    if (owner !== undefined) return [{ path, message: `is recorded by ${owner} already` }];
    return existing.has(path) ? [{ path, message: 'exists already' }] : [];
  });
}

/** Refuses an agent slot the project defines already, unless the blueprint itself created it. */
function agentIssues(
  manifest: BlueprintManifest,
  app: BlueprintAppState,
  installedPaths: ReadonlySet<string>,
): ProjectRenderIssue[] {
  const defined = new Set(app.agents);
  return manifest.slots.agents.flatMap((slot) =>
    defined.has(slot.name) && !installedPaths.has(`agents/${slot.name}.agent.md`)
      ? [
          {
            path: `slots.agents.${slot.name}`,
            message: `the project defines the agent ${slot.name} already`,
          },
        ]
      : [],
  );
}

function byPath<T extends { readonly path: string }>(left: T, right: T): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/**
 * Plans `aw blueprint add` (ADR-0166 D6): each part at its own path, each migration renumbered to
 * the app's next journal index, each slot's status, and the entry to record.
 *
 * @throws {ProjectRenderError} before anything is written, naming every refusal: an `appKit` the
 *   installed app kit does not satisfy, a destination that exists or another entry records (a
 *   path collision), an agent the project defines already, a `blueprint:<name>` installed
 *   already, a destructive migration, a file the manifest does not list or a listed one missing,
 *   and an agent part that carries a connector URL or an unlisted secret.
 */
export function planBlueprintInstall(
  release: BlueprintRelease,
  app: BlueprintAppState,
): BlueprintInstallPlan {
  const { manifest, files, source } = release;
  const key = generatedEntryKey('blueprint', manifest.name);
  const issues = checkRelease(release, app.appKitVersion);
  if (Object.hasOwn(app.manifest.entries, key)) {
    issues.push({ path: key, message: 'is installed already; update it with aw blueprint update' });
  }
  const migrations = renumber(manifest.migrations, app.nextMigrationIndex);
  const destination = new Map<string, string>(manifest.parts.map((part) => [part.path, part.path]));
  for (const migration of migrations) destination.set(migration.from, migration.path);
  issues.push(...collisionIssues([...destination.values()], app, key));
  issues.push(...agentIssues(manifest, app, new Set()));
  const migrationPaths = new Set(manifest.migrations);
  issues.push(
    ...files
      .filter((file) => migrationPaths.has(file.path))
      .flatMap((file) => destructiveIssues(file)),
  );
  if (issues.length > 0) throw refuse(manifest.name, issues);

  const writes = files
    .map((file) =>
      Object.freeze({
        path: destination.get(file.path) ?? file.path,
        contents: file.contents,
        from: file.path,
      }),
    )
    .sort(byPath);
  return Object.freeze({
    key,
    writes: Object.freeze(writes),
    migrations: Object.freeze(migrations),
    slots: Object.freeze(slotStatuses(manifest, app)),
    wiring: wiringOf(manifest, new Set(destination.keys())),
    entry: Object.freeze({
      files: Object.freeze(
        Object.fromEntries(
          files.map((file) => [destination.get(file.path) ?? file.path, file.sha256]),
        ),
      ),
      edits: Object.freeze([]),
      source,
      migrations: Object.freeze(Object.fromEntries(migrations.map((m) => [m.from, m.path]))),
    }),
  });
}

/**
 * The proposal for one file (ADR-0166 D7) from three hashes: the one recorded at install, the
 * one on disk (`undefined` when the file is missing) and the new version's (`undefined` when it
 * removes the file).
 */
function classify(
  recorded: string | undefined,
  local: string | undefined,
  next: string | undefined,
): BlueprintFileAction {
  if (recorded === undefined) return 'add';
  if (local === recorded) {
    if (next === undefined) return 'remove';
    return next === recorded ? 'unchanged' : 'update';
  }
  // Edited or missing on disk. Nothing to propose when the new version leaves the file as it was
  // installed, or already matches the developer's copy; anything else is the developer's to merge.
  if (next === recorded || (next !== undefined && next === local)) return 'unchanged';
  return 'conflict';
}

/** Refuses an installed migration the new version drops, changes or moves after a new one (D8). */
function migrationHistoryIssues(
  installed: Readonly<Record<string, string>>,
  installedFiles: Readonly<Record<string, string>>,
  release: BlueprintRelease,
): ProjectRenderIssue[] {
  const { manifest, files } = release;
  const hashes = new Map(files.map((file) => [file.path, file.sha256]));
  const issues: ProjectRenderIssue[] = [];
  const version = manifest.version;
  for (const [from, to] of Object.entries(installed)) {
    if (!manifest.migrations.includes(from)) {
      issues.push({
        path: from,
        message: `is installed, and ${version} drops it; a version may only append migrations`,
      });
    } else if (hashes.get(from) !== installedFiles[to]) {
      issues.push({
        path: from,
        message: `is installed, and ${version} changes it; a version may only append migrations`,
      });
    }
  }
  const firstNew = manifest.migrations.findIndex((path) => !Object.hasOwn(installed, path));
  if (firstNew !== -1) {
    for (const path of manifest.migrations.slice(firstNew + 1)) {
      if (Object.hasOwn(installed, path)) {
        issues.push({
          path,
          message: `is installed, and ${version} puts a new migration before it`,
        });
      }
    }
  }
  return issues;
}

/** Refuses an unmerged sidecar of any recorded file, so an update never buries one (D7). */
function sidecarIssues(recorded: readonly string[], app: BlueprintAppState): ProjectRenderIssue[] {
  const prefixes = recorded.map((path) => blueprintSidecarPath(path, ''));
  return app.paths
    .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)))
    .map((path) => ({
      path,
      message: 'is the unmerged proposal of an earlier update; merge or delete it first',
    }));
}

function changeFor(
  path: string,
  action: BlueprintFileAction,
  file: BlueprintFile | undefined,
  version: string,
): BlueprintFileChange {
  const write =
    action === 'add' || action === 'update'
      ? path
      : action === 'conflict' && file !== undefined
        ? blueprintSidecarPath(path, version)
        : undefined;
  return Object.freeze({
    path,
    action,
    ...(file === undefined ? {} : { from: file.path, contents: file.contents }),
    ...(write === undefined ? {} : { write }),
  });
}

/**
 * Plans `aw blueprint update` and `aw blueprint diff` (ADR-0166 D7) as a per-file proposal:
 *
 * - unedited on disk: `update` when the new version changes the file, `remove` when it drops it,
 *   `unchanged` otherwise;
 * - edited or missing on disk: `conflict` when the new version changes or drops it, written only
 *   to the `<file>.blueprint-<version>` sidecar (or, when dropped, left as the developer's own);
 *   `unchanged` when the new version leaves it as installed or already matches it;
 * - new in this version: `add`.
 *
 * @param installed - The installed `blueprint:<name>` entry.
 * @param release - The new version.
 * @param local - The app, with the sha256 on disk of each file the entry records.
 * @throws {ProjectRenderError} before anything is written, naming every refusal: a release of
 *   another package, a re-published version (the same version with another integrity), the
 *   refusals of {@link planBlueprintInstall} for what this version adds, an installed migration
 *   dropped or changed, a destructive new migration, and an existing sidecar.
 */
export function planBlueprintUpdate(
  installed: GeneratedEntry,
  release: BlueprintRelease,
  local: BlueprintLocalState,
): BlueprintUpdatePlan {
  const { manifest, files, source } = release;
  const key = generatedEntryKey('blueprint', manifest.name);
  const from = installed.source;
  if (from === undefined) {
    throw refuse(manifest.name, [{ path: key, message: 'is not a blueprint entry' }]);
  }
  const installedMigrations = installed.migrations ?? {};
  const issues = checkRelease(release, local.appKitVersion);
  if (source.package !== from.package) {
    issues.push({
      path: 'source.package',
      message: `is ${source.package}, but ${from.package} is installed`,
    });
  } else if (source.version === from.version && source.integrity !== from.integrity) {
    issues.push({
      path: 'source.integrity',
      message: `differs from the integrity recorded when ${from.version} was installed: the version was re-published`,
    });
  }
  issues.push(...migrationHistoryIssues(installedMigrations, installed.files, release));
  const added = manifest.migrations.filter((path) => !Object.hasOwn(installedMigrations, path));
  const migrations = renumber(added, local.nextMigrationIndex);
  const destination = new Map<string, string>(manifest.parts.map((part) => [part.path, part.path]));
  for (const [path, to] of Object.entries(installedMigrations)) destination.set(path, to);
  for (const migration of migrations) destination.set(migration.from, migration.path);

  const recorded = Object.keys(installed.files);
  const newPaths = [...destination.values()].filter(
    (path) => !Object.hasOwn(installed.files, path),
  );
  issues.push(...collisionIssues(newPaths, local, key));
  issues.push(...agentIssues(manifest, local, new Set(recorded)));
  issues.push(...sidecarIssues(recorded, local));
  const addedMigrations = new Set(added);
  issues.push(
    ...files
      .filter((file) => addedMigrations.has(file.path))
      .flatMap((file) => destructiveIssues(file)),
  );
  if (issues.length > 0) throw refuse(manifest.name, issues);

  const byDestination = new Map(
    files.map((file) => [destination.get(file.path) ?? file.path, file]),
  );
  const paths = [...new Set([...recorded, ...byDestination.keys()])].sort();
  const changes = paths.map((path) => {
    const file = byDestination.get(path);
    const action = classify(installed.files[path], local.hashes[path], file?.sha256);
    return changeFor(path, action, file, manifest.version);
  });
  const partsWith = (actions: readonly BlueprintFileAction[]): ReadonlySet<string> =>
    new Set(
      changes.filter((change) => actions.includes(change.action)).map((change) => change.path),
    );
  return Object.freeze({
    key,
    from,
    to: source,
    changes: Object.freeze(changes),
    migrations: Object.freeze(migrations),
    slots: Object.freeze(slotStatuses(manifest, local)),
    wiring: Object.freeze({
      add: wiringOf(manifest, partsWith(['add'])),
      remove: droppedWiring(changes, byDestination, (change) =>
        change.action === 'remove'
          ? true
          : change.action === 'conflict' && local.hashes[change.path] === undefined,
      ),
      keep: droppedWiring(
        changes,
        byDestination,
        (change) => change.action === 'conflict' && local.hashes[change.path] !== undefined,
      ),
    }),
    entry: Object.freeze({
      files: Object.freeze(
        Object.fromEntries([...byDestination].map(([path, file]) => [path, file.sha256])),
      ),
      edits: installed.edits,
      source,
      migrations: Object.freeze({
        ...installedMigrations,
        ...Object.fromEntries(migrations.map((migration) => [migration.from, migration.path])),
      }),
    }),
  });
}

/**
 * The installed resources and recipes the new version drops that `chosen` picks: for `remove`, a
 * file deleted unedited or already gone from disk, whose wiring goes with it; for `keep`, an
 * edited file that stays as the developer's own, whose wiring stays too (ADR-0166 D7).
 */
function droppedWiring(
  changes: readonly BlueprintFileChange[],
  next: ReadonlyMap<string, BlueprintFile>,
  chosen: (change: BlueprintFileChange) => boolean,
): BlueprintWiring {
  const dropped = (root: string): readonly string[] =>
    Object.freeze(
      changes
        .filter((change) => !next.has(change.path) && chosen(change))
        .flatMap((change) => {
          const name = new RegExp(`^${root}/(${FILE_NAME})\\.ts$`, 'u').exec(change.path)?.[1];
          return name === undefined ? [] : [name];
        })
        .sort(),
    );
  return Object.freeze({ resources: dropped('resources'), recipes: dropped('recipes') });
}
