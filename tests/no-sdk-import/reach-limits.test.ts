import { describe, expect, it } from 'vitest';

import { SDK_PACKAGE } from './boundaries.js';
import { scanModuleSource } from './scan.js';

const undecidableOf = (source: string) => scanModuleSource('fixture.ts', source).undecidable;

const DECLARED_GAP = 'this is the declared gap; if it is now refused, update the header';

/**
 * ADR-0031 clause 2. Every sentence of the header's limits section is one of these assertions,
 * written as a demonstration of the gap rather than as prose about it, because prose about a
 * gate's reach is the thing that stops the next reader looking.
 */
describe("where this gate's reach ends", () => {
  it('refuses eval and Function rather than analysing what they build', () => {
    // A specifier assembled inside a string of source this gate never parses is outside every
    // static analysis, so both constructs are refused whole.
    for (const source of [
      `const m = eval("require('@anthropic-ai/claude-agent-sdk')");`,
      `const build = new Function('s', 'return import(s)');`,
      `const build = Function('s', 'return import(s)');`,
    ]) {
      expect(undecidableOf(source), source).not.toEqual([]);
    }
    // The refusal is on the written form, not on every route to the same function. A copy reached
    // some other way is decided by the classifier on what it is handed, which is the declared
    // gap and not a special case.
    expect(undecidableOf(`const m = globalThis.eval('x');`)).toEqual([]);
  });

  it('does not see a specifier that arrives through a parameter', () => {
    // Stated as a passing scan, which is what makes it a gap and not a claim. `load` is a
    // parameter, so the callee is rooted at a name this file binds and the classifier vouches for
    // it; the specifier is a literal, but the loader was handed in from outside.
    const scan = scanModuleSource(
      'fixture.ts',
      `export function reach(load) {\n  return load('@anthropic-ai/claude-agent-sdk');\n}`,
    );
    expect(scan.undecidable, DECLARED_GAP).toEqual([]);
    expect(scan.references.map((reference) => reference.specifier)).not.toContain(SDK_PACKAGE);
    // The call that hands the loader in is not refused either: `module.require` in a non-call
    // position is a property access, refused only for the two entries in OPAQUE_PROPERTIES.
    expect(undecidableOf(`reach(module.require);`)).toEqual([]);
  });

  it('does not see a specifier that arrives out of a computation', () => {
    // The same limit on the argument rather than the callee: the gate reads a literal and a const
    // bound to one, and nothing else.
    const computed = `const parts = ['@anthropic-ai', 'claude-agent-sdk'];\nconst m = module.require(parts.join('/'));`;
    expect(undecidableOf(computed), DECLARED_GAP).toEqual([]);
    // The bound: the same computed specifier handed to a callee this gate *does* read a specifier
    // from is still a hard refusal. The gap needs an unrecognised loader and an assembled
    // specifier together.
    expect(undecidableOf(`const m = require(parts.join('/'));`)).not.toEqual([]);
  });

  it('binds names over the whole file rather than by scope', () => {
    // The least obvious limit. `module` is bound inside `shadow` and nowhere else, yet the call
    // outside it is vouched for, because the binding set is per-file. A scope-accurate binder
    // would refuse this; this gate does not have one.
    const shadowed = `function shadow(module) {\n  return module;\n}\nconst m = module.require('@anthropic-ai/claude-agent-sdk');`;
    expect(undecidableOf(shadowed), DECLARED_GAP).toEqual([]);
    // The control that keeps the sentence about scope rather than about `module`: with no such
    // binding anywhere in the file, the identical call is refused.
    expect(
      undecidableOf(`const m = module.require('@anthropic-ai/claude-agent-sdk');`),
    ).not.toEqual([]);
  });
});
