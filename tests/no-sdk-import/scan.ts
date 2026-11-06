import path from 'node:path';

import ts from 'typescript';

import {
  calleeRoot,
  dottedName,
  fileBindings,
  literalText,
  scriptKindFor,
  type FileBindings,
  type ParsedSourceFile,
} from './ast.js';
import { COMPUTED_IMPORT_DECISIONS, REPO_ROOT } from './boundaries.js';
import {
  CREATE_REQUIRE,
  createRequireReference,
  isCreateRequireCallee,
  isDecidableCall,
  OPAQUE_CALLS,
  OPAQUE_PROPERTIES,
  RESOLVER_CALLS,
  unwrapSpread,
  type DecidableCall,
  type ModuleReference,
  type ModuleScan,
  type Undecidable,
} from './call-forms.js';
import { stringNamesAModule } from './resolve.js';

export type { ModuleReference, ModuleScan, Undecidable };

/**
 * Every module reference in a piece of module source, and every reference it cannot decide.
 *
 * The walk is over the syntax tree, so the specifier it reports is the **cooked** string, the one
 * `tsc` and node resolve, and the spacing a reference is written with is not a variable in the
 * answer. Both were escapes against the regular expression this replaced.
 */
export function scanModuleSource(file: string, source: string): ModuleScan {
  return new ModuleScanner(file, source).run();
}

class ModuleScanner {
  private readonly references: ModuleReference[] = [];
  private readonly undecidable: Undecidable[] = [];
  private readonly sourceFile: ts.SourceFile;
  private readonly bindings: FileBindings;

