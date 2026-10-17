import { describe, expect, it } from 'vitest';

import { NON_EXTERNAL_LOADS, packageNameOf, scanServerExternals } from './externals.ts';

describe('packageNameOf', () => {
  it.each([
    ['pg', 'pg'],
    ['next/dist/server/next.js', 'next'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/sub/path.js', '@scope/pkg'],
  ])('maps %s to %s', (specifier, name) => {
    expect(packageNameOf(specifier)).toBe(name);
  });

  it.each([
    './chunk.js',
    '../server/x.js',
    '/abs/path.js',
    'C:\\abs\\path.js',
    'node:fs',
    'fs',
    'fs/promises',
    'file:///x.js',
    '%s',
    '@scope',
    '',
  ])('names no package for %j', (specifier) => {
    expect(packageNameOf(specifier)).toBeUndefined();
  });
});

describe('scanServerExternals (webpack server chunks)', () => {
  it('reads every webpack external module, CommonJS and ESM, minified or not', () => {
    const chunks = [
      '1:a=>{"use strict";a.exports=require("next/dist/compiled/next-server/app-page.runtime.prod.js")}',
      '2:a=>{a.exports=import("pg")}',
      'module.exports = require("@scope/pkg/sub");',
    ];
    expect([...scanServerExternals(chunks)].sort()).toStrictEqual(['@scope/pkg', 'next', 'pg']);
  });

  it('drops builtins, node: builtins, relative and absolute paths', () => {
    const chunks = [
      'a.exports=require("node:fs")',
      'a.exports=require("crypto")',
      'a.exports=require("./chunks/1.js")',
      'a.exports=require("../webpack-runtime.js")',
      'a.exports=require("/abs/x.js")',
    ];
    expect([...scanServerExternals(chunks)]).toStrictEqual([]);
  });

  it('accepts a non-external load only when NON_EXTERNAL_LOADS explains it', () => {
    expect(NON_EXTERNAL_LOADS.has('encoding')).toBe(true);
    const chunks = ['try{d=require("encoding").convert}catch(a){}', 'a.exports=require("pg")'];
    expect([...scanServerExternals(chunks)]).toStrictEqual(['pg']);
  });

  it('fails on any other literal load outside a webpack external', () => {
    const chunks = ['const x = require("left-pad");', 'a.exports=require("pg")'];
    expect(() => scanServerExternals(chunks)).toThrow(
      expect.objectContaining({ code: 'unexplained_server_load' }),
    );
  });
});
