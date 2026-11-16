/**
 * Sources written out in full rather than assembled from fragments. This file is scanned like
 * every other, and the scan is over its syntax tree: a specifier inside a string literal is a
 * string, not an import. The §42 set equality is what proves that — this file would be in it
 * otherwise.
 */
export type Sample = readonly [label: string, source: string];

export const RECOGNISED: readonly Sample[] = [
  ['a named import', `import { query } from '@anthropic-ai/claude-agent-sdk';`],
  ['a default import', `import sdk from '@anthropic-ai/claude-agent-sdk';`],
  ['a type-only import', `import type { Options } from '@anthropic-ai/claude-agent-sdk';`],
  ['a namespace import', `import * as sdk from "@anthropic-ai/claude-agent-sdk";`],
  ['a bare side-effect import', `import '@anthropic-ai/claude-agent-sdk';`],
  // Valid ESM and TypeScript; the pattern this walk replaced required `\bimport\s+` and matched
  // nothing here while its own table claimed the side-effect import was covered.
  ['a bare side-effect import with no space', `import'@anthropic-ai/claude-agent-sdk';`],
  // `\u0040` is `@`: the SDK's real name to node and tsc, and a different string to any
  // comparison made on raw source text.
  ['a specifier written with a string escape', `import '\\u0040anthropic-ai/claude-agent-sdk';`],
  ['a named re-export', `export { query } from '@anthropic-ai/claude-agent-sdk';`],
  ['a star re-export', `export * from '@anthropic-ai/claude-agent-sdk';`],
  ['a namespaced re-export', `export * as sdk from '@anthropic-ai/claude-agent-sdk';`],
  ['a subpath import', `import { x } from '@anthropic-ai/claude-agent-sdk/bridge';`],
  ['a dynamic import', `const m = import('@anthropic-ai/claude-agent-sdk');`],
  ['a CommonJS require', `const m = require('@anthropic-ai/claude-agent-sdk');`],
  ['a require.resolve', `const p = require.resolve('@anthropic-ai/claude-agent-sdk');`],
  ['an import.meta.resolve', `const p = import.meta.resolve('@anthropic-ai/claude-agent-sdk');`],
  ['a type position import', `type O = import('@anthropic-ai/claude-agent-sdk').Options;`],
  ['an import-equals', `import sdk = require('@anthropic-ai/claude-agent-sdk');`],
  // The parser lifts triple-slash directives off the token stream onto the source file, so a walk
  // of the syntax tree alone never sees one.
  [
    'a reference-types directive',
    `/// <reference types="@anthropic-ai/claude-agent-sdk" />\nexport {};`,
  ],
  // The one step of value-tracking this gate does, so "put the string in a variable" is not the
  // next spelling.
  [
    'a specifier bound to a const and required through the name',
    `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require(spec);`,
  ],
  // The two decidable `createRequire` shapes: reported as an import, not as "cannot decide".
  [
    'a createRequire whose result resolves a literal',
    `const p = createRequire(u).resolve('@anthropic-ai/claude-agent-sdk');`,
  ],
  [
    'a createRequire called on a literal',
    `const m = createRequire(u)('@anthropic-ai/claude-agent-sdk');`,
  ],
];

export const REFUSED: readonly Sample[] = [
  ['a template specifier', 'const m = import(`${base}/claude-agent-sdk`);'],
  ['a variable specifier', `const m = import(name);`],
  ['a concatenated specifier', `const m = require('@anthropic-ai/' + pkg);`],
  ['a resolver bound to a name', `const req = createRequire(import.meta.url);`],
  ['a resolver called on a variable', `createRequire(import.meta.url).resolve(name);`],
  ['a resolver returned from a function', `const f = () => createRequire(u);`],
  ['a specifier assembled by eval', `const m = eval('req' + 'uire')('x');`],
  // `Function` without `new` builds the same thing as `new Function`; the AST reports both
  // callees identically, so one table entry covers them.
  ['a specifier assembled by Function', `const build = Function('s', 'return import(s)');`],
  ['a specifier assembled by new Function', `const build = new Function('s', 'return import(s)');`],
  ['a resolver reached through process.binding', `const m = process.binding('natives');`],
  // The four node module loaders a verifier proved past the version of this file that decided
  // which call sites to examine from tables of callee names. None is named anywhere in this
  // gate; the call-site tests assert that.
  [
    'a require off the CommonJS module object',
    `const m = module.require('@anthropic-ai/claude-agent-sdk');`,
  ],
  [
    'a require off require.main',
    `const m = require.main.require('@anthropic-ai/claude-agent-sdk');`,
  ],
  [
    'a require off process.mainModule',
    `const m = process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
  ],
  [
    'require rebound to a local name',
    `const load = require;\nconst m = load('@anthropic-ai/claude-agent-sdk');`,
  ],
  // Four this gate has never been shown, to make the point that the refusal is not a list.
  [
    'a loader reached through Reflect.apply with an array-literal argument',
    `const m = Reflect.apply(module.require, module, ['@anthropic-ai/claude-agent-sdk']);`,
  ],
  [
    "Module._load through require('node:module'), with the specifier in a const",
    `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require('node:module')._load(spec, module, false);`,
  ],
  [
    'a loader reached through globalThis',
    `const m = globalThis.process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
  ],
  [
    'a loader called through a comma expression, which is rooted at no name at all',
    `const m = (0, module.require)('@anthropic-ai/claude-agent-sdk');`,
  ],
];
