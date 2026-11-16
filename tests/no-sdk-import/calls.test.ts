import { describe, expect, it } from 'vitest';

import { SDK_PACKAGE } from './boundaries.js';
import { stringNamesAModule } from './resolve.js';
import { OPAQUE_CALLS, OPAQUE_PROPERTIES, RESOLVER_CALLS } from './call-forms.js';
import { scanModuleSource } from './scan.js';

const TITLE = 'the call-site classifier decides every call, not the ones it has names for';

const undecidableOf = (source: string, file = 'fixture.ts') =>
  scanModuleSource(file, source).undecidable;

const specifiersOf = (source: string, file = 'fixture.ts'): string[] =>
  scanModuleSource(file, source).references.map((reference) => reference.specifier);

/** The name must be refused without this gate having learned it (ADR-0031: no enumeration). */
function expectNameInNoTable(name: string, message: string): void {
  for (const table of [RESOLVER_CALLS, OPAQUE_CALLS, OPAQUE_PROPERTIES]) {
    expect([...table], message).not.toContain(name);
  }
}

/**
 * ADR-0031 clause 1, and the round-4 finding it answers: the version this replaced chose which
 * call sites to examine from three tables of callee names, and a callee in none of them fell out
 * of the branch with no `else`. Four real node module loaders were outside the tables, each proved
 * by running node and watching the SDK load.
 */
const LOADERS_A_VERIFIER_RAN: ReadonlyArray<readonly [string, string]> = [
  ['module.require', `const m = module.require('@anthropic-ai/claude-agent-sdk');`],
  ['require.main.require', `const m = require.main.require('@anthropic-ai/claude-agent-sdk');`],
  [
    'process.mainModule.require',
    `const m = process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
  ],
  ['load', `const load = require;\nconst m = load('@anthropic-ai/claude-agent-sdk');`],
];

describe(TITLE, () => {
  it.each(LOADERS_A_VERIFIER_RAN)(
    'refuses %s, and does so without holding its name anywhere',
    (callee, source) => {
      // Both halves matter, and the second makes this a different gate rather than a longer
      // table: the callee is refused *and* no table mentions it.
      expect(undecidableOf(source), `${callee} was not refused`).not.toEqual([]);
      expectNameInNoTable(
        callee,
        `${callee} is refused because this file learned its name, which is the enumeration ADR-0031 forbids`,
      );
    },
  );

  it('refuses four constructs nobody has run at it, including one rooted at no name', () => {
    // The first three were each written into a tracked `.cjs` and run: `node <file>` printed
    // `query is a function` for all three, so all three really do load the SDK, and none of
    // their callees is named anywhere in this gate.
    const loadTheSdkUnderNode = [
      `const m = Reflect.apply(module.require, module, ['@anthropic-ai/claude-agent-sdk']);`,
      `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require('node:module')._load(spec, module, false);`,
      `const m = globalThis.process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
    ];
    // Not a working loader (detaching `module.require` from its receiver makes node throw
    // `MODULE_NOT_FOUND`), but rooted at no identifier at all, a shape `calleeRoot` answers
    // `null` for.
    const rootedAtNoName = `const m = (0, module.require)('@anthropic-ai/claude-agent-sdk');`;
    for (const source of [...loadTheSdkUnderNode, rootedAtNoName]) {
      expect(undecidableOf(source), source).not.toEqual([]);
    }
  });

  it('names the file and the construct it could not decide', () => {
    // Clause 1 asks for both, because "something in this repository is undecidable" is not a
    // report anyone can act on.
    const scan = scanModuleSource(
      'apps/runner/src/door.cjs',
      `const m = module.require('@anthropic-ai/claude-agent-sdk');`,
    );
    const first = scan.undecidable[0];
    expect(first?.file).toBe('apps/runner/src/door.cjs');
    expect(first?.reason).toContain('module.require');
    expect(first?.reason).toContain('@anthropic-ai/claude-agent-sdk');
  });
});