  constructor(
    private readonly file: string,
    source: string,
  ) {
    this.sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(file),
    );
    this.bindings = fileBindings(this.sourceFile);
  }

  run(): ModuleScan {
    this.collectDirectives();
    this.refuseUnparsedSource();
    this.visit(this.sourceFile);
    return { references: this.references, undecidable: this.undecidable };
  }

  private push(specifier: string, form: string): void {
    this.references.push({ specifier, form });
  }

  private refuse(reason: string): void {
    this.undecidable.push({ file: this.file, reason });
  }

  private snippet(node: ts.Node): string {
    return JSON.stringify(node.getText(this.sourceFile).slice(0, 60));
  }

  /**
   * The triple-slash directives are module references the walk never reaches: the parser lifts
   * them off the token stream onto the source file. `types` names a package the way an `import`
   * does. `path` names a file relative to this one and is written without a leading `./`, so it
   * is normalised into the relative form the resolver understands. `lib` names a file shipped
   * inside the TypeScript compiler, which no resolution can reach, so it is decided rather than
   * collected and there is no silent remainder.
   */
  private collectDirectives(): void {
    for (const directive of this.sourceFile.typeReferenceDirectives) {
      this.push(directive.fileName, 'a /// <reference types> directive');
    }
    for (const directive of this.sourceFile.referencedFiles) {
      const relative = /^[./\\]/.test(directive.fileName)
        ? directive.fileName
        : `./${directive.fileName}`;
      this.push(relative, 'a /// <reference path> directive');
    }
  }

  private refuseUnparsedSource(): void {
    const diagnostics = (this.sourceFile as ParsedSourceFile).parseDiagnostics;
    if (diagnostics === undefined) {
      this.refuse(
        'the TypeScript parser did not report whether it could read this file, so this gate cannot ' +
          'tell whether the references it found are all of them',
      );
      return;
    }
    const first = diagnostics[0];
    if (first === undefined) return;
    this.refuse(
      `the TypeScript parser reported ${diagnostics.length} syntax error(s), so the ` +
        `references found in it are not necessarily all of them: ` +
        ts.flattenDiagnosticMessageText(first.messageText, ' '),
    );
  }

  private visit(node: ts.Node): void {
    this.decide(node);
    ts.forEachChild(node, (child) => {
      this.visit(child);
    });
  }

  private decide(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      this.decideDeclaration(node);
    } else if (ts.isImportEqualsDeclaration(node)) {
      this.decideImportEquals(node);
    } else if (ts.isImportTypeNode(node)) {
      this.decideImportType(node);
    } else if (isDecidableCall(node)) {
      this.decideCall(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      this.decideProperty(node);
    }
  }

  private decideDeclaration(node: ts.ImportDeclaration | ts.ExportDeclaration): void {
    if (node.moduleSpecifier === undefined) return;
    const specifier = literalText(node.moduleSpecifier);
    const form = ts.isImportDeclaration(node) ? 'an import declaration' : 'an export … from';
    if (specifier === null) this.refuse(`${form} whose specifier is not a string literal`);
    else this.push(specifier, form);
  }

  private decideImportEquals(node: ts.ImportEqualsDeclaration): void {
    if (!ts.isExternalModuleReference(node.moduleReference)) return;
    const specifier = literalText(node.moduleReference.expression);
    if (specifier === null) {
      this.refuse('an import-equals whose reference is not a string literal');
    } else {
      this.push(specifier, 'an import-equals');
    }
  }

  private decideImportType(node: ts.ImportTypeNode): void {
    const argument = node.argument;
    const specifier = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null;
    if (specifier === null) this.refuse('an import type whose argument is not a string literal');
    else this.push(specifier, 'an import type');
  }

  private decideProperty(node: ts.PropertyAccessExpression): void {
    const accessed = dottedName(node);
    if (accessed === null || !OPAQUE_PROPERTIES.has(accessed)) return;
    this.refuse(
      `${accessed} hands out a module resolver this gate cannot follow, so what this file reaches cannot be decided statically`,
    );
  }

  /**
   * Every call site leaves here with a verdict, `new X(…)` included. The first three arms name a
   * construct; the last is the `else`, and it decides the rest by what the call is handed. There
   * is no arm that returns without collecting a reference or recording a decision.
   */
  private decideCall(node: DecidableCall): void {
    const calleeExpression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
    const callee = dottedName(calleeExpression);
    if (callee !== null && OPAQUE_CALLS.has(callee)) {
      this.refuse(
        `${callee}() builds a module reference at run time, so no static walk of this file can decide what it reaches`,
      );
    } else if (callee !== null && ts.isCallExpression(node) && RESOLVER_CALLS.has(callee)) {
      this.decideResolverCall(node, callee);
    } else if (callee !== null && ts.isCallExpression(node) && isCreateRequireCallee(callee)) {
      this.decideCreateRequire(node);
    } else {
      this.decideUnrecognisedCall(node, calleeExpression);
    }
  }

  private decideResolverCall(node: ts.CallExpression, callee: string): void {
    const argument = node.arguments[0];
    const specifier = this.valueAt(argument);
    if (specifier !== null) {
      this.push(specifier, `a ${callee}() call`);
      return;
    }
    // A decided exception (ADR-0115), for the one file and the dynamic kind it names.
    if (callee === 'import' && COMPUTED_IMPORT_DECISIONS.has(this.file)) return;
    this.refuse(
      `a ${callee}() call whose argument is not a string literal, so this gate cannot tell ` +
        `which module it names: ${argument === undefined ? '(no argument)' : this.snippet(argument)}`,
    );
  }

  private decideCreateRequire(call: ts.CallExpression): void {
    const reference = createRequireReference(call);
    if (reference !== null) {
      this.push(reference.specifier, reference.form);
      return;
    }
    this.refuse(
      `a ${CREATE_REQUIRE}() whose result is not used immediately on a string literal, so the ` +
        `modules it goes on to resolve cannot be decided statically: ${this.snippet(call)}`,
    );
  }

  /**
   * The string this gate can read at an argument position, or `null`. A literal is its own value;
   * an identifier bound once by `const` to a literal in this file is that literal, the one step of
   * value-tracking described beside {@link fileBindings}.
   */
  private valueAt(node: ts.Node | undefined): string | null {
    const literal = literalText(node);
    if (literal !== null) return literal;
    if (node !== undefined && ts.isIdentifier(node)) {
      return this.bindings.constants.get(node.text) ?? null;
    }
    return null;
  }

  /** Every string this gate can read at a call site: its arguments, and array literals among them. */
  private stringsHandedTo(call: DecidableCall): string[] {
    if (ts.isTaggedTemplateExpression(call)) {
      return ts.isNoSubstitutionTemplateLiteral(call.template) ? [call.template.text] : [];
    }
    // `new X` with no argument list has `arguments === undefined`, which is not the same node as
    // `new X()`. Both hand this gate nothing, and neither may throw.
    return (call.arguments ?? []).flatMap((argument) => this.stringsIn(unwrapSpread(argument)));
  }

  /**
   * `Reflect.apply(fn, thisArg, ['@scope/pkg'])`, `fn.apply(null, [...])` and
   * `fn(...['@scope/pkg'])` put the specifier one level in, written out at the call site all the
   * same. The spread is unwrapped by the caller because `...['x']` wraps the array literal this
   * reads, and {@link valueAt} reads neither.
   */
  private stringsIn(argument: ts.Expression): string[] {
    const value = this.valueAt(argument);
    if (value !== null) return [value];
    if (!ts.isArrayLiteralExpression(argument)) return [];
    return argument.elements.flatMap((element) => {
      const nested = this.valueAt(unwrapSpread(element));
      return nested === null ? [] : [nested];
    });
  }

  /**
   * Can this gate show the thing being called is something **this file made**? The only positive
   * answer it has: a callee rooted at a name the file binds is a value whose origin the walk has
   * seen, while one rooted at a free name, at `this`, or at nothing came from somewhere this gate
   * cannot look. A name bound to another name is *not* vouched for, which is what
   * `const load = require;` turns on.
   */
  private calleeIsFromThisFile(calleeExpression: ts.Node): boolean {
    const root = calleeRoot(calleeExpression);
    return root !== null && this.bindings.declared.has(root) && !this.bindings.aliased.has(root);
  }

  /**
   * Is this node an **absolute base URL**, the second half of a URL resolution? Two shapes, and
   * neither is a callee name: `import.meta.url`, and a string literal that {@link URL} parses
   * with no base of its own.
   */
  private isBaseUrl(node: ts.Node): boolean {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'url' &&
      ts.isMetaProperty(node.expression)
    ) {
      return true;
    }
    const literal = this.valueAt(node);
    return literal !== null && URL.canParse(literal);
  }

  /** Is some argument of this call an absolute base URL other than `candidate` itself? */
  private handedABaseUrl(call: DecidableCall, candidate: string): boolean {
    if (ts.isTaggedTemplateExpression(call)) return false;
    return (call.arguments ?? []).some((argument) => {
      const unwrapped = unwrapSpread(argument);
      return this.valueAt(unwrapped) !== candidate && this.isBaseUrl(unwrapped);
    });
  }

  /**
   * The `else` ADR-0031 clause 1 asks for: a verdict for every call the tables did not name.
   *
   * The question is not "is this callee a resolver", since no list of callee names finishes
   * answering that. It is: *is this call being handed something that resolves to a module, by a
   * caller this gate cannot vouch for?* Each verdict is reached **per string handed to the
   * call**:
   *
   *   * **collected**: the string comes together with an absolute base URL, the shape of
   *     `new URL('./sibling.ts', import.meta.url)`. That is a computation this gate can do, so
   *     the string is recorded and resolved like any other. This is not an exemption: if it names
   *     the SDK, the file lands in the detected set and the §42 assertion fails. It collects the
   *     one candidate and the loop goes on, because the base URL is a property of the *call*, and
   *     stopping here would leave every later string at that call site undecided.
   *   * **refused**, naming the file, the construct and the module the string resolves to. A
   *     refusal ends the loop: it is already a verdict for the whole call.
   *   * **decided, not a reference**: a call handed no string that resolves to a module is not,
   *     *at this call site*, naming one. A specifier arriving through a parameter or a
   *     computation stays outside, as the reach tests demonstrate.
   */
  private decideUnrecognisedCall(call: DecidableCall, calleeExpression: ts.Node): void {
    if (this.calleeIsFromThisFile(calleeExpression)) return;
    for (const candidate of this.stringsHandedTo(call)) {
      const target = stringNamesAModule(this.file, candidate);
      if (target === null) continue;
      if (this.handedABaseUrl(call, candidate)) {
        this.push(candidate, 'a reference resolved against an explicit base URL');
        continue;
      }
      this.refuse(this.unrecognisedCallRefusal(calleeExpression, candidate, target));
      return;
    }
  }

  private unrecognisedCallRefusal(
    calleeExpression: ts.Node,
    candidate: string,
    target: string,
  ): string {
    return (
      `${this.snippet(calleeExpression)} is handed ${JSON.stringify(candidate)}, which resolves to ` +
      `${path.relative(REPO_ROOT, target) || target}. This gate cannot show that call is not a ` +
      `module load: the callee is not one it reads a specifier from, and it is not rooted at a ` +
      `name this file binds. Refused rather than passed over (ADR-0031 clause 1) — either call ` +
      `the module reference by a name this gate reads, or bind the callee in this file so the ` +
      `walk can see what it is.`
    );
  }
}
