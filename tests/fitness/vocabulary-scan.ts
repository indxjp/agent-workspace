import ts from 'typescript';

/** A closed vocabulary exported by `packages/contracts`: tuple name -> its members. */
export type Vocabularies = ReadonlyMap<string, readonly string[]>;

const TUPLE_NAME = /_(?:STATUSES|ROLES)$/u;

function stringMembers(nodes: readonly ts.Node[]): string[] | null {
  const out: string[] = [];
  for (const node of nodes) {
    let literal: ts.Node = node;
    if (ts.isLiteralTypeNode(node)) literal = node.literal;
    if (!ts.isStringLiteral(literal) && !ts.isNoSubstitutionTemplateLiteral(literal)) return null;
    out.push(literal.text);
  }
  return out;
}

function parse(file: string, source: string): ts.SourceFile {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
}

/** Every exported `*_STATUSES` / `*_ROLES` string tuple declared in the given contracts sources. */
export function contractVocabularies(sources: ReadonlyMap<string, string>): Vocabularies {
  const found = new Map<string, readonly string[]>();
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        TUPLE_NAME.test(node.name.text) &&
        node.initializer !== undefined
      ) {
        let init = node.initializer;
        if (ts.isAsExpression(init)) init = init.expression;
        if (ts.isArrayLiteralExpression(init)) {
          const members = stringMembers(init.elements);
          if (members !== null) found.set(node.name.text, members);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file, source));
  }
  return found;
}

/**
 * Re-declarations: a string-literal array or union type (two or more members) whose member SET
 * equals a contracts vocabulary (order and duplicates ignored). Strict subsets and supersets are
 * deliberately not flagged: `['completed', 'failed']` is an ordinary two-value choice, not a copy.
 * Returns sorted, unique `file::VOCABULARY` keys.
 */
export function findRedeclarations(
  sources: ReadonlyMap<string, string>,
  vocabularies: Vocabularies,
): string[] {
  const byShape = new Map<string, string[]>();
  for (const [name, members] of vocabularies) {
    const shape = [...new Set(members)].sort().join('\u0000');
    byShape.set(shape, [...(byShape.get(shape) ?? []), name]);
  }
  const hits = new Set<string>();
  for (const [file, source] of sources) {
    const visit = (node: ts.Node): void => {
      let members: string[] | null = null;
      if (ts.isArrayLiteralExpression(node)) members = stringMembers(node.elements);
      else if (ts.isUnionTypeNode(node)) members = stringMembers(node.types);
      if (members !== null && members.length >= 2) {
        const shape = [...new Set(members)].sort().join('\u0000');
        for (const name of byShape.get(shape) ?? []) hits.add(`${file}::${name}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file, source));
  }
  return [...hits].sort();
}
