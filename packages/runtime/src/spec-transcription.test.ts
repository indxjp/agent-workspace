/**
 * The transcription gate this task's Accept criterion names: `driver.ts` and `types.ts` must
 * match `docs/spec.md` §14.2, §14.5 and §15.1 "token for token" (plan §3.1: these interfaces are
 * PL-0, where "creativity is a defect"). A reviewer reading a diff cannot check that; a command
 * can, so this file is the command.
 *
 * ## What is actually compared
 *
 * For **every top-level construct the fenced ```ts block under a named heading actually
 * declares** — §14.2, §14.5 and §15.1 — not a fixed, hand-typed list of names. `specDeclarationsUnder()`
 * parses the block into a `name -> Shape` map, and the `describe`/`it.each` blocks below iterate
 * that map's keys, so a construct one of these three blocks gains is looked up and compared
 * automatically the next time this file runs; it cannot pass by never being named here. (At the
 * time of writing that is `RuntimeDriverId`, `RuntimeHandle`, `RuntimeDriver` and `AgentConnection`
 * under §14.2, `RuntimeCapabilities` under §14.5, and `RuntimeProfile` under §15.1 — but those
 * names are what the map happens to contain, not what this file enumerates.)
 *
 *   * the fenced ```ts block under the named heading is located and parsed with the TypeScript
 *     compiler API (ADR-0030: an import edge, and by the same logic a type shape, is resolved by
 *     the compiler, never matched by regex);
 *   * `driver.ts` / `types.ts` are parsed the same way;
 *   * for a union of string-literal types (`RuntimeDriverId`) the two literal sets are compared;
 *   * for an object-shaped type (the rest) every member's **name**, **optionality** (`?`) and
 *     **type text** are compared, member by member, in both directions — a member the spec has
 *     and the file lacks fails, and so does a member the file has and the spec lacks (both
 *     directions are exercised below, not merely asserted to be exercised — see "Proof this gate
 *     can fail", the two `describe.each` blocks after the real comparisons).
 *
 * Type text is compared after the TypeScript printer renders both sides (so `'x'` and `"x"`, or
 * different line-wrapping, are not reported as differences), after stripping a leading `readonly`
 * token (`driver.ts` writes `RuntimeHandle` etc. as `type`, not `interface`, matching
 * `packages/core/src/types.ts`'s convention, and `readonly ('none' | ...)[]` is that same
 * convention applied to an array-typed field — see `driver.ts`'s own comment on why it is a
 * `type`), and after one further, **fixed and named** substitution: the two spec-only identifiers
 * `AgentRunRequest` and `AgentEvent`, and the spec's bare `AgentConnection` return type, are
 * `driver.ts`'s type parameters `TRequest` / `TEvent` and `AgentConnection<TEvent>` — settled by
 * `docs/adr/W1-RN-02-runtime-driver-is-generic.md`, not invented here. No other substitution is
 * applied; a spec change to any other identifier is compared literally and fails if it does not
 * match.
 *
 * ## The stated limit (ADR-0031) — read this once; it is not narrowed anywhere else in this file
 *
 * This is a **static, syntactic** gate. It compares the printed text of type nodes; it cannot and
 * does not evaluate whether two differently-written type expressions are the same TypeScript type
 * (for example `'a' | 'b'` and `'b' | 'a'` would be reported as different, not deduplicated as
 * equivalent unions), and it does not check prose — a member's JSDoc description drifting from the
 * spec's is invisible to it. Both of those failure directions are **conservative**: they can make
 * this gate fail on two things that a human would call equivalent, never make it pass on two
 * things that differ. The one place this gate is asked to decide something it structurally cannot
 * — a top-level construct in a spec fenced block that is neither a type alias nor an interface —
 * is not silently skipped: `extractDeclarations` in strict mode throws, naming the construct,
 * which fails the test rather than comparing zero members against zero and calling that a match
 * (ADR-0015: a gate decides on a positive assertion, never the absence of a negative).
 *
 * That guarantee only holds end to end because *which* constructs get this treatment is itself
 * derived, not hand-picked (see "What is actually compared" above): every key
 * `specDeclarationsUnder()` finds is looked up against the implementation by the `it.each` calls
 * below, so a well-formed construct the spec's fenced block declares and this file never names
 * cannot be dropped by omission either — the earlier, member-granularity version of this file did
 * exactly that at construct granularity, and it is what round 2 (B1) closed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const SPEC_PATH = path.join(REPO_ROOT, 'docs/spec.md');

// --- extraction -----------------------------------------------------------------------------

/** One property or method member of an object-shaped construct. */
type Member = {
  readonly optional: boolean;
  /** Printer output for a property's type, or `(params): returnType` for a method. */
  readonly typeText: string;
};

