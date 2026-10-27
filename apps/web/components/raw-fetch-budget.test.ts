/**
 * Counts raw browser network calls per file under `components/**`, `app/**` and `lib/**`
 * (excluding `app/api`, `route.ts` and tests). The budget may only go down: a new call fails the
 * test, and so does a migrated call whose entry was not lowered.
 *
 * The source is parsed rather than matched textually, so comments, strings and property names
 * never count, and `fetch<T>(` or `fetch (` cannot slip past. A file's count is the sum of:
 *   - every value reference to the identifier `fetch` (a call, an argument, a default, `{ fetch }`);
 *   - every call of `fetchJson`;
 *   - every call of an injected request helper: a parameter of an enclosing function that is typed
 *     `typeof fetch` or defaults to `fetch`, so `request('/api/…')` counts like `fetch('/api/…')`.
 *
 * Issue #247 moves each family onto `@indx-workspace/sdk`, lowers or deletes its entries in the
 * same PR, and deletes this test when `BUDGET` is empty.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url));

const BUDGET: Record<string, number> = {
  'components/runtimes/model.ts': 1,
  'components/runtimes/runtimes-screen.tsx': 1,
  'components/setup/setup-wizard.tsx': 2,
  'components/shares/public-message-form.tsx': 2,
};

function isFetchValueReference(identifier: ts.Identifier): boolean {
  const { parent } = identifier;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if (ts.isTypeQueryNode(parent) || ts.isQualifiedName(parent)) return false;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === identifier &&
    ts.isIdentifier(parent.expression) &&
    ['globalThis', 'window', 'self'].includes(parent.expression.text)
  ) {
    return true;
  }
  if ('name' in parent && parent.name === identifier) return false;
  if ('propertyName' in parent && parent.propertyName === identifier) return false;
  return true;
}

function isFetchLike(parameter: ts.ParameterDeclaration): boolean {
  const { type, initializer } = parameter;
  const typedAsFetch =
    type !== undefined &&
    ts.isTypeQueryNode(type) &&
    ts.isIdentifier(type.exprName) &&
    type.exprName.text === 'fetch';
  const defaultsToFetch =
    initializer !== undefined && ts.isIdentifier(initializer) && initializer.text === 'fetch';
  return typedAsFetch || defaultsToFetch;
}

function isInjectedRequest(callee: ts.Identifier): boolean {
  for (let node: ts.Node | undefined = callee.parent; node; node = node.parent) {
    if (
      ts.isFunctionLike(node) &&
      node.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) &&
          parameter.name.text === callee.text &&
          isFetchLike(parameter),
      )
    ) {
      return true;
    }
  }
  return false;
}

function countRawFetches(fileName: string, source: string): number {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'fetch' && isFetchValueReference(node)) {
      count += 1;
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === 'fetchJson' || isInjectedRequest(node.expression))
    ) {
      count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

function collectCounts(relativeDir: string, counts: Record<string, number>): void {
  for (const entry of readdirSync(path.join(WEB_ROOT, relativeDir), { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (relativePath !== 'app/api') collectCounts(relativePath, counts);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) continue;
    if (entry.name === 'route.ts') continue;
    const count = countRawFetches(
      relativePath,
      readFileSync(path.join(WEB_ROOT, relativePath), 'utf8'),
    );
    if (count > 0) counts[relativePath] = count;
  }
}

function collectAllCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const directory of ['components', 'app', 'lib']) collectCounts(directory, counts);
  return counts;
}

describe('countRawFetches', () => {
  const count = (source: string, fileName = 'sample.ts'): number =>
    countRawFetches(fileName, source);

  it.each([
    ["fetch<T>('/api/x')", 1],
    ["fetch ('/api/x')", 1],
    ["await fetch('/api/x', { cache: 'no-store' })", 1],
    ['run(fetch)', 1],
    ['const deps = { fetch };', 1],
    ["globalThis.fetch('/api/x')", 1],
    ["window.fetch('/api/x')", 1],
    ["fetchJson('/api/x', Schema)", 1],
    ["fetchJson<T>('/api/x', Schema)", 1],
  ])('counts %s', (source, expected) => {
    expect(count(source)).toBe(expected);
  });

  it.each([
    ["ok(); // fetch('/api/x')", 'a trailing line comment'],
    ["/* fetch('/api/x') */", 'a block comment'],
    ["const s = 'fetch(';", 'a string'],
    ['const s = `fetch(`;', 'a template'],
    ["x.fetch('/a')", 'a property call'],
    ['const o = { fetch: 1 };', 'a property key'],
    ['const request: typeof fetch = stub;', 'a type query'],
    ['type F = typeof globalThis.fetch;', 'a qualified type query'],
    ["import { fetchJson } from './fetch-json';", 'an import'],
    ['export function fetchJson() {}', 'a declaration'],
  ])('ignores %s (%s)', (source) => {
    expect(count(source)).toBe(0);
  });

  it('counts an injected request helper call and its default as separate references', () => {
    expect(count("function f(r = fetch) { return r('/api/x'); }")).toBe(2);
  });

  it('counts a call of a parameter typed as fetch', () => {
    expect(count("function f(request: typeof fetch) { return request('/api/x'); }")).toBe(1);
  });

  it('counts a helper call from a nested function', () => {
    expect(count("function f(request: typeof fetch) { return () => request('/api/x'); }")).toBe(1);
  });

  it('does not count a call of an unrelated parameter', () => {
    expect(count("function f(request: Send) { return request('/api/x'); }")).toBe(0);
  });

  it('parses JSX according to the file extension', () => {
    expect(count("const A = () => <button onClick={() => fetch('/api/x')} />;", 'sample.jsx')).toBe(
      1,
    );
  });
});

describe('raw browser fetch budget', () => {
  it('matches the raw fetch budget; lower it when a family moves to the SDK (#247)', () => {
    expect(collectAllCounts()).toEqual(BUDGET);
  });
});
