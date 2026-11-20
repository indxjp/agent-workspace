/**
 * Derives the set of repository provider factories in the database layer from the tracked tree and
 * the compiler's own types (ADR-0027), for `scope-forgery.providers.test.ts`.
 *
 * Nothing here is a list of provider names or a naming convention: a value is a provider factory
 * when it can be called and what the call returns carries a `forScope` member, whatever syntax
 * declared it.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { posixPath, repoRoot } from './scope-forgery.fixture-gate.test-support.js';

/** What every `createDatabase…Provider` is, as far as the forgery gates need to know. */
type ProviderFactory = (db: never) => { forScope: (scope: unknown) => unknown };

interface DerivedProvider {
  readonly file: string;
  readonly name: string;
  readonly factory: ProviderFactory;
}

interface ProviderDerivation {
  readonly layerDir: string;
  readonly modules: readonly string[];
  readonly suites: readonly string[];
  readonly derived: readonly DerivedProvider[];
}

/**
 * The database layer's directory, from this file's own location: `<layer>/repositories/<this>`.
 * Deriving it this way is what keeps a second literal path out of a gate whose whole subject is
 * literals (ADR-0027 clause 2).
 */
const layerDirectory = (): string =>
  posixPath(path.relative(repoRoot, path.resolve(fileURLToPath(import.meta.url), '..', '..')));

/** The contributing set: the tracked tree under the database layer, split by shape. */
const classifyTracked = (
  layerDir: string,
): { modules: readonly string[]; suites: readonly string[] } => {
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
  return { modules, suites };
};

/**
 * Is this exported value a provider factory? Asked of the type, not of the text: it is one if it
 * can be called and what the call returns carries a `forScope` member. `export function f(db) {}`
 * and `export const f = (db) => ({ forScope … })` are indistinguishable here, which is the point.
 */
const isProviderFactory = (checker: ts.TypeChecker, type: ts.Type): boolean =>
  type
    .getCallSignatures()
    .some((signature) => checker.getReturnTypeOfSignature(signature).getProperty('forScope'));

const createLayerProgram = (modules: readonly string[], layerDir: string): ts.Program => {
  const configPath = path.join(repoRoot, 'tsconfig.json');
  const rawConfig = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  if (rawConfig.error !== undefined) {
    throw new Error(`${configPath} could not be read, so this gate cannot type the layer.`);
  }
  const parsed = ts.parseJsonConfigFileContent(rawConfig.config, ts.sys, path.dirname(configPath));
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
  return program;
};

/** The type of an exported symbol, or a hard failure when the checker gives it no declaration. */
const exportedType = (
  checker: ts.TypeChecker,
  exported: ts.Symbol,
  file: string,
): { name: string; type: ts.Type } => {
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
  return { name, type: checker.getTypeOfSymbolAtLocation(exported, declaration) };
};

const requireModuleSymbol = (
  checker: ts.TypeChecker,
  program: ts.Program,
  file: string,
  layerDir: string,
): ts.Symbol => {
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
  return moduleSymbol;
};

/** A provider factory this gate cannot call is one it is not checking; saying nothing hides a gap. */
const requireReachable = (
  reachable: Record<string, unknown>,
  file: string,
  name: string,
  layerDir: string,
): ProviderFactory => {
  const factory = reachable[name];
  if (typeof factory !== 'function') {
    throw new Error(
      `${file} exports ${name}, whose return type carries a "forScope" member, so it is ` +
        'a repository provider factory — but it is not reachable through ' +
        `${layerDir}/repositories/unscoped.ts, so this gate cannot check that it refuses ` +
        'a forged scope. Re-export it there.',
    );
  }
  return factory as ProviderFactory;
};

/**
 * Classify every exported value of every tracked module by its type. `unscoped.ts` and `index.ts`
 * re-export the same factories the modules declare, so the same name arrives more than once; it is
 * one factory and it is checked once. An export that is not a provider factory cannot construct a
 * repository for a scope, so there is nothing for the gate to exercise (type predicates, record
 * types, table objects and `openDatabaseRoot` all land there).
 */
export function deriveProviders(unscopedExports: object): ProviderDerivation {
  const layerDir = layerDirectory();
  const { modules, suites } = classifyTracked(layerDir);
  const reachable = unscopedExports as Record<string, unknown>;
  const program = createLayerProgram(modules, layerDir);
  const checker = program.getTypeChecker();
  const seen = new Set<string>();
  const derived: DerivedProvider[] = [];
  for (const file of modules) {
    const moduleSymbol = requireModuleSymbol(checker, program, file, layerDir);
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const { name, type } = exportedType(checker, exported, file);
      if (!isProviderFactory(checker, type)) continue;
      const factory = requireReachable(reachable, file, name, layerDir);
      if (seen.has(name)) continue;
      seen.add(name);
      derived.push({ file, name, factory });
    }
  }
  return { layerDir, modules, suites, derived };
}
