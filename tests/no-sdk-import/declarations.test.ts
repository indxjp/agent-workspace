import { describe, expect, it } from 'vitest';

import { ENGINE_SDK_BOUNDARIES, type EngineSdkBoundary } from './boundaries.js';
import { classifyEmitted, declarationLeaks, emitDeclarations } from './declarations.js';
import { sourceReachesSdk } from './reach.js';

/**
 * An `import` statement is not the only way a consumer ends up needing an SDK's declarations. A
 * boundary that imports its SDK privately and then puts `Options` on an exported return type has
 * moved the import site rather than removed it: `tsc --emitDeclarationOnly` writes that import
 * back into the emitted `.d.ts`, and every consumer needs the package to type-check. The source
 * scan cannot see this, because the boundary file's own `import` is allowed, so the emitted
 * declarations are read.
 *
 * ENG-04 (#303): once per row of {@link ENGINE_SDK_BOUNDARIES}, because "the SDK stops at the
 * boundary in the type system too" is a claim about each SDK, not about the first one.
 */
function expectDeclarationsNameNoSdk(row: EngineSdkBoundary): void {
  const emit = emitDeclarations(row);
  expect(
    emit.files.filter((file) => file.kind === 'unrecognised').map((file) => file.name),
    'files in the declaration emit that this gate does not know how to read, so it cannot say whether they carry an SDK type out of the boundary',
  ).toEqual([]);
  const declarations = emit.files.filter((file) => file.kind === 'declaration');
  const boundary = declarations.find((file) => file.name === row.declarationFile);

  // The gate ran: a declaration exists and carries the surface this test is about. An empty or
  // truncated emit would otherwise satisfy "contains no SDK specifier" vacuously.
  expect(
    boundary,
    `no ${row.declarationFile} was emitted, so this gate proved nothing. tsc said: ${emit.tscOutput}`,
  ).toBeDefined();
  for (const exported of row.exportedSurface) {
    expect(boundary?.text ?? '', `${row.declarationFile} does not declare ${exported}`).toContain(
      exported,
    );
  }

  // The detector is the one used on the source tree, and it must go red on a declaration that
  // does leak, so this test cannot pass because the walk stopped walking.
  const leaking = `import { type Options } from '${row.sdkPackage}';\nexport declare function f(): Options;\n`;
  expect(sourceReachesSdk(`${row.sourceRoot}/leak-control.d.ts`, leaking)).toBe(true);

  const { leaks, unreadable } = declarationLeaks(row, declarations);
  expect(
    unreadable,
    'references in the declaration emit this gate could not decide, so it cannot say whether they reach the SDK',
  ).toEqual([]);
  expect(
    leaks,
    'emitted declarations that name the SDK: an SDK type is on an exported signature, so every consumer of this module needs the package to type-check',
  ).toEqual([]);
}

describe('spec §42 — the SDK stops at the boundary in the type system too', () => {
  it('classifies every file a declaration emit can contain, and rejects the rest', () => {
    // `.d.mts` and `.d.cts` are declarations an `endsWith('.d.ts')` walk dropped in silence; a
    // `.tsbuildinfo` is the shape that must be reported rather than ignored.
    expect(classifyEmitted('claude.d.ts')).toBe('declaration');
    expect(classifyEmitted('claude.d.mts')).toBe('declaration');
    expect(classifyEmitted('claude.d.cts')).toBe('declaration');
    expect(classifyEmitted('claude.d.ts.map')).toBe('declaration-map');
    expect(classifyEmitted('claude.d.mts.map')).toBe('declaration-map');
    expect(classifyEmitted('tsconfig.tsbuildinfo')).toBe('unrecognised');
    expect(classifyEmitted('claude.js')).toBe('unrecognised');
  });

  it.each(ENGINE_SDK_BOUNDARIES)(
    'emits $engine declarations naming no SDK module',
    expectDeclarationsNameNoSdk,
    120_000,
  );
});