const SDK_FILE =
  './packages/engine-claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
const FREE_WORKER = `new (require('node:worker_threads').Worker)`;

describe(TITLE, () => {
  it('gives a construction a verdict, on three shapes that each loaded the SDK under node', () => {
    // The round-5 finding: `new` had an arm of its own that recorded no verdict, on the claim
    // that nothing else `new` can be applied to loads a module. `new Worker(path)` does: node
    // resolves and executes the entry module on a thread. All three sources were run from
    // tracked files, each printing `exit code 0` with no `error` event.

    // (a) The plain form is a refusal, and it names both the construct and the file.
    const plain = undecidableOf(`const w = ${FREE_WORKER}('${SDK_FILE}');`);
    expect(plain, 'a `new` handed a resolvable specifier fell out of the branch').not.toEqual([]);
    expect(plain[0]?.reason).toContain('Worker');
    expect(plain[0]?.reason).toContain(SDK_FILE);
    expectNameInNoTable(
      'Worker',
      'Worker is refused because this file learned its name, which is the enumeration ADR-0031 forbids',
    );

    // (b) and (c) are the two shapes the base-URL arm reads, so their verdict is *collected*
    // rather than refused, and what it collects is the SDK, which fails the §42 assertion. (c) is
    // the ordinary ESM idiom: the outer callee is bound by the import, so the specifier is
    // inside the nested `new URL`.
    for (const source of [
      `const w = ${FREE_WORKER}('${SDK_FILE}', 'file:///x/');`,
      `import { Worker } from 'node:worker_threads';\nconst w = new Worker(new URL('${SDK_FILE}', import.meta.url));`,
    ]) {
      expect(specifiersOf(source), source).toContain(SDK_FILE);
    }
  });

  it('reads a reference resolved against a base URL by the pair, not by the callee being URL', () => {
    // The arm that keeps the construction refusal from refusing the tracked tree: two real sites
    // have the shape (`readFileSync(new URL('./agent-form.tsx', import.meta.url), 'utf8')` in the
    // web components tests, and the `fileURLToPath(new URL(…))` in the run-store tests). What
    // decides them is the argument pair, which is why the callee's name is in no table.
    const url = `const url = new URL('./package.json', import.meta.url);`;
    expect(undecidableOf(url)).toEqual([]);
    expectNameInNoTable('URL', 'the base-URL arm is a name after all');
    // A callee this file has never heard of, handed the same pair, is read the same way…
    const unheardOf = `const x = new Wibble('./package.json', import.meta.url);`;
    expect(undecidableOf(unheardOf)).toEqual([]);
    expect(specifiersOf(unheardOf)).toContain('./package.json');
    // …and without the base URL it is refused, so it is the pair doing the work.
    expect(undecidableOf(`const x = new Wibble('./package.json');`)).not.toEqual([]);
    // The arm is collecting, not exempting: a specifier that resolves now puts its file in the
    // detected set.
    expect(
      specifiersOf(
        `const u = new globalThis.URL('@anthropic-ai/claude-agent-sdk', 'file:///x/');`,
        'apps/runner/src/b15.cjs',
      ),
    ).toContain(SDK_PACKAGE);
  });
});

describe(TITLE, () => {
  it('collects every string at a base-URL call, so a later one is not left undecided', () => {
    // A regression the closeout diff introduced and that must not come back: the arm collected
    // the first resolvable string and then *returned*, so at a call carrying a base URL every
    // later string, the SDK included, fell out of the loop with no verdict. The candidate is what
    // the arm decides; the call is only where the base URL is found.
    const collected = specifiersOf(
      `const q = Wibble('./package.json', 'file:///x/', '@anthropic-ai/claude-agent-sdk');`,
      'b20.cjs',
    );
    expect(collected, 'the first resolvable string is still collected').toContain('./package.json');
    expect(
      collected,
      'a string after the first at a base-URL call left with no verdict — the arm returned instead of continuing',
    ).toContain(SDK_PACKAGE);
    // The bound: the same line with the SDK *first* was already decided before the patch, which
    // is why the regression was silent on one ordering and loud on the other.
    expect(
      specifiersOf(`const q = Wibble('@anthropic-ai/claude-agent-sdk', 'file:///x/');`, 'b21.cjs'),
    ).toContain(SDK_PACKAGE);
  });
});

