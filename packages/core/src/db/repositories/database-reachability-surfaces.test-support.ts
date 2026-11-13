import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  repoRoot,
  posix,
  repoRelativeReal,
  OWNING_PACKAGE,
  PACKAGE,
  MANIFEST,
  allTargets,
  publicTargets,
  publicSubpaths,
  databaseSubpaths,
  insideLayer,
  type DeclaredTarget,
} from './database-reachability-manifest.test-support.js';
import { parseConfigHost } from './database-reachability-resolution.test-support.js';

// Inspect every export condition and follow aliases to their ultimate declaration.
// A type stub must not conceal a runtime re-export of a private database symbol.
interface ExportProgram {
  readonly checker: ts.TypeChecker;
  readonly byRelative: ReadonlyMap<string, ts.SourceFile>;
}
function createExportProgram(): ts.Program {
  const configPath = path.join(repoRoot, OWNING_PACKAGE, 'tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, parseConfigHost);
  if (parsed === undefined) {
    throw new Error(`${OWNING_PACKAGE}tsconfig.json did not parse, so this gate cannot run.`);
  }
  const conditionRoots = allTargets.map((row) => {
    const absolute = path.join(repoRoot, row.target);
    if (!existsSync(absolute)) {
      throw new Error(
        `${MANIFEST} exports "${row.subpath}" with "${row.condition}": "${row.target}", which ` +
          'is not on disk. This gate reads the names every condition of every subpath exposes ' +
          `and cannot read them out of a file that is absent. Run \`pnpm --filter ${PACKAGE} ` +
          'run build` before `pnpm test`; CI does this in a step of its own.',
      );
    }
    return absolute;
  });
  // A declaration in a dependency is never inside the layer, which is the only place this case
  // looks, so a dependency's own source is handed to the compiler empty instead of being read,
  // parsed and bound. The export surfaces pulled in through the storage and secrets subpaths
  // reach AWS, Azure and gRPC SDKs, ~1,900 declaration files that nothing below asks about.
  const options = { ...parsed.options, allowJs: true, checkJs: false, noEmit: true };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, ...rest): ts.SourceFile | undefined =>
    posix(fileName).includes('/node_modules/')
      ? ts.createSourceFile(fileName, '', languageVersionOrOptions, false, ts.ScriptKind.TS)
      : readSource(fileName, languageVersionOrOptions, ...rest);
  const program = ts.createProgram({ rootNames: conditionRoots, options, host });
  return program;
}

