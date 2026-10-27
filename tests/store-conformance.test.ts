import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const ALLOWLIST = 'tests/fitness/store-conformance-allowlist.json';
const MEMORY_STORE = /(?:^|[/-])memory-(?:store|directory)\.ts$|(?:^|\/)memory-[^/]+\.ts$/u;

function tracked(pathspec: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', pathspec], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file !== '');
}

/** Calls per `describe*Conformance` identifier in one test file's source. */
function conformanceCalls(source: string): Map<string, number> {
  const calls = new Map<string, number>();
  const sf = ts.createSourceFile('t.ts', source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^describe\w*Conformance$/u.test(node.expression.text)
    ) {
      calls.set(node.expression.text, (calls.get(node.expression.text) ?? 0) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return calls;
}

/**
 * A memory store is held to the PostgreSQL contract when a test in its directory imports it, calls
 * one `describe*Conformance` suite at least twice (memory and a second implementation) and names
 * PostgreSQL. `files` maps repository path -> source.
 */
function memoryStoresWithoutConformance(files: ReadonlyMap<string, string>): string[] {
  const missing: string[] = [];
  for (const file of files.keys()) {
    if (!MEMORY_STORE.test(file) || /\.test\.ts$/u.test(file)) continue;
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file, '.ts');
    const covered = [...files].some(([test, source]) => {
      if (!test.endsWith('.test.ts') || path.posix.dirname(test) !== dir) return false;
      if (!source.includes(`from './${base}'`) || !/postgres/iu.test(source)) {
        return false;
      }
      return [...conformanceCalls(source).values()].some((count) => count >= 2);
    });
    if (!covered) missing.push(file);
  }
  return missing.sort();
}

const suite = `
import { InMemoryThing } from './memory-store';
export function describeThingConformance(label: string, make: () => void): void {}
describeThingConformance('memory', () => {});
describe.skipIf(!hasDatabase)('the PostgreSQL thing', () => {
  describeThingConformance('over a real PostgreSQL', () => {});
});
`;

describe('every in-memory store is held to the PostgreSQL contract (F-13)', () => {
  it('flags a planted memory store with no conformance suite', () => {
    const files = new Map([['apps/web/server/x/memory-store.ts', 'export class A {}']]);
    expect(memoryStoresWithoutConformance(files)).toEqual(['apps/web/server/x/memory-store.ts']);
  });

  it('accepts a memory store whose directory runs one suite on memory and PostgreSQL', () => {
    const files = new Map([
      ['apps/web/server/x/memory-store.ts', 'export class A {}'],
      ['apps/web/server/x/store.test.ts', suite],
    ]);
    expect(memoryStoresWithoutConformance(files)).toEqual([]);
  });

  it('has exactly the allowlisted stores without a suite, so the list can only shrink', () => {
    const files = new Map(
      tracked('apps/web/server')
        .filter((file) => file.endsWith('.ts'))
        .map((file) => [file, readFileSync(root + file, 'utf8')] as const),
    );
    const missing = memoryStoresWithoutConformance(files);
    const allowed = JSON.parse(readFileSync(root + ALLOWLIST, 'utf8')) as string[];
    expect(
      missing.filter((file) => !allowed.includes(file)),
      'a new memory store must ship with a describe<Port>Conformance suite that also runs on PostgreSQL',
    ).toEqual([]);
    expect(
      allowed.filter((file) => !missing.includes(file)),
      `stale entries: delete them from ${ALLOWLIST}`,
    ).toEqual([]);
  });
});
