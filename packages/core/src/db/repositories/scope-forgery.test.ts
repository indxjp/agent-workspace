/**
 * The compile-time gate: **a repository cannot be constructed without a `WorkspaceScope`, and a
 * repository method cannot be handed a workspace id.**
 *
 * A property that is a compile error cannot be tested by code that compiles, so this block runs
 * the compiler. It writes a fixture whose every forgery sits on one line tagged `FORBIDDEN`, runs
 * `tsc` over it under the repository's own `tsconfig.json` — extended, not copied, so this gate
 * cannot drift from the settings the build uses — and then decides on positive assertions in both
 * directions:
 *
 *   * every `FORBIDDEN` line must carry at least one diagnostic, matched by line number, so one
 *     forgery being rejected cannot stand in for another;
 *   * every `PERMITTED` line must carry none, so the fixture cannot pass by being broken;
 *   * every `DECLARED` line must carry none either — those are the escapes `scope.ts` says it does
 *     not close at compile time, and asserting they still compile is what keeps that declaration
 *     from going stale;
 *   * a diagnostic on any *other* line fails the test rather than being ignored, because an
 *     unexpected error means the fixture is not compiling for the reason claimed.
 *
 * A non-zero exit code alone would satisfy none of that, which is why it is not what is asserted
 * (ADR-0015).
 *
 * The structure is lifted deliberately from `tests/auth.test.ts`, which is the gate W1-CP-06 built
 * for the *possession* half of the same rule. This is the *use* half. Two gates of one shape is
 * the point: an author adding the seventh Wave 2 repository copies a file they can already read.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createInMemoryWorkspaceScopeResolver,
  ForgedWorkspaceScopeError,
  WorkspaceScope,
} from './scope.js';
// The declared escape, imported here because the `db`-taking provider factories live on it and
// this file is a *.test.ts — the one importer shape `database-reachability.test.ts` admits.
import * as unscoped from './unscoped.js';

/** What every `createDatabase…Provider` is, as far as this file needs to know. */
type Factory = (db: never) => { forScope: (scope: unknown) => unknown };

/** `…/packages/core/src/db/repositories/<this file>` → the repository root, six levels up. */
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..');

/** Repository-relative, forward slashes, so a `git` pathspec means the same thing on either OS. */
const posixPath = (value: string): string => value.split(path.sep).join('/');

