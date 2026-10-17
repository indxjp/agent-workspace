import { describe, expect, it } from 'vitest';

import { EmbeddedBuildError } from './errors.ts';
import {
  checkEnginePackages,
  checkWorkspacePins,
  enginePackages,
  type InstalledPackage,
  onDemandOnly,
  type PackageResolver,
  resolveStagingDependencies,
  STAGED_FIELDS,
  stagingManifest,
} from './staging.ts';

/** A resolver over a fixed table: `<base>|<name>` → the package installed there. */
function resolverOf(table: Record<string, InstalledPackage>): PackageResolver {
  return (name, base) => table[`${base}|${name}`];
}

function installed(
  version: string,
  requiredPeers: readonly string[] = [],
  familyDependencies: readonly string[] = [],
): InstalledPackage {
  return {
    version,
    manifestPath: `/store/${version}/package.json`,
    requiredPeers,
    familyDependencies,
  };
}

const WORKSPACE_MANIFEST = {
  name: '@indx-workspace/embedded',
  version: '0.2.1',
  private: true,
  description: 'The local runtime.',
  license: 'Apache-2.0',
  homepage: 'https://example.test/embedded',
  repository: { type: 'git', url: 'git+https://example.test/repo.git', directory: 'x' },
  bugs: { url: 'https://example.test/issues' },
  keywords: ['agent-workspace', 'local-runtime'],
  engines: { node: '>=24' },
  type: 'module',
  exports: { './launch': './dist/bin.js', './package.json': './package.json' },
  bin: { 'agent-workspace-embedded': './dist/bin.js' },
  scripts: { build: 'node src/packaging/main.ts' },
  dependencies: { '@scope/core': 'workspace:*', pg: '8.23.0' },
  devDependencies: { esbuild: '0.28.2' },
  nx: { targets: {} },
};

describe('stagingManifest', () => {
  const manifest = stagingManifest(
    WORKSPACE_MANIFEST,
    new Map([['pg', '8.23.0']]),
    new Map([['@mastra/core', '1.74.0']]),
  );

  it('keeps the whitelisted fields, the dependencies, the optional peers and public access', () => {
    expect(Object.keys(manifest)).toStrictEqual([
      ...STAGED_FIELDS,
      'dependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'publishConfig',
    ]);
    expect(manifest['dependencies']).toStrictEqual({ pg: '8.23.0' });
    expect(manifest['peerDependencies']).toStrictEqual({ '@mastra/core': '1.74.0' });
    expect(manifest['peerDependenciesMeta']).toStrictEqual({ '@mastra/core': { optional: true } });
    expect(manifest['publishConfig']).toStrictEqual({ access: 'public' });
  });

  it('declares no peers when nothing loads on demand', () => {
    const plain = stagingManifest(WORKSPACE_MANIFEST, new Map([['pg', '8.23.0']]), new Map());
    expect(plain).not.toHaveProperty('peerDependencies');
    expect(plain).not.toHaveProperty('peerDependenciesMeta');
  });

  it('carries no private flag, scripts, devDependencies, nx block or workspace: specifier', () => {
    for (const field of ['private', 'scripts', 'devDependencies', 'nx']) {
      expect(manifest).not.toHaveProperty(field);
    }
    expect(JSON.stringify(manifest)).not.toContain('workspace:');
  });
});

describe('resolveStagingDependencies', () => {
  it('stages each external at its installed version, with its required peers, sorted', () => {
    const resolve = resolverOf({
      '/a.js|next': installed('16.3.6', ['react-dom', 'react']),
      '/store/16.3.6/package.json|react': installed('19.3.0'),
      '/store/16.3.6/package.json|react-dom': installed('19.3.0', ['react']),
      '/store/19.3.0/package.json|react': installed('19.3.0'),
      '/b.js|pg': installed('8.23.0'),
    });
    const staged = resolveStagingDependencies(
      [
        { name: 'pg', from: ['/b.js'] },
        { name: 'next', from: ['/a.js'] },
      ],
      resolve,
    );
    expect([...staged]).toStrictEqual([
      ['next', '16.3.6'],
      ['pg', '8.23.0'],
      ['react', '19.3.0'],
      ['react-dom', '19.3.0'],
    ]);
  });

  it('stages the same-scope dependencies of a pinned family, which npm would float', () => {
    const resolve = resolverOf({
      '/a.js|@earendil-works/pi': installed('1.0.2', [], ['@earendil-works/pi-codemode']),
      '/store/1.0.2/package.json|@earendil-works/pi-codemode': installed('1.0.2'),
    });
    const staged = resolveStagingDependencies(
      [{ name: '@earendil-works/pi', from: ['/a.js'] }],
      resolve,
    );
    expect([...staged]).toStrictEqual([
      ['@earendil-works/pi', '1.0.2'],
      ['@earendil-works/pi-codemode', '1.0.2'],
    ]);
  });

  it('tries each base in order', () => {
    const resolve = resolverOf({ '/next/package.json|styled-jsx': installed('5.1.6') });
    const staged = resolveStagingDependencies(
      [{ name: 'styled-jsx', from: ['/web/package.json', '/next/package.json'] }],
      resolve,
    );
    expect([...staged]).toStrictEqual([['styled-jsx', '5.1.6']]);
  });

  it('fails when two importers resolve one external to two versions', () => {
    const resolve = resolverOf({
      '/a.js|zod': installed('4.6.5'),
      '/b.js|zod': installed('3.25.0'),
    });
    expect(() =>
      resolveStagingDependencies(
        [
          { name: 'zod', from: ['/a.js'] },
          { name: 'zod', from: ['/b.js'] },
        ],
        resolve,
      ),
    ).toThrow(expect.objectContaining({ code: 'external_version_conflict' }));
  });

  it('fails when an external has no installed package.json', () => {
    expect(() =>
      resolveStagingDependencies([{ name: 'missing', from: ['/a.js'] }], resolverOf({})),
    ).toThrow(expect.objectContaining({ code: 'external_unresolved' }));
  });
});