/** What one named top-level construct (a `type` alias or an `interface`) turned out to be. */
type Shape =
  | { readonly kind: 'union'; readonly values: ReadonlySet<string> }
  | { readonly kind: 'object'; readonly members: ReadonlyMap<string, Member> };

const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Canonical text for a type node: printer output, then whitespace, quote style and the one
 * cosmetic `readonly` array-type prefix normalized away — see this file's header.
 *
 * The printer re-emits an *unsynthesized* string-literal type using its original source quote
 * character rather than a canonical one (verified against this repository's TypeScript 5.9.3: a
 * parsed, unmodified literal keeps whichever of `'`/`"` the source used), so quote-style
 * independence needs one more step: `driver.ts`/`types.ts` use single quotes throughout (no
 * apostrophes ever appear inside one of these type expressions, so a blanket `'` → `"` is exact,
 * not a heuristic) and `docs/spec.md`'s fenced blocks use double quotes: normalizing both to `"`
 * makes the comparison quote-style independent in fact, not only in intent.
 */
function printType(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  const printed = normalizeWhitespace(printer.printNode(ts.EmitHint.Unspecified, node, sourceFile));
  return printed.replace(/^readonly\s+/, '').replace(/'/g, '"');
}

function methodTypeText(member: ts.MethodSignature, sourceFile: ts.SourceFile): string {
  const params = member.parameters
    .map((p) => {
      const name = p.name.getText(sourceFile);
      const optional = p.questionToken ? '?' : '';
      const type = p.type ? printType(p.type, sourceFile) : 'unknown';
      return `${name}${optional}: ${type}`;
    })
    .join(', ');
  const returnType = member.type ? printType(member.type, sourceFile) : 'void';
  return `(${params}): ${returnType}`;
}

function objectMembers(
  members: ts.NodeArray<ts.TypeElement>,
  sourceFile: ts.SourceFile,
  constructName: string,
): ReadonlyMap<string, Member> {
  const result = new Map<string, Member>();
  for (const member of members) {
    if (ts.isPropertySignature(member) && member.type) {
      const name = member.name.getText(sourceFile);
      result.set(name, {
        optional: member.questionToken !== undefined,
        typeText: printType(member.type, sourceFile),
      });
      continue;
    }
    if (ts.isMethodSignature(member)) {
      const name = member.name.getText(sourceFile);
      result.set(name, {
        optional: member.questionToken !== undefined,
        typeText: methodTypeText(member, sourceFile),
      });
      continue;
    }
    // ADR-0015 / ADR-0031: an object member this reader does not recognise is a hard failure,
    // never a skipped, silently-matching absence.
    throw new Error(
      `${constructName}: encountered a member this transcription reader does not understand ` +
        `(kind ${ts.SyntaxKind[member.kind]}: ${normalizeWhitespace(member.getText(sourceFile))}). ` +
        'Extend objectMembers() rather than ignore it.',
    );
  }
  return result;
}

function shapeOfType(type: ts.TypeNode, sourceFile: ts.SourceFile, constructName: string): Shape {
  if (ts.isTypeLiteralNode(type)) {
    return { kind: 'object', members: objectMembers(type.members, sourceFile, constructName) };
  }
  if (ts.isUnionTypeNode(type)) {
    const values = new Set<string>();
    for (const member of type.types) {
      if (ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)) {
        values.add(member.literal.text);
        continue;
      }
      throw new Error(
        `${constructName}: union member is not a string literal ` +
          `(${normalizeWhitespace(member.getText(sourceFile))}). This reader only understands ` +
          'string-literal unions.',
      );
    }
    return { kind: 'union', values };
  }
  throw new Error(
    `${constructName}: top-level type is neither an object type nor a string-literal union ` +
      `(${normalizeWhitespace(type.getText(sourceFile))}).`,
  );
}

/**
 * Parse `source` and return every top-level `type` alias / `interface` declaration, keyed by
 * name.
 *
 * `strict` controls what happens to a top-level statement that is neither: in the spec's fenced
 * ```ts blocks that is refused (ADR-0031 — the block is asserted to contain only declarations, so
 * anything else is a shape this gate cannot decide and must not pass over in silence); parsing the
 * real `driver.ts` / `types.ts` source needs `strict: false` because those files legitimately
 * contain `import` statements and comments that are not part of what is being compared.
 */
