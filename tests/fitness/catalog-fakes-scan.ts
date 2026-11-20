// The scan behind the catalog-fake rule (the storage design, §07 rule 4): tests use
// `createInMemoryCatalog()`, not their own hand-written copies of the catalog port. Its fixture
// cases are tests/catalog-fakes.test.ts; the run over every tracked test file, against the
// allowlist, is tests/catalog-fakes.policy-check.ts (`pnpm policy:check`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const ALLOWLIST = 'tests/fitness/catalog-fakes-allowlist.json';
const CATALOG_PORTS = ['ResourceCatalogRepository', 'CatalogPort'];
// Repository-only members: the port's own `get`/`list`/`remove` are too generic to prove a catalog.
const CATALOG_METHODS = new Set([
  'reserve',
  'confirm',
  'createFolder',
  'referencing',
  'deleting',
  'forget',
  'listSkills',
  'putSkill',
  'deleteSkill',
  'publishSkillRevision',
  'listSkillRevisions',
]);
const PAIRS = [
  ['list', 'reserve'],
  ['listSkills', 'putSkill'],
] as const;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export function allowlist(): Record<string, number> {
  return JSON.parse(readFileSync(root + ALLOWLIST, 'utf8')) as Record<string, number>;
}

/** Strips `as X`, `satisfies X`, `<X>` and parentheses. */
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node) ||
    ts.isTypeAssertionExpression(node)
    ? unwrap(node.expression)
    : node;
}

/** The rightmost name, so `db.CatalogPort` compares as `CatalogPort`. */
function lastName(name: ts.EntityName | ts.Expression): string {
  if (ts.isQualifiedName(name)) return name.right.text;
  if (ts.isPropertyAccessExpression(name)) return name.name.text;
  return name.getText();
}

/** Whether a type names a catalog port; `Port['member']` only borrows a member type, so is skipped. */
function namesPort(type: ts.Node | undefined): boolean {
  if (!type || ts.isIndexedAccessTypeNode(type)) return false;
  if (ts.isTypeReferenceNode(type) && CATALOG_PORTS.includes(lastName(type.typeName))) return true;
  return type.getChildren().some(namesPort);
}

function memberName(node: ts.Node): string | undefined {
  return (ts.isPropertyAssignment(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isVariableDeclaration(node)) &&
    ts.isIdentifier(node.name)
    ? node.name.text
    : undefined;
}

/** True when a catalog-method literal is where a catalog is expected: under `forWorkspace`, or the `catalog` value. */
function inCatalogPosition(literal: ts.ObjectLiteralExpression): boolean {
  let child: ts.Node = literal;
  for (let node = literal.parent; node; child = node, node = node.parent) {
    const name = memberName(node);
    if (name === 'forWorkspace') return true;
    if (ts.isAsExpression(node) && node.type.getText().includes('forWorkspace')) return true;
    if (name === 'catalog') {
      const initializer = (node as ts.PropertyAssignment | ts.VariableDeclaration).initializer;
      return initializer !== undefined && unwrap(initializer) === literal && child === initializer;
    }
  }
  return false;
}

function isShapedFake(literal: ts.ObjectLiteralExpression): boolean {
  const names = new Set<string>();
  for (const member of literal.properties) {
    if (member.name && ts.isIdentifier(member.name)) names.add(member.name.text);
  }
  if (PAIRS.some((pair) => pair.every((name) => names.has(name)))) return true;
  // `{ ...catalog, reserve() { … } }` wraps a real catalog and overrides one member: not a copy.
  const wrapsCatalog = literal.properties.some(ts.isSpreadAssignment);
  return (
    !wrapsCatalog &&
    [...names].some((name) => CATALOG_METHODS.has(name)) &&
    inCatalogPosition(literal)
  );
}

/** `path → number of hand-written catalog fakes` in the given test files. */
export function findCatalogFakes(files: readonly SourceFile[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const sites = new Set<number>();
    const literalsByName = new Map<string, number>();
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = unwrap(node.initializer);
        if (ts.isObjectLiteralExpression(value))
          literalsByName.set(node.name.text, value.getStart());
        if (
          namesPort(node.type) &&
          (ts.isObjectLiteralExpression(value) || ts.isClassExpression(value))
        )
          sites.add(value.getStart());
      } else if (
        (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) &&
        namesPort(node.type)
      ) {
        const value = unwrap(node.expression);
        const named = ts.isIdentifier(value) ? literalsByName.get(value.text) : undefined;
        sites.add(named ?? value.getStart());
      } else if (
        ts.isClassLike(node) &&
        node.heritageClauses?.some((clause) =>
          clause.types.some((type) => CATALOG_PORTS.includes(lastName(type.expression))),
        )
      ) {
        sites.add(node.getStart());
      } else if (ts.isObjectLiteralExpression(node) && isShapedFake(node)) {
        sites.add(node.getStart());
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (sites.size > 0) found[path] = sites.size;
  }
  return found;
}

/** Shared by the real scan and the fixtures: new files, grown counts, stale and not-lowered entries. */
export function compare(found: Record<string, number>, allowed: Record<string, number>) {
  const paths = [...new Set([...Object.keys(found), ...Object.keys(allowed)])].sort();
  const pick = (keep: (now: number, then: number | undefined) => boolean) =>
    paths.filter((path) => keep(found[path] ?? 0, allowed[path]));
  return {
    added: pick((now, then) => then === undefined && now > 0),
    grown: pick((now, then) => then !== undefined && now > then),
    stale: pick((now, then) => then !== undefined && now === 0),
    shrunk: pick((now, then) => then !== undefined && now > 0 && now < then),
  };
}