describe('a repository cannot be built or queried without a WorkspaceScope (compile-time)', () => {
  const fixtureDir = path.join(repoRoot, 'node_modules', '.w2db02-type-negative');
  const fixtureFile = path.join(fixtureDir, 'forgery.ts');
  const posix = (value: string): string => value.split(path.sep).join('/');

  /**
   * `node_modules` because it is the one directory inside the repository that no `tsconfig.json`
   * includes, that ESLint ignores by default, that Prettier's globs do not reach and that git
   * ignores — so a fixture that must NOT type-check cannot break `pnpm typecheck`, `pnpm lint`,
   * `pnpm format:check` or a working tree several sessions are writing to, and a crashed run
   * leaves nothing tracked behind.
   */
  const fixtureSource = [
    "import { createDatabaseAgentRepositoryProvider, createDatabaseWorkspaceScopeResolver } from '../../packages/core/src/db/repositories/unscoped.js';",
    "import { WorkspaceScope } from '../../packages/core/src/db/repositories/index.js';",
    "import type { AgentRepositoryProvider } from '../../packages/core/src/db/repositories/index.js';",
    "import type { Database } from '../../packages/core/src/db/client.js';",
    '',
    'declare const db: Database;',
    "const body = JSON.parse('{}') as { workspace: string; agentId: string };",
    'const agents: AgentRepositoryProvider = createDatabaseAgentRepositoryProvider(db);',
    '',
    '// Every shape a handler author could plausibly reach for, one per line.',
    'export const a = agents.forScope(body.workspace); // FORBIDDEN a workspace id string where the scope goes',
    'export const b = agents.forScope({ workspaceId: body.workspace }); // FORBIDDEN the scope written out as an object literal',
    'export const c = async () => agents.forScope({ ...(await legitimateScope()), workspaceId: body.workspace }); // FORBIDDEN a real scope spread and its tenant overwritten',
    'export const d = new WorkspaceScope(body.workspace); // FORBIDDEN the constructor called directly',
    'export const e = async () => agents.forScope(await legitimateScope()).list(body.workspace); // FORBIDDEN a workspace id handed to a read',
    'export const f = async () => agents.forScope(await legitimateScope()).get(body.agentId, body.workspace); // FORBIDDEN a workspace id handed alongside the row id',
    'export const g = async () => agents.forScope(await legitimateScope()).delete(body.agentId, body.workspace); // FORBIDDEN a workspace id handed to a write',
    '',
    '// Escapes this task did not close at compile time. Each is a declared gap in the PR body, and',
    '// each is asserted here to compile clean so the declaration cannot quietly go stale.',
    'export const h = agents.forScope(body.workspace as unknown as WorkspaceScope); // DECLARED a cast defeats every type in the program; refused at run time by requireWorkspaceScope, asserted below',
    'export const i = agents.forScope(Object.create(WorkspaceScope.prototype) as WorkspaceScope); // DECLARED the prototype conjured directly; refused at run time by requireWorkspaceScope, asserted below',
    'export const j = async (): Promise<WorkspaceScope> => Object.assign(await legitimateScope(), { workspaceId: body.workspace }); // DECLARED Object.assign onto a real scope: no diagnostic, and a TypeError at run time because the scope is frozen',
    'export const k = async () => createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(body.workspace); // DECLARED a holder of the Database handle can resolve a scope for any workspace id; the public surface hands out no handle, and this import is the declared escape subpath',
    '',
    '// The one way that is meant to work, so a fixture that fails everywhere fails this test.',
    'export async function legitimateScope(): Promise<WorkspaceScope> {',
    "  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceSlug('acme'); // PERMITTED the only derivation there is",
    "  if (scope === null) throw new Error('no such workspace');",
    '  return scope;',
    '}',
  ].join('\n');

  const fixtureConfig = (): string =>
    JSON.stringify(
      {
        extends: posix(path.join(repoRoot, 'tsconfig.json')),
        compilerOptions: { noEmit: true, types: ['node'] },
        files: ['./forgery.ts'],
      },
      null,
      2,
    );

  /**
   * Line numbers are read back out of the fixture, never written down here (W0-DOC-01).
   *
   * The tag is matched on a word boundary, and every line that so much as *mentions* a tag must
   * have been matched as carrying it — otherwise a forgery tagged `// FORBIDDEN` with no trailing
   * description would generate no assertion and go unchecked, which is ADR-0015's failure inside
   * the gate written to enforce ADR-0015.
   */
  const linesTagged = (tag: string): readonly number[] => {
    const marker = new RegExp(`//\\s*${tag}\\b`, 'u');
    return fixtureSource
      .split('\n')
      .map((line, index) => (marker.test(line) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);
  };

  const linesMentioning = (tag: string): readonly number[] =>
    fixtureSource
      .split('\n')
      .map((line, index) => (line.includes(tag) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);

  let diagnostics: readonly { readonly line: number; readonly text: string }[] = [];
  /** Diagnostics tsc raised outside the fixture. Asserted empty; never dropped. */
  let elsewhere: readonly string[] = [];
  let rawOutput = '';

  beforeAll(() => {
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(fixtureFile, fixtureSource, 'utf8');
    writeFileSync(path.join(fixtureDir, 'tsconfig.json'), fixtureConfig(), 'utf8');

    const tsc = path.join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
    if (!existsSync(tsc)) throw new Error('typescript is not installed — run `pnpm install`');
    try {
      rawOutput = execFileSync(process.execPath, [tsc, '-p', fixtureDir, '--pretty', 'false'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // A non-zero exit is the expected outcome; tsc writes its diagnostics to stdout.
      const failure = error as { stdout?: string; stderr?: string };
      rawOutput = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    const pattern = /^(?<file>.+?)\((?<line>\d+),\d+\): (?<text>error TS\d+: .*)$/u;
    const mine: { line: number; text: string }[] = [];
    const theirs: string[] = [];
    for (const line of rawOutput.split(/\r?\n/u)) {
      const match = pattern.exec(line);
      if (match === null) {
        // Not a diagnostic line: a blank line, or tsc's own "Found N errors." summary.
      } else if (posix(match.groups?.['file'] ?? '').endsWith('forgery.ts')) {
        mine.push({ line: Number(match.groups?.['line']), text: match.groups?.['text'] ?? '' });
      } else {
        // Partitioned, not filtered. A diagnostic raised in an imported module means the fixture
        // is not compiling for the reason claimed, and dropping those rows is how a gate that
        // proves nothing stays green (ADR-0027 clause 3). It is asserted empty below.
        theirs.push(line);
      }
    }
    diagnostics = mine;
    elsewhere = theirs;
  }, 300_000);

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('has forgeries to reject, a legitimate derivation to admit and declared gaps to record', () => {
    expect(linesTagged('FORBIDDEN').length).toBeGreaterThan(0);
    expect(linesTagged('PERMITTED').length).toBeGreaterThan(0);
    expect(linesTagged('DECLARED').length).toBeGreaterThan(0);
    expect(linesTagged('FORBIDDEN')).toEqual(linesMentioning('FORBIDDEN'));
    expect(linesTagged('PERMITTED')).toEqual(linesMentioning('PERMITTED'));
    expect(linesTagged('DECLARED')).toEqual(linesMentioning('DECLARED'));
  });

  it.each(linesTagged('FORBIDDEN'))('rejects the forgery on fixture line %i', (line) => {
    const onThisLine = diagnostics.filter((diagnostic) => diagnostic.line === line);
    expect(
      onThisLine.length,
      `no compile error on fixture line ${String(line)}. tsc said:\n${rawOutput}`,
    ).toBeGreaterThan(0);
  });

  it.each(linesTagged('PERMITTED'))('admits the legitimate derivation on line %i', (line) => {
    expect(diagnostics.filter((diagnostic) => diagnostic.line === line)).toEqual([]);
  });

  it.each(linesTagged('DECLARED'))(
    'still compiles the declared escape on line %i, so the declared gap is not stale',
    (line) => {
      expect(
        diagnostics.filter((diagnostic) => diagnostic.line === line),
        `fixture line ${String(line)} is tagged DECLARED but the compiler now rejects it. That is ` +
          'good news: close the gap in the PR body and retag the line FORBIDDEN.',
      ).toEqual([]);
    },
  );

  it('reports nothing on any line that is not tagged FORBIDDEN', () => {
    const expected = new Set(linesTagged('FORBIDDEN'));
    const unexpected = diagnostics.filter((diagnostic) => !expected.has(diagnostic.line));
    // The explicit else. Without it a fixture that failed to parse would satisfy every assertion
    // above and this gate would pass while proving nothing (ADR-0015).
    expect(unexpected, `unexpected diagnostics:\n${rawOutput}`).toEqual([]);
  });

  it('reports nothing in any file other than the fixture', () => {
    expect(
      elsewhere,
      'tsc raised a diagnostic outside the fixture, so the FORBIDDEN lines above may be failing ' +
        `for a reason this gate did not claim. tsc said:\n${rawOutput}`,
    ).toEqual([]);
  });
});

/**
 * **The second half of the same property: a query that reaches the database with no scope at all
 * does not compile against the package's public surface.**
 *
 * Verification round 1 of W2-DB-02 found the first half holding and this half absent.
 * `packages/core/src/db/index.ts` re-exported the connection factory and every schema table beside
 * the scope-bound repositories, so a real Next.js route handler could write
 * `createDatabase(createPool(readDatabaseConfig(process.env)))` and then select or delete every
 * tenant's rows, with `tsc` and `eslint` both exiting 0 and no test objecting. A gate on the
 * repository *constructor* proves nothing while the repository *layer* is optional.
 *
 * The fixture below is the verifier's own reproduction, one statement per line, imported from
 * `@agent-workspace/core/db` exactly as a route handler would import it — which is why it lives
 * under `apps/web/node_modules`, the only place in the tree from which that specifier resolves.
 * Its tags are read the same way the block above reads them: `FORBIDDEN` lines must each carry a
 * diagnostic, `PERMITTED` and `DECLARED` lines must carry none, and a diagnostic anywhere else
 * fails the test rather than being ignored.
 */
describe('the public database surface hands out no way to reach PostgreSQL (compile-time)', () => {
  const fixtureDir = path.join(repoRoot, 'apps', 'web', 'node_modules', '.w2db02-surface-negative');
  const fixtureFile = path.join(fixtureDir, 'surface.ts');
  const posix = (value: string): string => value.split(path.sep).join('/');

  const fixtureSource = [
    "import { openDatabaseRoot } from '@agent-workspace/core/db';",
    "import * as db from '@agent-workspace/core/db';",
    "import { createDatabase, createPool } from '@agent-workspace/core/db/unscoped';",
    '',
    "const body = JSON.parse('{}') as { workspaceId: string; agentId: string };",
    '',
    '// The verification round 1 reproduction: the three-call expression that produced a handle, a',
    '// table object, and the five queries that forgot the tenant. One per line.',
    'export const open = () => db.createDatabase(db.createPool(db.readDatabaseConfig(process.env))); // FORBIDDEN the three-call expression the verifier used to obtain a handle',
    'export const handle = db.createDatabase; // FORBIDDEN the connection factory is not on the public surface',
    'export const pool = db.createPool; // FORBIDDEN nor is the pool factory',
    'export const config = db.readDatabaseConfig; // FORBIDDEN nor is the environment reader',
    'export const table = db.agents; // FORBIDDEN no schema table is on the public surface',
    'export const everyAgentEverywhere = async () => open().select().from(db.agents); // FORBIDDEN a select with no where clause at all',
    'export const anyWorkspaceIWant = async () => open().query.agents.findMany({ where: (r, { eq }) => eq(r.workspaceId, body.workspaceId) }); // FORBIDDEN a workspace id off a request body',
    'export const anyAgentById = async () => open().query.agents.findFirst({ where: (r, { eq }) => eq(r.id, body.agentId) }); // FORBIDDEN a cross-tenant read by row id',
    'export const deleteEverything = async () => open().delete(db.agents); // FORBIDDEN a cross-tenant WRITE',
    "export const viaDeepPath = async () => import('@agent-workspace/core/db/client'); // FORBIDDEN the exports map admits no deep path into the layer",
    '',
    '// Verification round 2. `runSeed` was on this surface: it takes a caller-supplied workspace',
    '// slug and email, resolves the workspace by slug with `onConflictDoNothing`, and inserts an',
    '// `owner` membership row into whatever tenant that slug already names — a cross-tenant write',
    '// with no WorkspaceScope in it. `runMigrations` was beside it. Neither is a handle and neither',
    '// is a table, which is why the lines above did not cover them.',
    'export const seedAnyTenant = async () => db.runSeed(undefined, { workspaceSlug: body.workspaceId, workspaceName: "x", adminEmail: "attacker@example.com", adminName: "x" }); // FORBIDDEN a cross-tenant membership WRITE off a request body',
    'export const seedEntryPoint = db.runSeed; // FORBIDDEN the seed entry point is not on the public surface',
    'export const seedOptions = db.readSeedOptions; // FORBIDDEN nor is its environment reader',
    'export const migrateEntryPoint = db.runMigrations; // FORBIDDEN nor is the migration entry point, which opens a connection of its own',
    '',
    '// The escape this task declares rather than closes. Asserted to compile clean, so the',
    '// declaration on the PR cannot go stale without this test going red.',
    "export const viaEscapeSubpath = createDatabase(createPool({ url: 'postgres://h/d', maxConnections: 1 })); // DECLARED @agent-workspace/core/db/unscoped compiles anywhere; it throws at import outside a test process, and database-reachability.test.ts fails by name on any non-test importer",
    '',
    '// The one way that is meant to work.',
    'export const root = async () => openDatabaseRoot(process.env); // PERMITTED the whole of the public surface, and it returns scope-bound providers and no handle',
  ].join('\n');

  const fixtureConfig = (): string =>
    JSON.stringify(
      {
        extends: posix(path.join(repoRoot, 'tsconfig.json')),
        compilerOptions: { noEmit: true, types: ['node'] },
        files: ['./surface.ts'],
      },
      null,
      2,
    );

  const linesTagged = (tag: string): readonly number[] => {
    const marker = new RegExp(`//\\s*${tag}\\b`, 'u');
    return fixtureSource
      .split('\n')
      .map((line, index) => (marker.test(line) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);
  };

  const linesMentioning = (tag: string): readonly number[] =>
    fixtureSource
      .split('\n')
      .map((line, index) => (line.includes(tag) ? index + 1 : 0))
      .filter((lineNumber) => lineNumber > 0);

  let diagnostics: readonly { readonly line: number; readonly text: string }[] = [];
  /** Diagnostics tsc raised outside the fixture. Asserted empty; never dropped. */
  let elsewhere: readonly string[] = [];
  let rawOutput = '';

  beforeAll(() => {
    mkdirSync(fixtureDir, { recursive: true });
    // `apps/web/package.json` declares no `type`, so a fixture below it would be read as
    // CommonJS and `verbatimModuleSyntax` would reject every `import` statement in it. Saying so
    // here is one line; discovering it is a compile error on every line of the fixture.
    writeFileSync(path.join(fixtureDir, 'package.json'), '{ "type": "module" }\n', 'utf8');
    writeFileSync(fixtureFile, fixtureSource, 'utf8');
    writeFileSync(path.join(fixtureDir, 'tsconfig.json'), fixtureConfig(), 'utf8');

    const tsc = path.join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
    if (!existsSync(tsc)) throw new Error('typescript is not installed — run `pnpm install`');
    try {
      rawOutput = execFileSync(process.execPath, [tsc, '-p', fixtureDir, '--pretty', 'false'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      rawOutput = `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
    }

    const pattern = /^(?<file>.+?)\((?<line>\d+),\d+\): (?<text>error TS\d+: .*)$/u;
    const mine: { line: number; text: string }[] = [];
    const theirs: string[] = [];
    for (const line of rawOutput.split(/\r?\n/u)) {
      const match = pattern.exec(line);
      if (match === null) {
        // Not a diagnostic line: a blank line, or tsc's own "Found N errors." summary.
      } else if (posix(match.groups?.['file'] ?? '').endsWith('surface.ts')) {
        mine.push({ line: Number(match.groups?.['line']), text: match.groups?.['text'] ?? '' });
      } else {
        // Partitioned, not filtered — see the same partition in the first block. Asserted empty
        // below rather than dropped.
        theirs.push(line);
      }
    }
    diagnostics = mine;
    elsewhere = theirs;
  }, 300_000);

  afterAll(() => {
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('has forgeries to reject, a legitimate entry point to admit and a declared escape to record', () => {
    expect(linesTagged('FORBIDDEN').length).toBeGreaterThan(0);
    expect(linesTagged('PERMITTED').length).toBeGreaterThan(0);
    expect(linesTagged('DECLARED').length).toBeGreaterThan(0);
    expect(linesTagged('FORBIDDEN')).toEqual(linesMentioning('FORBIDDEN'));
    expect(linesTagged('PERMITTED')).toEqual(linesMentioning('PERMITTED'));
    expect(linesTagged('DECLARED')).toEqual(linesMentioning('DECLARED'));
  });

  it.each(linesTagged('FORBIDDEN'))('rejects the unscoped query on fixture line %i', (line) => {
    const onThisLine = diagnostics.filter((diagnostic) => diagnostic.line === line);
    expect(
      onThisLine.length,
      `no compile error on fixture line ${String(line)}. tsc said:\n${rawOutput}`,
    ).toBeGreaterThan(0);
  });

  it.each(linesTagged('PERMITTED'))('admits the public entry point on line %i', (line) => {
    expect(
      diagnostics.filter((diagnostic) => diagnostic.line === line),
      `tsc rejected the legitimate line ${String(line)}:\n${rawOutput}`,
    ).toEqual([]);
  });

  it.each(linesTagged('DECLARED'))(
    'still compiles the declared escape on line %i, so the declared gap is not stale',
    (line) => {
      expect(
        diagnostics.filter((diagnostic) => diagnostic.line === line),
        `fixture line ${String(line)} is tagged DECLARED but the compiler now rejects it. That is ` +
          'good news: close the gap in the PR body and retag the line FORBIDDEN.',
      ).toEqual([]);
    },
  );

  it('reports nothing on any line that is not tagged FORBIDDEN', () => {
    const expected = new Set(linesTagged('FORBIDDEN'));
    const unexpected = diagnostics.filter((diagnostic) => !expected.has(diagnostic.line));
    expect(unexpected, `unexpected diagnostics:\n${rawOutput}`).toEqual([]);
  });

  it('reports nothing in any file other than the fixture', () => {
    expect(
      elsewhere,
      'tsc raised a diagnostic outside the fixture, so the FORBIDDEN lines above may be failing ' +
        `for a reason this gate did not claim. tsc said:\n${rawOutput}`,
    ).toEqual([]);
  });
});

/**
 * **The run-time half of the two DECLARED compile-time escapes: every provider factory in the
 * database layer refuses a forged scope, and the set of factories is derived from the tracked tree
 * by the compiler's own types.**
 *
 * ## Why this block exists
 *
 * The fixture above tags an `as WorkspaceScope` cast and `Object.create(WorkspaceScope.prototype)`
 * `DECLARED`, and until verification round 1 the tag carried the sentence "`isWorkspaceScope`
 * refuses the value at run time". It did not. `WorkspaceScope.isWorkspaceScope` had **no call site
 * outside its own unit test**, and the verifier used both forgeries against a real PostgreSQL to
 * read another workspace's rows. A declared gap presented as mitigated by a control that is never
 * invoked is worse than an undeclared one, because it stops the next reader looking.
 *
 * `requireWorkspaceScope` is now that call site, and this block is what keeps it one.
 *
 * ## How the provider set is derived (ADR-0027), and why it is no longer derived from text
 *
 * Verification round 2 wrote `packages/core/src/db/repositories/skills.ts` containing
 *
 * ```text
 * export const createDatabaseSkillRepositoryProvider = (db: Database): SkillRepositoryProvider =>
 *   ({ forScope(scope) { … } });        // no requireWorkspaceScope anywhere
 * ```
 *
 * and this suite stayed green, because the set was derived by matching
 * `/^export function (createDatabase[A-Za-z]*Provider)\(/` against each module's text. A regular
 * expression over source text recognises a *syntax*, and the arrow-function form is a different
 * syntax for the same thing. So the derivation now asks the type checker instead:
 *
 *   1. the contributing set is `git ls-files` under the database layer, whose location comes from
 *      this file's own path rather than from a written one; every tracked path there is either
 *      `<name>.test.ts` (a suite) or `<name>.ts` (a module), and anything else is a hard failure
 *      naming the file, never a skip;
 *   2. a `ts.Program` is built over the modules, and **every exported value in every one of them**
 *      is classified by its type: a value with a call signature whose return type has a `forScope`
 *      member is a provider factory, whatever syntax declared it; a value without one is not, and
 *      that is the arm that makes this a classification;
 *   3. a factory so found must be reachable through `./unscoped.js` — one that is not is a hard
 *      failure naming the file and the export, because a gate that silently checked fewer
 *      providers than exist is the filter-instead-of-classifier failure ADR-0027 clause 3 is
 *      about.
 *
 * There is no list of provider names and no naming convention in this file, and the failure output
 * prints what was derived.
 */
describe('every repository provider refuses a forged scope at run time', () => {
  /**
   * The database layer's directory, from this file's own location: `<layer>/repositories/<this>`.
   * Deriving it this way is what keeps a second literal path out of a gate whose whole subject is
   * literals (ADR-0027 clause 2).
   */
  const layerDir = posixPath(
    path.relative(repoRoot, path.resolve(fileURLToPath(import.meta.url), '..', '..')),
  );

  /** The contributing set: the tracked tree under the database layer, by shape. */
  const tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', '--', layerDir], {
    encoding: 'utf8',
  })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const modules: string[] = [];
  const suites: string[] = [];
  for (const file of tracked) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    if (/^[a-z][a-z0-9.-]*\.test\.ts$/u.test(base)) {
      suites.push(file);
    } else if (/^[a-z][a-z0-9.-]*\.ts$/u.test(base)) {
      modules.push(file);
    } else {
      // The explicit else. A file at the right path that matches neither shape is a file this
      // gate cannot classify, and it fails naming the file rather than dropping the row.
      throw new Error(
        `${file} is tracked under ${layerDir} and matches neither <name>.ts nor <name>.test.ts, ` +
          'so this gate cannot classify it.',
      );
    }
  }

  /**
   * Is this exported value a provider factory? Asked of the type, not of the text: it is one if it
   * can be called and what the call returns carries a `forScope` member. `export function f(db) {}`
   * and `export const f = (db) => ({ forScope … })` are indistinguishable here, which is the point.
   */
  const isProviderFactory = (checker: ts.TypeChecker, type: ts.Type): boolean =>
    type
      .getCallSignatures()
      .some((signature) => checker.getReturnTypeOfSignature(signature).getProperty('forScope'));

  const reachable = unscoped as unknown as Record<string, unknown>;
  const derived: { readonly file: string; readonly name: string; readonly factory: Factory }[] = [];

  {
    const configPath = path.join(repoRoot, 'tsconfig.json');
    const rawConfig = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
    if (rawConfig.error !== undefined) {
      throw new Error(`${configPath} could not be read, so this gate cannot type the layer.`);
    }
    const parsed = ts.parseJsonConfigFileContent(
      rawConfig.config,
      ts.sys,
      path.dirname(configPath),
    );
    const program = ts.createProgram({
      rootNames: modules.map((file) => path.join(repoRoot, file)),
      options: { ...parsed.options, noEmit: true, types: ['node'] },
    });
    const syntactic = program.getSyntacticDiagnostics();
    if (syntactic.length > 0) {
      throw new Error(
        `${layerDir} does not parse: ${ts.formatDiagnostics(syntactic, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => repoRoot,
          getNewLine: () => '\n',
        })}`,
      );
    }
    const checker = program.getTypeChecker();
    const seen = new Set<string>();
    for (const file of modules) {
      const source = program.getSourceFile(path.join(repoRoot, file));
      if (source === undefined) {
        throw new Error(`${file} is tracked under ${layerDir} but the compiler did not load it.`);
      }
      const moduleSymbol = checker.getSymbolAtLocation(source);
      // The explicit else. A tracked `.ts` the checker sees as a script rather than a module has
      // no exports to classify, and this gate must say so rather than contribute nothing for it.
      if (moduleSymbol === undefined) {
        throw new Error(
          `${file} has no module symbol — the checker read it as a script, so its exports could ` +
            'not be classified.',
        );
      }
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const name = exported.getName();
        const declaration = exported.valueDeclaration ?? exported.declarations?.[0];
        // The explicit else. An exported symbol the checker gives no declaration for is one whose
        // type this gate cannot ask about, and it must say so rather than pass over it.
        if (declaration === undefined) {
          throw new Error(
            `${file} exports ${name} with no declaration the checker will type, so this gate ` +
              'cannot decide whether it is a repository provider factory.',
          );
        }
        const type = checker.getTypeOfSymbolAtLocation(exported, declaration);
        if (isProviderFactory(checker, type)) {
          const factory = reachable[name];
          // The explicit else, again: a provider factory this block cannot call is a provider
          // factory this block is not checking, and saying nothing would leave the gate green
          // over a gap.
          if (typeof factory !== 'function') {
            throw new Error(
              `${file} exports ${name}, whose return type carries a "forScope" member, so it is ` +
                'a repository provider factory — but it is not reachable through ' +
                `${layerDir}/repositories/unscoped.ts, so this gate cannot check that it refuses ` +
                'a forged scope. Re-export it there.',
            );
          }
          // `unscoped.ts` and `index.ts` re-export the same factories the modules declare, so the
          // same name arrives more than once. It is one factory and it is checked once.
          if (!seen.has(name)) {
            seen.add(name);
            derived.push({ file, name, factory: factory as Factory });
          }
        } else {
          // The other arm: an export whose type has no call signature returning something with a
          // `forScope` member cannot construct a repository for a scope, so there is nothing here
          // for this block to exercise. Type predicates, record types, table objects and
          // `openDatabaseRoot` all land here.
        }
      }
    }
  }

  /** The set this block derived, printed on every failure (ADR-0027 clause 4). */
  const derivedSet = derived.map((row) => `${row.name} (${row.file})`).join(', ');

  /** A handle that would throw on any query, so a refusal cannot be mistaken for a query result. */
  const noDatabase = {} as never;

  /** The two forgeries the fixture above tags DECLARED, plus the object-literal cast. */
  const forgeries: readonly (readonly [string, () => unknown])[] = [
    ['a workspace id string cast to WorkspaceScope', (): unknown => 'workspace-b'],
    ['an object literal cast to WorkspaceScope', (): unknown => ({ workspaceId: 'workspace-b' })],
    [
      'Object.create(WorkspaceScope.prototype)',
      (): unknown => Object.create(WorkspaceScope.prototype) as unknown,
    ],
    ['a JSON round trip of a real scope', (): unknown => JSON.parse('{"workspaceId":"b"}')],
  ];

  it('derived at least one provider from the tracked tree, and a suite alongside it', () => {
    // ADR-0015: a check that cannot run must fail. An empty derivation would make every assertion
    // below vacuous, which is exactly how a broken shape rule passes.
    expect(
      derived.length,
      `no provider factory was derived from ${String(modules.length)} tracked modules under ` +
        `${layerDir}. The type rule, the program or the tracked listing is broken.`,
    ).toBeGreaterThan(0);
    expect(suites.length, 'no *.test.ts was found in the same listing').toBeGreaterThan(0);
  });

  it.each(derived.map((row) => [row.name, row.factory] as const))(
    '%s refuses every forged scope and admits a minted one',
    (name, factory) => {
      const provider = factory(noDatabase);
      for (const [label, forge] of forgeries) {
        expect(
          () => provider.forScope(forge()),
          `${name} did not refuse ${label}. Derived providers: ${derivedSet}`,
        ).toThrow(ForgedWorkspaceScopeError);
      }
    },
  );

  it.each(derived.map((row) => [row.name, row.factory] as const))(
    '%s admits a scope the resolver minted, so the refusal is not refusing everything',
    async (name, factory) => {
      const workspaceId = '5f0f6b1e-0f8f-4a1e-9f4a-1c2d3e4f5a6b';
      const scope = await createInMemoryWorkspaceScopeResolver([
        { id: workspaceId, slug: 'acme' },
      ]).forWorkspaceId(workspaceId);
      expect(scope, 'the in-memory resolver minted no scope for a workspace it was given').not.toBe(
        null,
      );
      expect(
        () => factory(noDatabase).forScope(scope),
        `${name} refused a scope the resolver minted. Derived providers: ${derivedSet}`,
      ).not.toThrow();
    },
  );
});