function extractDeclarations(
  source: string,
  options: { readonly strict: boolean },
): ReadonlyMap<string, Shape> {
  const sourceFile = ts.createSourceFile('extracted.ts', source, ts.ScriptTarget.Latest, true);
  const result = new Map<string, Shape>();
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      result.set(statement.name.text, shapeOfType(statement.type, sourceFile, statement.name.text));
      continue;
    }
    if (ts.isInterfaceDeclaration(statement)) {
      result.set(statement.name.text, {
        kind: 'object',
        members: objectMembers(statement.members, sourceFile, statement.name.text),
      });
      continue;
    }
    if (!options.strict) {
      continue;
    }
    throw new Error(
      `Unexpected top-level construct in a spec fenced block: ${ts.SyntaxKind[statement.kind]} ` +
        `(${normalizeWhitespace(statement.getText(sourceFile)).slice(0, 120)}...). ` +
        'A spec ```ts block under §14.2/§14.5/§15.1 is expected to hold only type aliases and ' +
        'interfaces; refusing rather than silently ignoring it (ADR-0031).',
    );
  }
  return result;
}

function getDeclaration(
  declarations: ReadonlyMap<string, Shape>,
  name: string,
  where: string,
): Shape {
  const found = declarations.get(name);
  if (found === undefined) {
    throw new Error(`${where} does not declare ${name} — nothing to compare it against.`);
  }
  return found;
}

/** Extract the markdown section under a heading (matched by prefix) up to the next heading. */
function extractSection(markdown: string, headingPrefix: string): string {
  const lines = markdown.split('\n');
  const startIndex = lines.findIndex((line) => line.trimEnd().startsWith(headingPrefix));
  if (startIndex === -1) {
    throw new Error(`docs/spec.md has no heading starting with ${JSON.stringify(headingPrefix)}.`);
  }
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  const sectionLines = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return sectionLines.join('\n');
}

/** Every ```ts fenced block in `section`, concatenated. */
function fencedTsBlocks(section: string, headingPrefix: string): string {
  const blocks = [...section.matchAll(/```ts\r?\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
  if (blocks.length === 0) {
    throw new Error(
      `No \`\`\`ts fenced block found under the heading ${JSON.stringify(headingPrefix)}.`,
    );
  }
  return blocks.join('\n');
}

function specDeclarationsUnder(
  specText: string,
  headingPrefix: string,
): ReadonlyMap<string, Shape> {
  const section = extractSection(specText, headingPrefix);
  const tsSource = fencedTsBlocks(section, headingPrefix);
  return extractDeclarations(tsSource, { strict: true });
}

// --- the one fixed substitution table (ADR W1-RN-02) -----------------------------------------

/**
 * Applied only to type text extracted from the **spec** side, only at member granularity (never
 * to a declaration name), before comparing it with the implementation's type text. This is the
 * single, named seam `docs/adr/W1-RN-02-runtime-driver-is-generic.md` settled: `driver.ts` is
 * generic over the request/event types because this package may not depend on
 * `@agent-workspace/core`, where the spec's own `AgentRunRequest` / `AgentEvent` live. No other
 * substitution is applied anywhere in this file.
 */
function substituteGenericSeam(typeText: string): string {
  return typeText
    .replace(/\bAgentRunRequest\b/g, 'TRequest')
    .replace(/\bAgentEvent\b/g, 'TEvent')
    .replace(/\bAgentConnection\b(?!<)/g, 'AgentConnection<TEvent>');
}

// --- comparison -------------------------------------------------------------------------------

