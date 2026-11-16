/**
 * Does a module import the in-memory run store, and what kind of module is it? The classifier
 * behind `store.in-memory-gate.test.ts`.
 *
 * A static `import` declaration is the only shape this gate can read a bound name out of, so every
 * other way of reaching `memory-store.ts` is a hard failure rather than a quiet `false`: a
 * `const { InMemoryRunStore } = await import('./memory-store')` in a route handler would otherwise
 * be invisible to a classifier that looked only at import declarations (ADR-0027 clause 3).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';

import ts from 'typescript';

import {
  bindingsIn,
  calleeRootName,
  namesTheHarnessVariable,
  snippet,
  stringsHandedTo,
  type FileBindings,
} from './store.gate-ast';
import type { StoreResolver } from './store.gate-resolver';

/**
 * The one computed dynamic import the Owner decided, recorded in ADR-0115 and held identically
 * by `packages/core/src/db/repositories/database-reachability.test.ts`: the module it names is
 * chosen by the developer at run time and is never `memory-store.ts`. Exact repository paths only,
 * never a glob; the assertion in the gate pins the list to exactly this entry.
 */
export const COMPUTED_IMPORT_DECISIONS: ReadonlyMap<string, string> = new Map([
  [
    'packages/aw/src/tools/host-child.ts',
    "imports the developer's own run files by path; decided in ADR-0115",
  ],
]);

/** What the walk of one module needs to know about it. */
interface ModuleContext {
  readonly from: string;
  readonly storeModule: string;
  readonly resolver: StoreResolver;
  readonly bindings: FileBindings;
}

type CallSite = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

const isCallSite = (node: ts.Node): node is CallSite =>
  ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node);

function refuseReExport(node: ts.ExportDeclaration, context: ModuleContext): void {
  const specifier = node.moduleSpecifier;
  if (
    specifier === undefined ||
    !ts.isStringLiteralLike(specifier) ||
    !context.resolver.namesTheStore(context.from, specifier.text)
  ) {
    return;
  }
  throw new Error(
    `${context.from} re-exports from ${context.storeModule}. This gate classifies direct ` +
      'importers, and a re-export makes the class reachable from a module it does not name. ' +
      'Decide what that means before adding one.',
  );
}

/**
 * The other arm of the call classifier, and a decision rather than a fall-through: a call that is
 * neither a dynamic import nor a CommonJS require is asked whether it is handed a string that
 * resolves to `memory-store.ts` by a callee this file cannot vouch for, and refused if so.
 *
 * A **construction** is never vouched for: a constructed `Worker` loads and runs a module, and the
 * rule below — which asks only whether this file binds the callee's root name — passes one whose
 * `Worker` came out of a destructured `require`. If no string this gate can read at this call site
 * resolves to `memory-store.ts`, nothing here names it. What that leaves outside is in the gate's
 * header — a specifier arriving through a parameter, a computation, or the source text handed to
 * `eval`.
 */
function refuseUnvouchedCall(node: CallSite, callee: ts.Expression, context: ModuleContext): void {
  const rootName = ts.isCallExpression(node) ? calleeRootName(callee) : null;
  const vouched =
    rootName !== null &&
    context.bindings.declared.has(rootName) &&
    !context.bindings.aliased.has(rootName);
  if (vouched) return;
  for (const candidate of stringsHandedTo(node, context.bindings.constants)) {
    if (!context.resolver.stringNamesTheStore(context.from, candidate)) continue;
    throw new Error(
      `${context.from} hands ${JSON.stringify(candidate)} to \`${snippet(callee)}\`, and that ` +
        `string resolves to ${context.storeModule}. This gate cannot show the call is not a ` +
        'module load: its callee is neither a construct this gate reads a specifier from nor a ' +
        'name this file binds. Refused rather than passed over (ADR-0031 clause 1), because a ' +
        'module reached that way carries the class while this gate reads no bound name out of it.',
    );
  }
}

