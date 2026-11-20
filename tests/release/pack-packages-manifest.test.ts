import { describe, expect, it } from 'vitest';

import { checkPackedManifest } from '../../scripts/release/pack-packages.mjs';

import { packed, packedEmbedded } from './pack-packages.test-support.js';

describe('the packed embedded manifest (ADR-0109)', () => {
  it('accepts the realistic packed embedded manifest the staging build writes', () => {
    expect(checkPackedManifest(packedEmbedded(), '0.1.0')).toEqual([]);
  });

  it('refuses a staging manifest that kept a workspace devDependency in the third-party scope', () => {
    expect(
      checkPackedManifest(
        packedEmbedded({ devDependencies: { '@agent-workspace/core': 'workspace:*' } }),
        '0.1.0',
      ),
    ).toEqual([
      '@indx-workspace/embedded names @agent-workspace/*, a scope a third party owns on npm',
    ]);
    expect(checkPackedManifest(packedEmbedded({ private: true }), '0.1.0')).toEqual([
      '@indx-workspace/embedded is private',
    ]);
  });

  it("accepts exactly embedded's package.json self-export outside dist/ (ADR-0109)", () => {
    const embedded = (exports: unknown) =>
      packed({
        name: '@indx-workspace/embedded',
        main: undefined,
        types: undefined,
        exports,
      });
    expect(
      checkPackedManifest(
        embedded({ './launch': './dist/bin.js', './package.json': './package.json' }),
        '0.1.0',
      ),
    ).toEqual([]);
    expect(checkPackedManifest(embedded({ './x': './package.json' }), '0.1.0')).toEqual([
      '@indx-workspace/embedded entry ./package.json is outside dist/',
    ]);
    expect(
      checkPackedManifest(embedded({ './package.json': './src/package.json' }), '0.1.0'),
    ).toEqual(['@indx-workspace/embedded entry ./src/package.json is outside dist/']);
    expect(
      checkPackedManifest(embedded({ './package.json': { default: './package.json' } }), '0.1.0'),
    ).toEqual(['@indx-workspace/embedded entry ./package.json is outside dist/']);
  });

  it('refuses an entry target that leaves dist/ through .. (regression, S1-12)', () => {
    expect(
      checkPackedManifest(
        packedEmbedded({
          exports: { './launch': './dist/../src/x.js', './package.json': './package.json' },
        }),
        '0.1.0',
      ),
    ).toEqual(['@indx-workspace/embedded entry ./dist/../src/x.js is outside dist/']);
    expect(
      checkPackedManifest(packedEmbedded({ bin: { x: './dist/../../etc' } }), '0.1.0'),
    ).toEqual(['@indx-workspace/embedded entry ./dist/../../etc is outside dist/']);
  });

  it('reports a dependency specifier that is not a string instead of crashing (regression, S1-12)', () => {
    expect(checkPackedManifest(packedEmbedded({ dependencies: { a: 1 } }), '0.1.0')).toEqual([
      '@indx-workspace/embedded dependencies.a is not a string specifier',
    ]);
  });
});

describe('the packed manifest of the other packages', () => {
  it('accepts a lock-step manifest in the owned scope', () => {
    expect(checkPackedManifest(packed(), '0.1.0')).toEqual([]);
  });

  it('refuses the third-party scope anywhere in the manifest', () => {
    expect(checkPackedManifest(packed({ name: '@agent-workspace/sdk' }), '0.1.0')).toHaveLength(2);
    expect(
      checkPackedManifest(
        packed({ dependencies: { '@agent-workspace/contracts': '0.1.0' } }),
        '0.1.0',
      ),
    ).toHaveLength(1);
  });

  it('refuses a workspace specifier, a sibling off lock-step, and a version off the contracts', () => {
    const failures = [
      ...checkPackedManifest(packed({ dependencies: { zod: 'workspace:*' } }), '0.1.0'),
      ...checkPackedManifest(
        packed({ dependencies: { '@indx-workspace/contracts': '^0.1.0' } }),
        '0.1.0',
      ),
      ...checkPackedManifest(packed({ version: '0.2.0' }), '0.1.0'),
    ];
    expect(failures).toHaveLength(3);
  });

  it('refuses a private manifest, a missing repository, and an entry outside dist/', () => {
    expect(checkPackedManifest(packed({ private: true }), '0.1.0')).toHaveLength(1);
    expect(checkPackedManifest(packed({ repository: undefined }), '0.1.0')).toHaveLength(1);
    expect(
      checkPackedManifest(packed({ exports: { '.': { types: './src/index.ts' } } }), '0.1.0'),
    ).toHaveLength(1);
    expect(checkPackedManifest(packed({ bin: { aw: './bin/aw.js' } }), '0.1.0')).toHaveLength(1);
  });

  it('keeps the dist-only rule for the self-export of every other package', () => {
    expect(
      checkPackedManifest(packed({ exports: { './package.json': './package.json' } }), '0.1.0'),
    ).toEqual(['@indx-workspace/sdk entry ./package.json is outside dist/']);
  });
});