/** Follow a re-export chain to the symbol it ultimately names. */
function ultimateDeclaration(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    const next = checker.getAliasedSymbol(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Every name one *condition* exposes, with the files those names are declared in. */
function surfaceOfCondition(
  row: DeclaredTarget,
  context: ExportProgram,
): ReadonlyMap<string, readonly string[]> {
  const { checker, byRelative } = context;
  const file = byRelative.get(repoRelativeReal(path.join(repoRoot, row.target)));
  if (file === undefined) {
    throw new Error(
      `${row.target} — the "${row.condition}" condition of "${row.subpath}" — is not in the ` +
        'program this gate built, so it cannot read the names that condition exposes.',
    );
  }
  const moduleSymbol = checker.getSymbolAtLocation(file);
  if (moduleSymbol === undefined) {
    throw new Error(
      `${row.target} — the "${row.condition}" condition of "${row.subpath}" — has no module ` +
        'symbol, so the compiler does not see it as a module and this gate cannot read the ' +
        'names it exposes.',
    );
  }
  const surface = new Map<string, readonly string[]>();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const files = (ultimateDeclaration(exported, checker).declarations ?? []).map((declaration) =>
      repoRelativeReal(declaration.getSourceFile().fileName),
    );
    surface.set(exported.name, [...new Set(files)]);
  }
  return surface;
}

function exportSurfaceReader(): (subpath: string) => ReadonlyMap<string, readonly string[]> {
  const program = createExportProgram();
  const checker = program.getTypeChecker();
  const byRelative = new Map<string, ts.SourceFile>();
  for (const file of program.getSourceFiles()) {
    byRelative.set(repoRelativeReal(file.fileName), file);
  }

  /**
   * Every name one declared subpath exposes, over **every** condition the manifest gives it,
   * with the files those names are declared in. A caller resolves through exactly one condition
   * and this gate does not get to choose which, so the surface is the union.
   */
  const surfaceOf = (subpath: string): ReadonlyMap<string, readonly string[]> => {
    const rows = allTargets.filter((one) => one.subpath === subpath);
    if (rows.length === 0) {
      throw new Error(
        `${MANIFEST} declares "${subpath}" with no condition at all, so this gate cannot read ` +
          'the names it exposes.',
      );
    }
    const surface = new Map<string, readonly string[]>();
    for (const row of rows) {
      for (const [name, files] of surfaceOfCondition(row, { checker, byRelative })) {
        surface.set(name, [...new Set([...(surface.get(name) ?? []), ...files])]);
      }
    }
    return surface;
  };

  return surfaceOf;
}

export function defineDatabaseSurfaceTests(): void {
  describe('no export subpath is a second door into the database layer', () => {
    it('exposes no layer-declared name that the public subpath does not', () => {
      const surfaceOf = exportSurfaceReader();
      const publicSubpath = [...publicSubpaths][0] ?? './db';
      const publicNames = new Set(surfaceOf(publicSubpath).keys());
      expect(
        publicNames.size,
        `${publicSubpath} exposes no name at all, so every comparison below would be vacuous.`,
      ).toBeGreaterThan(0);

      const examined: string[] = [];
      const doors: string[] = [];
      for (const subpath of new Set(allTargets.map((row) => row.subpath))) {
        // The layer's own declared entry points are what the rest of this file classifies; this
        // block is about every OTHER name the package publishes.
        if (databaseSubpaths.has(subpath)) continue;
        examined.push(subpath);
        for (const [name, declarations] of surfaceOf(subpath)) {
          const inside = declarations.filter((file) => insideLayer(file));
          if (inside.length === 0 || publicNames.has(name)) continue;
          doors.push(`${subpath} exposes "${name}", declared in ${inside.join(', ')}`);
        }
      }

      expect(
        examined.length,
        `${MANIFEST} declares no export key outside the database subpaths, so this block examined ` +
          'nothing and proved nothing.',
      ).toBeGreaterThan(0);
      expect(
        doors,
        `${MANIFEST} publishes these names, declared inside the database layer, under an export ` +
          `key that is not a database subpath and that ${publicSubpath} does not expose. Each one ` +
          'is a second door into the layer: a caller reaches it without naming the layer, and the ' +
          'edge classifier above never sees the specifier. Examined: ' +
          `${examined.join(', ')}.`,
      ).toEqual([]);
    }, 15_000);
  });

  describe('the public barrel re-exports the repository layer and nothing else', () => {
    /** The source barrel, from the manifest's own `types` condition for `./db`. */
    const barrel = publicTargets.find((row) => row.condition === 'types')?.target;

    /** The repository layer's index, as the barrel must spell it: sibling-relative, with `.js`. */
    const repositoryIndex = './repositories/index.js';

    it('names the repository index in every export statement it has, and at least one', () => {
      expect(barrel, `${MANIFEST} declares no "types" condition for "./db"`).toBeDefined();
      const absolute = path.join(repoRoot, barrel ?? '');
      const source = ts.createSourceFile(
        absolute,
        readFileSync(absolute, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );

      const carriesExportModifier = (statement: ts.Statement): boolean =>
        ts.canHaveModifiers(statement) &&
        (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        );

      const specifiers: string[] = [];
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          const moduleSpecifier = statement.moduleSpecifier;
          // A bare `export { … }` with no `from` re-exports a local binding, which in a barrel that
          // declares nothing of its own cannot happen — and if it ever does, this gate says so
          // rather than skipping the statement.
          if (moduleSpecifier === undefined || !ts.isStringLiteralLike(moduleSpecifier)) {
            throw new Error(
              `${barrel ?? ''} has an export statement with no module specifier. This gate ` +
                'classifies re-exports and cannot classify that one.',
            );
          }
          specifiers.push(moduleSpecifier.text);
        } else if (ts.isExportAssignment(statement) || carriesExportModifier(statement)) {
          // The arm that would otherwise have been silence. A declaration made here and exported
          // from here is a name on the public surface that no re-export names, so it would pass the
          // specifier check below without ever being looked at.
          throw new Error(
            `${barrel ?? ''} declares an export of its own: ${
              statement.getText(source).split('\n')[0] ?? ''
            } — this barrel re-exports ./repositories/index.js and declares nothing. Put the ` +
              'declaration in the repository layer, where scope-forgery.test.ts compiles against it.',
          );
        } else {
          // An import, or any other statement that puts no name on this module's surface.
        }
      }

      expect(
        specifiers.length,
        `${barrel ?? ''} has no export statement at all, so this gate would pass over an empty ` +
          'surface (ADR-0015).',
      ).toBeGreaterThan(0);
      expect(
        specifiers.filter((specifier) => specifier !== repositoryIndex),
        `${barrel ?? ''} re-exports from a module other than ${repositoryIndex}. The public ` +
          "surface is the repository layer's surface: `./client.js`, `./schema/index.js`, " +
          '`./seed.js` and `./migrate.js` each hand a caller something that reaches PostgreSQL ' +
          'without a WorkspaceScope. If a new export genuinely belongs on the public surface, ' +
          're-export it from ./repositories/index.js, where scope-forgery.test.ts will see it.',
      ).toEqual([]);
    });
  });
}
