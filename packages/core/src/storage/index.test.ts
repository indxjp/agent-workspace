/**
 * What may be reached from the storage barrel — a guard on the module graph, not on behaviour.
 *
 * `index.ts` is a *runtime* surface: `apps/web`'s files routes evaluate everything reachable from
 * it inside a running Next.js server, where `vitest` is not installed and not resolvable. Round 5
 * of this task's verification found `contract.ts` (which imports `vitest` at module scope, because
 * `describe`/`it` cannot be reached any other way) re-exported from that barrel, and W2-INT-01
 * measured the consequence on a real server: **500 on all five `/api/files*` routes**.
 *
 * **This file cannot prove the fix.** It runs under Vitest, which is precisely the environment in
 * which the broken import resolves — a passing run here says nothing about a server. The proof is
 * a deployment-shaped import with no devDependencies on the resolution path:
 *
 * ```
 * $ cp -r packages/core/dist /tmp/prodsim/dist && cd /tmp/prodsim
 * $ node --input-type=module -e "await import('./dist/storage/index.js')"
 * ```
 *
 * What this file *is* for is stopping the import from coming back: it walks the static import
 * closure of `index.ts` over the source tree and fails if anything in it imports a test framework.
 * A regression guard for a defect no other gate in this repository can see — `pnpm build`,
 * `pnpm typecheck` and `pnpm lint` never evaluate the module, and every other suite is Vitest.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `source` with its comments removed, so a specifier *named in prose* is not mistaken for one the
 * module actually imports — this file's own subject is a comment in `index.ts` explaining which
 * import must never come back, and every module here documents its imports heavily. Line comments
 * are cut only where `//` is not preceded by `:`, which leaves `https://` and `postgres://` inside
 * string literals intact.
 */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every `from '…'` specifier actually imported by `source` (comments excluded), in order. */
function specifiersOf(source: string): string[] {
  return [...codeOf(source).matchAll(/\bfrom\s+'([^']+)'/g)].map((match) => match[1] as string);
}

/**
 * Every source file reachable from `entry` by static relative imports, `entry` included. Relative
 * specifiers are NodeNext-style (`./x.js` naming `x.ts`), which is how this package is written and
 * built; a bare specifier is a package boundary and is returned as-is by {@link packagesUsedFrom}.
 */
function closureOf(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      queue.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')));
    }
  }
  return [...seen];
}

/** Every bare (package) specifier imported anywhere in the closure, with the file that imports it. */
function packagesUsedFrom(entry: string): Array<{ file: string; specifier: string }> {
  const used: Array<{ file: string; specifier: string }> = [];
  for (const file of closureOf(entry)) {
    for (const specifier of specifiersOf(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) continue;
      used.push({ file: path.relative(here, file), specifier });
    }
  }
  return used;
}

describe('the storage barrel is a runtime surface', () => {
  it('reaches no test framework, so a server can evaluate everything behind it', () => {
    const offenders = packagesUsedFrom(path.join(here, 'index.ts')).filter(({ specifier }) =>
      /^(vitest|@vitest\/|jest|@jest\/|mocha|node:test)/.test(specifier),
    );
    expect(
      offenders,
      'a module reachable from index.ts imports a test framework; a real server cannot resolve it',
    ).toEqual([]);
  });

  it('reaches only the reviewed cloud clients in addition to node: builtins', () => {
    const external = packagesUsedFrom(path.join(here, 'index.ts')).filter(
      ({ specifier }) => !specifier.startsWith('node:'),
    );
    expect(external).toEqual([
      { file: 'gcs-store.ts', specifier: '@google-cloud/storage' },
      { file: 'azure-blob-store.ts', specifier: '@azure/identity' },
      { file: 'azure-blob-store.ts', specifier: '@azure/storage-blob' },
      { file: 's3-store.ts', specifier: '@aws-sdk/client-s3' },
    ]);
  });

  it('still reaches the contract suite by path, which is how a backend test uses it', () => {
    // The suite did not become unreachable; it stopped being reachable from *production* code.
    // `local-fs-store.test.ts`, `memory-store.test.ts` and `contract.ts`'s own recipe all spell it
    // this way, and a test file may import `vitest` because a test file runs under Vitest.
    expect(specifiersOf(readFileSync(path.join(here, 'contract.ts'), 'utf8'))).toContain('vitest');
    for (const suite of [
      'azure-blob-store.test.ts',
      'gcs-store.live.test.ts',
      'gcs-store.test.ts',
      'local-fs-store.test.ts',
      'memory-store.test.ts',
      's3-store.test.ts',
    ]) {
      expect(specifiersOf(readFileSync(path.join(here, suite), 'utf8'))).toContain('./contract.js');
    }
    expect(specifiersOf(readFileSync(path.join(here, 'index.ts'), 'utf8'))).not.toContain(
      './contract.js',
    );
  });
});