/** Every mismatch between the spec's shape and the implementation's, each naming the member. */
function diffShapes(constructName: string, spec: Shape, impl: Shape): readonly string[] {
  if (spec.kind !== impl.kind) {
    return [`${constructName}: spec is a ${spec.kind}, implementation is a ${impl.kind}`];
  }
  const diffs: string[] = [];
  if (spec.kind === 'union' && impl.kind === 'union') {
    for (const value of spec.values) {
      if (!impl.values.has(value)) {
        diffs.push(
          `${constructName}: spec member ${JSON.stringify(value)} is missing from the implementation`,
        );
      }
    }
    for (const value of impl.values) {
      if (!spec.values.has(value)) {
        diffs.push(
          `${constructName}: implementation member ${JSON.stringify(value)} is not in the spec`,
        );
      }
    }
    return diffs;
  }
  if (spec.kind === 'object' && impl.kind === 'object') {
    for (const [name, specMember] of spec.members) {
      const implMember = impl.members.get(name);
      if (implMember === undefined) {
        diffs.push(
          `${constructName}.${name}: present in the spec, missing from the implementation`,
        );
        continue;
      }
      if (specMember.optional !== implMember.optional) {
        diffs.push(
          `${constructName}.${name}: optionality differs — spec is ` +
            `${specMember.optional ? 'optional' : 'required'}, implementation is ` +
            `${implMember.optional ? 'optional' : 'required'}`,
        );
      }
      const specTypeText = substituteGenericSeam(specMember.typeText);
      if (specTypeText !== implMember.typeText) {
        diffs.push(
          `${constructName}.${name}: type text differs — spec ${JSON.stringify(specTypeText)} ` +
            `(raw: ${JSON.stringify(specMember.typeText)}), implementation ` +
            `${JSON.stringify(implMember.typeText)}`,
        );
      }
    }
    for (const name of impl.members.keys()) {
      if (!spec.members.has(name)) {
        diffs.push(
          `${constructName}.${name}: present in the implementation, missing from the spec`,
        );
      }
    }
    return diffs;
  }
  return diffs;
}

function assertMatchesSpec(constructName: string, spec: Shape, impl: Shape): void {
  const diffs = diffShapes(constructName, spec, impl);
  if (diffs.length > 0) {
    throw new Error(
      `${constructName} does not match docs/spec.md — ${diffs.length} difference(s):\n` +
        diffs.map((d) => `  - ${d}`).join('\n'),
    );
  }
}

// --- the real comparisons -----------------------------------------------------------------

const specText = readFileSync(SPEC_PATH, 'utf8');
const driverSource = readFileSync(path.join(HERE, 'driver.ts'), 'utf8');
const typesSource = readFileSync(path.join(HERE, 'types.ts'), 'utf8');

const spec142 = specDeclarationsUnder(specText, '## 14.2 The runtime driver interface');
const spec145 = specDeclarationsUnder(specText, '## 14.5 Runtime capabilities');
const spec151 = specDeclarationsUnder(specText, '## 15.1 Profile schema');

const implDriver = extractDeclarations(driverSource, { strict: false });
const implTypes = extractDeclarations(typesSource, { strict: false });

// Each `it.each` below iterates the *keys of the parsed spec map*, never a hand-typed name list
// (B1, round 2): a construct §14.2/§14.5/§15.1's fenced block declares and `driver.ts`/`types.ts`
// does not is looked up via `getDeclaration()`, which throws naming it — it cannot be dropped by
// simply not appearing in an array literal here.

describe('§14.2 The runtime driver interface — driver.ts matches docs/spec.md token for token', () => {
  it.each([...spec142.keys()])('%s', (name) => {
    const spec = getDeclaration(spec142, name, 'docs/spec.md §14.2');
    const impl = getDeclaration(implDriver, name, 'packages/runtime/src/driver.ts');
    assertMatchesSpec(name, spec, impl);
  });
});

describe('§14.5 Runtime capabilities — driver.ts matches docs/spec.md token for token', () => {
  it.each([...spec145.keys()])('%s', (name) => {
    const spec = getDeclaration(spec145, name, 'docs/spec.md §14.5');
    const impl = getDeclaration(implDriver, name, 'packages/runtime/src/driver.ts');
    assertMatchesSpec(name, spec, impl);
  });
});

describe('§15.1 Profile schema — types.ts matches docs/spec.md token for token', () => {
  it.each([...spec151.keys()])('%s', (name) => {
    const spec = getDeclaration(spec151, name, 'docs/spec.md §15.1');
    const impl = getDeclaration(implTypes, name, 'packages/runtime/src/types.ts');
    assertMatchesSpec(name, spec, impl);
  });
});

// --- proof this gate can fail, in both directions (plan §3a-1's Accept, and the wave protocol's
// "a test that has never been seen to fail is not evidence") --------------------------------
//
// These do not re-run the real files. They feed the same `extractDeclarations` /
// `diffShapes` machinery used above two small, synthetic, self-contained snippets that stand in
// for "the spec grew a member the file doesn't have" and "the file grew a member the spec doesn't
// have" — proving the *mechanism* fails correctly without ever writing to `docs/spec.md`, which
// this task does not own. The corresponding real-file perturbation (editing `driver.ts`, which
// this task does own, adding and then removing a field, running `pnpm vitest run
// packages/runtime`, and reverting) was additionally performed by hand during development; its
// pasted, real terminal output is quoted in this task's PR body rather than kept as a permanent
// part of the suite, since a real perturbation cannot honestly stay both applied and reverted in
// the same commit.