describe('checkWorkspacePins', () => {
  const staged = new Map([
    ['next', '16.3.6'],
    ['pg', '8.23.0'],
  ]);

  it('accepts pins equal to the staged versions, next to workspace members', () => {
    expect(() =>
      checkWorkspacePins(staged, { '@scope/core': 'workspace:*', next: '16.3.6', pg: '8.23.0' }),
    ).not.toThrow();
  });

  it('fails when a staged external is not pinned', () => {
    expect(() => checkWorkspacePins(staged, { next: '16.3.6' })).toThrow(
      expect.objectContaining({ code: 'external_not_pinned' }),
    );
  });

  it('fails when a pin differs from the installed version, a range included', () => {
    expect(() => checkWorkspacePins(staged, { next: '16.3.5', pg: '8.23.0' })).toThrow(
      expect.objectContaining({ code: 'external_pin_mismatch' }),
    );
    expect(() => checkWorkspacePins(staged, { next: '^16.3.6', pg: '8.23.0' })).toThrow(
      expect.objectContaining({ code: 'external_pin_mismatch' }),
    );
  });

  it('fails when a third-party pin is not staged', () => {
    expect(() =>
      checkWorkspacePins(staged, { next: '16.3.6', pg: '8.23.0', 'left-pad': '1.3.0' }),
    ).toThrow(expect.objectContaining({ code: 'pin_not_imported' }));
  });
});

describe('onDemandOnly', () => {
  it('drops what every start already installs, and keeps the rest', () => {
    const only = onDemandOnly(
      new Map([['zod', '4.6.5']]),
      new Map([
        ['zod', '4.6.5'],
        ['@mastra/core', '1.74.0'],
      ]),
    );
    expect([...only]).toStrictEqual([['@mastra/core', '1.74.0']]);
  });

  it('refuses one name at two versions', () => {
    expect(() => onDemandOnly(new Map([['zod', '4.6.5']]), new Map([['zod', '4.0.0']]))).toThrow(
      new EmbeddedBuildError(
        'external_version_conflict',
        'zod is required at 4.6.5 but an on-demand import resolves it to 4.0.0',
      ),
    );
  });
});

describe('enginePackages', () => {
  it('groups the on-demand imports of each engine adapter, with their peers, less the required', () => {
    const resolve = resolverOf({
      '/repo/packages/engine-pi/dist/boundary.js|pi-agent': installed('1.0.2', ['zod', 'pi-tui']),
      '/store/1.0.2/package.json|zod': installed('4.6.5'),
      '/store/1.0.2/package.json|pi-tui': installed('1.0.2'),
      '/repo/packages/engine-mastra/dist/boundary.js|@mastra/core': installed('1.74.0'),
      '/repo/packages/core/dist/kms.js|@aws-sdk/client-kms': installed('3.1145.0'),
    });
    const groups = enginePackages(
      [
        { name: 'pi-agent', from: ['/repo/packages/engine-pi/dist/boundary.js'] },
        { name: '@mastra/core', from: ['/repo/packages/engine-mastra/dist/boundary.js'] },
        { name: '@aws-sdk/client-kms', from: ['/repo/packages/core/dist/kms.js'] },
      ],
      new Map([['zod', '4.6.5']]),
      resolve,
    );
    expect([...groups].map(([engine, packages]) => [engine, [...packages]])).toStrictEqual([
      ['mastra', [['@mastra/core', '1.74.0']]],
      [
        'pi',
        [
          ['pi-agent', '1.0.2'],
          ['pi-tui', '1.0.2'],
        ],
      ],
    ]);
  });
});

describe('checkEnginePackages', () => {
  const bundled = new Map([['pi', new Map([['pi-agent', '1.0.2']])]]);

  it('passes a table that names the same packages at the same versions, in any order', () => {
    expect(() => {
      checkEnginePackages(bundled, { pi: { 'pi-agent': '1.0.2' } });
    }).not.toThrow();
  });

  it.each([
    { pi: { 'pi-agent': '1.0.1' } },
    { pi: {} },
    { pi: { 'pi-agent': '1.0.2' }, mastra: {} },
  ])('fails on the drifted table %j, printing the table to paste', (declared) => {
    expect(() => {
      checkEnginePackages(bundled, declared);
    }).toThrow('engine adapters load; it must be:\n{\n  "pi": {\n    "pi-agent": "1.0.2"\n  }\n}');
  });
});