describe(TITLE, () => {
  it('reads a specifier spread into a call, which is a literal written at the call site', () => {
    // The round-5 major finding: a tracked file holding this line loaded the SDK under node while
    // the gate stayed green, and the same array literal one AST node away, in `Reflect.apply`,
    // was refused. Only the `...` changed the verdict, on a specifier written out verbatim.
    const spread = undecidableOf(
      `const m = module.require(...['@anthropic-ai/claude-agent-sdk']);`,
    );
    expect(spread, 'a spread hides nothing: the literal is written here').not.toEqual([]);
    expect(spread[0]?.reason).toContain(SDK_PACKAGE);
    // The sibling it was measured against, still refused.
    expect(
      undecidableOf(
        `const m = Reflect.apply(module.require, module, ['@anthropic-ai/claude-agent-sdk']);`,
      ),
    ).not.toEqual([]);
    // And the bound, so the limit is visible rather than claimed: a spread of a *name* is not
    // read, because the one step of value tracking ends at a literal. That is the declared
    // computed-specifier gap, not a second silent path.
    expect(
      undecidableOf(
        `const parts = ['@anthropic-ai/claude-agent-sdk'];\nconst m = module.require(...parts);`,
      ),
      'this is the declared gap; if it is now refused, update the header',
    ).toEqual([]);
  });
});

describe(TITLE, () => {
  it('leaves the ordinary calls this repository is made of alone', () => {
    // The other direction, and the reason the classifier asks what a call is *handed* rather than
    // what it is called: a rule that refused every callee it could not name would refuse most of
    // the tree. Each is a shape the tracked tree really contains, written with the binding the
    // real file gives it, which is why they are decided rather than refused.
    const ordinary = [
      `console.log('@anthropic-ai/claude-agent-sdk is confined to one module');`,
      `import path from 'node:path';\nconst joined = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');`,
      `import { describe } from 'vitest';\ndescribe('@agent-workspace/core', () => {});`,
      `const url = new URL('./package.json', import.meta.url);`,
      `import { expect } from 'vitest';\nexpect(name).toBe('@anthropic-ai/claude-agent-sdk');`,
    ];
    for (const source of ordinary) expect(undecidableOf(source), source).toEqual([]);
    // The `new URL` row is *collected* by the base-URL arm rather than passed over, and
    // `./package.json` really resolves from here, so it is not passing because the string named
    // nothing.
    expect(stringNamesAModule('fixture.ts', './package.json')).not.toBeNull();
    expect(specifiersOf(`const url = new URL('./package.json', import.meta.url);`)).toContain(
      './package.json',
    );
    // The same `path.join` line without the import that binds `path` is refused.
    expect(
      undecidableOf(`const joined = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');`),
    ).not.toEqual([]);
  });

  it('reads a specifier the file lifted into a const, and refuses to guess at one bound twice', () => {
    // The single step of value-tracking, in both directions: a name bound once by `const` to a
    // literal is that literal, and a name bound more than once is dropped rather than guessed.
    const once = `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require(spec);`;
    expect(undecidableOf(once)).toEqual([]);
    expect(specifiersOf(once)).toContain(SDK_PACKAGE);

    const twice = `const spec = '@anthropic-ai/claude-agent-sdk';\nfunction other() {\n  const spec = 'node:fs';\n  return spec;\n}\nconst m = require(spec);`;
    expect(specifiersOf(twice)).not.toContain(SDK_PACKAGE);
    expect(
      undecidableOf(twice),
      'a specifier this gate cannot read is a refusal, not a pass',
    ).not.toEqual([]);
  });
});
