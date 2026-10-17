import path from 'node:path';

import { build, type Metafile, type Plugin } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { assertNoForeignScope, classifyExternals, workspaceInliningPlugin } from './bundle.ts';
import { EmbeddedBuildError } from './errors.ts';
import { isOmittedFromWebDist } from './next-build.ts';

/** Stands in for the workspace member: resolves `@scope/member/*` to an empty virtual module. */
const virtualMember: Plugin = {
  name: 'virtual-member',
  setup(pluginBuild) {
    // esbuild compiles the filter as a Go regular expression, which has no `u` flag.
    pluginBuild.onResolve({ filter: /^@scope\/member/ }, (args) => ({
      path: args.path,
      namespace: 'virtual',
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
      contents: 'export default 1;',
      loader: 'js',
    }));
  },
};

describe('workspaceInliningPlugin', () => {
  it('inlines workspace members, keeps third-party packages and builtins external', async () => {
    const result = await build({
      stdin: {
        contents: [
          "import a from '@scope/member/sub';",
          "import b from 'third-party/sub';",
          "import c from '@vendor/lib';",
          "import { readFileSync } from 'node:fs';",
          'console.log(a, b, c, readFileSync);',
        ].join('\n'),
        loader: 'ts',
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      metafile: true,
      logLevel: 'silent',
      plugins: [workspaceInliningPlugin(new Set(['@scope/member'])), virtualMember],
    });
    const output = result.outputFiles[0]?.text ?? '';
    expect(output).toContain('from "third-party/sub"');
    expect(output).toContain('from "@vendor/lib"');
    expect(output).toContain('from "node:fs"');
    expect(output).toContain('var sub_default = 1;');
    expect(output).not.toContain('from "@scope/member');
  });
});

describe('assertNoForeignScope', () => {
  it('passes a bundle without the private scope', () => {
    expect(() => {
      assertNoForeignScope('dist/launch.js', 'const a = "@indx-workspace/cli";');
    }).not.toThrow();
  });

  it('fails the build, naming the file and line, when the scope appears', () => {
    expect(() => {
      assertNoForeignScope('dist/launch.js', 'a\nPACKAGE_NAME = "@agent-workspace/engine-pi";');
    }).toThrow(
      new EmbeddedBuildError(
        'foreign_scope_in_bundle',
        'dist/launch.js names @agent-workspace/* at line 2; an inlined member leaks its private ' +
          'package name into the published bundle',
      ),
    );
  });
});

describe('classifyExternals', () => {
  const metafile: Metafile = {
    inputs: {
      'src/launch.ts': {
        bytes: 1,
        imports: [
          { path: 'node:fs', kind: 'import-statement', external: true },
          { path: '../runner/dist/start.js', kind: 'dynamic-import' },
        ],
      },
      '../runner/dist/start.js': {
        bytes: 1,
        imports: [
          { path: 'next/dist/server/next.js', kind: 'import-statement', external: true },
          { path: '../runner/dist/engines.js', kind: 'import-statement' },
        ],
      },
      '../runner/dist/engines.js': {
        bytes: 1,
        imports: [{ path: '../engine-pi/dist/index.js', kind: 'dynamic-import' }],
      },
      '../engine-pi/dist/index.js': {
        bytes: 1,
        imports: [{ path: 'pi-agent', kind: 'import-statement', external: true }],
      },
      '../core/dist/kms.js': {
        bytes: 1,
        imports: [{ path: '@aws-sdk/client-kms', kind: 'dynamic-import', external: true }],
      },
      'src/embedded-db.ts': {
        bytes: 1,
        imports: [{ path: 'embedded-postgres', kind: 'dynamic-import', external: true }],
      },
    },
    outputs: {},
  };
  const root = path.resolve('/repo/packages/embedded');
  const { required, onDemand } = classifyExternals(metafile, 'src/launch.ts', root);

  it('requires what a start loads eagerly, and what the runtime defers in its own sources', () => {
    expect(required).toStrictEqual([
      { name: 'next', importer: path.resolve(root, '..', 'runner', 'dist', 'start.js') },
      { name: 'embedded-postgres', importer: path.join(root, 'src', 'embedded-db.ts') },
    ]);
  });

  it('leaves behind an import() of a member, or of the package itself, on demand', () => {
    expect(onDemand).toStrictEqual([
      { name: 'pi-agent', importer: path.resolve(root, '..', 'engine-pi', 'dist', 'index.js') },
      { name: '@aws-sdk/client-kms', importer: path.resolve(root, '..', 'core', 'dist', 'kms.js') },
    ]);
  });
});

describe('isOmittedFromWebDist', () => {
  it.each([
    'cache/webpack/x.pack',
    'types/routes.d.ts',
    'trace',
    'trace-build',
    'server/app/page.js.nft.json',
    'static/chunks/main.js.map',
  ])('leaves out %s', (relative) => {
    expect(isOmittedFromWebDist(relative)).toBe(true);
  });

  it.each(['', 'package.json', 'BUILD_ID', 'server/app/page.js', 'static/chunks/main.js'])(
    'keeps %j',
    (relative) => {
      expect(isOmittedFromWebDist(relative)).toBe(false);
    },
  );
});