/** A dynamic import or a CommonJS require: its specifier must be a literal naming another module. */
function refuseUnreadableLoad(node: CallSite, dynamic: boolean, context: ModuleContext): void {
  const argument = ts.isTaggedTemplateExpression(node) ? undefined : node.arguments?.[0];
  if (argument === undefined || !ts.isStringLiteralLike(argument)) {
    // A decided exception (ADR-0115), for the one file and the dynamic kind it names: it is read
    // as having no edge from this call, so nothing here names `memory-store.ts`.
    if (dynamic && COMPUTED_IMPORT_DECISIONS.has(context.from)) return;
    // The specifier is a run-time value, so this gate cannot tell whether it names
    // `memory-store.ts`. In verification round 3 a module that put `'./store'` in a `const` and
    // awaited a dynamic import of that binding constructed the class, while a check for a string
    // literal argument reported nothing.
    throw new Error(
      `${context.from} calls a dynamic import or require with an argument that is not a string ` +
        'literal, so this gate cannot tell which module it names. Write the specifier as a ' +
        'literal, or decide what a computed one means here; do not leave it unread.',
    );
  }
  if (!context.resolver.namesTheStore(context.from, argument.text)) return;
  throw new Error(
    `${context.from} reaches ${context.storeModule} through a dynamic import or require. This ` +
      'gate reads the bound name out of static import declarations and cannot read it out of ' +
      'that, so it fails rather than reporting the file as a non-importer.',
  );
}

/**
 * Every call site leaves with a verdict; nothing falls through it (ADR-0031 clause 1). The first
 * arm reads a specifier out of the two constructs this gate names. The other does not ask whether
 * the callee is a resolver — no list of callee names ever finishes answering that.
 */
function judgeCallSite(node: CallSite, context: ModuleContext): void {
  const callee = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
  const dynamic = ts.isCallExpression(node) && callee.kind === ts.SyntaxKind.ImportKeyword;
  const required =
    ts.isCallExpression(node) && ts.isIdentifier(callee) && callee.text === 'require';
  if (dynamic || required) refuseUnreadableLoad(node, dynamic, context);
  else refuseUnvouchedCall(node, callee, context);
}

/** Refuse every shape of reaching the store that a static import declaration does not show. */
function refuseHiddenRoutes(source: ts.SourceFile, context: ModuleContext): void {
  const walk = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node)) refuseReExport(node, context);
    else if (isCallSite(node)) judgeCallSite(node, context);
    ts.forEachChild(node, walk);
  };
  walk(source);
}

/** Does this statement import the class (or the whole module) from the store module? */
function importsClassFromStore(statement: ts.Statement, context: ModuleContext): boolean {
  if (!ts.isImportDeclaration(statement)) return false;
  const specifier = statement.moduleSpecifier;
  if (!ts.isStringLiteralLike(specifier)) return false;
  if (!context.resolver.namesTheStore(context.from, specifier.text)) return false;
  // A default-only or side-effect-only import binds no name from the module, so carries no class.
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined) return false;
  // `import * as store from './store'` carries every export, this class among them.
  if (ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some(
    (element) => (element.propertyName?.text ?? element.name.text) === 'InMemoryRunStore',
  );
}

/**
 * Does this module import the in-memory store class? Throws for every other way of reaching the
 * store module, because those are invisible to a reader of import declarations.
 */
function importsTheClass(
  source: ts.SourceFile,
  from: string,
  resolver: StoreResolver,
  storeModule: string,
): boolean {
  const context: ModuleContext = { from, storeModule, resolver, bindings: bindingsIn(source) };
  refuseHiddenRoutes(source, context);
  return source.statements.some((statement) => importsClassFromStore(statement, context));
}

export interface ClassifiedImporters {
  /** Test suites. */
  readonly suites: readonly string[];
  /** Modules that name the environment variable the acceptance harness will not run without. */
  readonly harnesses: readonly string[];
  /** Anything else: a module a deployment could load. */
  readonly deployable: readonly string[];
}

const scriptKind = (file: string): ts.ScriptKind => {
  const extension = path.posix.extname(file).toLowerCase();
  return extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
};

/** Sort every module that imports the class into a suite, a harness or a deployable module. */
export function classifyImporters(
  root: string,
  modules: readonly string[],
  resolver: StoreResolver,
  storeModule: string,
): ClassifiedImporters {
  const suites: string[] = [];
  const harnesses: string[] = [];
  const deployable: string[] = [];
  for (const file of modules) {
    const source = ts.createSourceFile(
      path.join(root, file),
      readFileSync(path.join(root, file), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    // The module that declares the class, or one that does not import it: nothing to classify.
    if (file === storeModule || !importsTheClass(source, file, resolver, storeModule)) continue;
    if (/\.test(?:-support)?\.tsx?$/u.test(file)) suites.push(file);
    else if (namesTheHarnessVariable(source)) harnesses.push(file);
    else deployable.push(file);
  }
  return { suites, harnesses, deployable };
}