describe('proof: a member added to the spec and not to the file fails, naming the member', () => {
  it('fails and names the missing member', () => {
    const specOnly = extractDeclarations(
      `
      interface Widget {
        id: string;
        newSpecField: number;
      }
      `,
      { strict: true },
    );
    const implOnly = extractDeclarations(
      `
      export type Widget = {
        readonly id: string;
      };
      `,
      { strict: false },
    );
    const diffs = diffShapes(
      'Widget',
      getDeclaration(specOnly, 'Widget', 'synthetic spec'),
      getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
    );
    expect(diffs).toEqual([
      'Widget.newSpecField: present in the spec, missing from the implementation',
    ]);
    expect(() =>
      assertMatchesSpec(
        'Widget',
        getDeclaration(specOnly, 'Widget', 'synthetic spec'),
        getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
      ),
    ).toThrowError(/Widget\.newSpecField: present in the spec, missing from the implementation/);
  });
});

describe('proof: a member added to the file and not to the spec fails, naming the member', () => {
  it('fails and names the extra member', () => {
    const specOnly = extractDeclarations(
      `
      interface Widget {
        id: string;
      }
      `,
      { strict: true },
    );
    const implOnly = extractDeclarations(
      `
      export type Widget = {
        readonly id: string;
        readonly extraImplField: boolean;
      };
      `,
      { strict: false },
    );
    const diffs = diffShapes(
      'Widget',
      getDeclaration(specOnly, 'Widget', 'synthetic spec'),
      getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
    );
    expect(diffs).toEqual([
      'Widget.extraImplField: present in the implementation, missing from the spec',
    ]);
    expect(() =>
      assertMatchesSpec(
        'Widget',
        getDeclaration(specOnly, 'Widget', 'synthetic spec'),
        getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
      ),
    ).toThrowError(/Widget\.extraImplField: present in the implementation, missing from the spec/);
  });
});

describe('proof: optionality and type-text mismatches are each named too', () => {
  it('names an optionality mismatch', () => {
    const specOnly = extractDeclarations('interface Widget { count?: number; }', { strict: true });
    const implOnly = extractDeclarations('export type Widget = { readonly count: number };', {
      strict: false,
    });
    const diffs = diffShapes(
      'Widget',
      getDeclaration(specOnly, 'Widget', 'synthetic spec'),
      getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
    );
    expect(diffs).toEqual([
      'Widget.count: optionality differs — spec is optional, implementation is required',
    ]);
  });

  it('names a type-text mismatch', () => {
    const specOnly = extractDeclarations('interface Widget { count: number; }', { strict: true });
    const implOnly = extractDeclarations('export type Widget = { readonly count: string };', {
      strict: false,
    });
    const diffs = diffShapes(
      'Widget',
      getDeclaration(specOnly, 'Widget', 'synthetic spec'),
      getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
    );
    expect(diffs).toEqual([
      'Widget.count: type text differs — spec "number" (raw: "number"), implementation "string"',
    ]);
  });

  it('does not report a difference for the one fixed generic seam (ADR W1-RN-02)', () => {
    const specOnly = extractDeclarations('interface Widget { request: AgentRunRequest; }', {
      strict: true,
    });
    const implOnly = extractDeclarations(
      'export type Widget<TRequest> = { readonly request: TRequest };',
      {
        strict: false,
      },
    );
    const diffs = diffShapes(
      'Widget',
      getDeclaration(specOnly, 'Widget', 'synthetic spec'),
      getDeclaration(implOnly, 'Widget', 'synthetic implementation'),
    );
    expect(diffs).toEqual([]);
  });
});

describe('proof: an unrecognised top-level construct in a strict (spec) block is refused, not skipped', () => {
  it('throws naming the construct kind, rather than comparing zero members to zero', () => {
    expect(() => extractDeclarations('const notADeclaration = 1;', { strict: true })).toThrowError(
      /Unexpected top-level construct in a spec fenced block/,
    );
  });

  it('the lenient (implementation-file) mode tolerates the same statement, by design', () => {
    expect(() =>
      extractDeclarations('const notADeclaration = 1;', { strict: false }),
    ).not.toThrow();
  });
});
