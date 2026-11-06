import ts from 'typescript';

import { literalText } from './ast.js';

/** One reference this gate could not decide, described so a human can act on it. */
export type Undecidable = { readonly file: string; readonly reason: string };

/** One module reference found in a syntax tree, with the form it was written in. */
export type ModuleReference = { readonly specifier: string; readonly form: string };

export type ModuleScan = {
  readonly references: ModuleReference[];
  readonly undecidable: Undecidable[];
};

/**
 * The three node kinds that apply a value to arguments, and so the three the classifier decides.
 *
 * `new X(…)` is here because at least one constructor really loads a module: `new Worker(path)`
 * starts a thread whose entry point node resolves and executes. An earlier arm excluded it, and a
 * tracked file that ran the SDK through it passed this gate.
 */
export type DecidableCall = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

export function isDecidableCall(node: ts.Node): node is DecidableCall {
  return (
    ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)
  );
}

/**
 * Calls whose specifier this gate reads directly. The name is the dotted callee text the AST
 * reports, so `require.resolve` is one entry.
 *
 * **This table is a fast path, not the decision** (ADR-0031 clause 1): a callee in none of the
 * three tables is not thereby innocent, because it reaches the unrecognised-call classifier, which
 * refuses it if it is handed anything that resolves to a module. What the table buys is the
 * *specifier*.
 */
export const RESOLVER_CALLS = new Set([
  'import',
  'require',
  'require.resolve',
  'import.meta.resolve',
]);

/**
 * Constructs that manufacture a module reference at run time, so no static walk can decide them.
 * `Function` is here without `new` as well as with it, since the AST reports the callee of a call
 * and of a construction the same way. Also a fast path: these are refused *whatever* they are
 * handed, with a reason that says why.
 */
export const OPAQUE_CALLS = new Set(['eval', 'Function']);

/**
 * Property accesses that hand out a resolver this gate cannot follow, refused where they are
 * written. A fast path again: `module.require` is deliberately *not* here, because the
 * unrecognised-call classifier refuses it for not recognising it, which is the formulation that
 * terminates. Adding the name would be one more round of the enumeration ADR-0031 was written to
 * stop.
 */
export const OPAQUE_PROPERTIES = new Set(['process.binding', 'module.constructor']);

/**
 * `createRequire`, the one construct that builds a resolver and is nevertheless decidable.
 *
 *   * a call **immediately** followed by `.resolve` on a string literal, or called directly on
 *     one, names exactly that literal, so it is *scanned*.
 *   * a call whose result is used any other way (bound, returned, passed on, called with a
 *     non-literal) is undecidable, because every later call through it could name anything.
 *
 * Recorded in docs/adr/W1-INT-02-what-the-boundary-scan-classifies-and-what-it-decides.md.
 */
export const CREATE_REQUIRE = 'createRequire';

export function isCreateRequireCallee(callee: string): boolean {
  return callee === CREATE_REQUIRE || callee.endsWith(`.${CREATE_REQUIRE}`);
}

export function unwrapSpread(node: ts.Expression): ts.Expression {
  return ts.isSpreadElement(node) ? node.expression : node;
}

/** The literal a `createRequire(…)` call names when its result is used immediately, else `null`. */
export function createRequireReference(call: ts.CallExpression): ModuleReference | null {
  const parent: ts.Node = call.parent;
  if (ts.isCallExpression(parent) && parent.expression === call) {
    const specifier = literalText(parent.arguments[0]);
    if (specifier !== null) return { specifier, form: `${CREATE_REQUIRE}() called on a literal` };
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.name.text !== 'resolve') return null;
  const grandparent: ts.Node = parent.parent;
  if (!ts.isCallExpression(grandparent) || grandparent.expression !== parent) return null;
  const specifier = literalText(grandparent.arguments[0]);
  return specifier === null
    ? null
    : { specifier, form: `${CREATE_REQUIRE}().resolve() on a literal` };
}
