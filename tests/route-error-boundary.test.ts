// Fitness test for the one API error boundary (engineering audit F-11): every HTTP method a
// `apps/web/app/api/**/route.ts` exports is `export const METHOD = route(...)`, so a thrown error is
// answered as a typed envelope and logged with its route, never as Next's bodiless 500. The
// allowlist holds the route files that predate the rule and may only shrink.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { trackedTextFiles } from '../scripts/ci/debt-review.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ALLOWLIST = 'tests/fitness/route-error-boundary-allowlist.json';
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ROUTE_FILE = /^apps\/web\/app\/api\/(?:.*\/)?route\.ts$/u;

const exported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** The HTTP methods `text` exports without going through `route(...)`. */
export function unguardedMethods(text: string): string[] {
  const source = ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && exported(statement)) {
      const name = statement.name?.text;
      if (name !== undefined && METHODS.has(name)) found.push(name);
    } else if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !METHODS.has(declaration.name.text)) continue;
        const value = declaration.initializer;
        const guarded =
          value !== undefined &&
          ts.isCallExpression(value) &&
          ts.isIdentifier(value.expression) &&
          value.expression.text === 'route';
        if (!guarded) found.push(declaration.name.text);
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          if (METHODS.has(element.name.text)) found.push(element.name.text);
        }
      }
    }
  }
  return found;
}

describe('every API route goes through the route() error boundary', () => {
  it('flags a method exported any way but through route()', () => {
    expect(unguardedMethods('export async function GET() {}')).toEqual(['GET']);
    expect(unguardedMethods('export const POST = handler;')).toEqual(['POST']);
    expect(unguardedMethods('export const PUT = other(x, y);')).toEqual(['PUT']);
    expect(unguardedMethods('export { serve as PATCH };')).toEqual(['PATCH']);
    expect(
      unguardedMethods("export const GET = route({ component: 'a', operation: 'b' }, f);"),
    ).toEqual([]);
    expect(
      unguardedMethods("export const dynamic = 'force-dynamic';\nasync function GET() {}"),
    ).toEqual([]);
  });

  it('every unguarded route file is on the allowlist, and the list only shrinks', () => {
    const allowed = JSON.parse(readFileSync(root + ALLOWLIST, 'utf8')) as string[];
    const unguarded = trackedTextFiles()
      .filter((file) => ROUTE_FILE.test(file.path) && unguardedMethods(file.text).length > 0)
      .map((file) => file.path)
      .sort();
    expect(
      unguarded.filter((path) => !allowed.includes(path)),
      'wrap each exported method: `export const GET = route({ component, operation }, serve)`',
    ).toEqual([]);
    expect(
      allowed.filter((path) => !unguarded.includes(path)),
      `these routes now go through route(): delete their entries in ${ALLOWLIST}`,
    ).toEqual([]);
    expect(allowed, `keep ${ALLOWLIST} sorted`).toEqual([...allowed].sort());
  });
});
