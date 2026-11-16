import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validatePackageExports } from '../../scripts/check-package-exports.mjs';
import { citationFailures } from '../../scripts/formal/generate.mjs';

const temporaryRoots: string[] = [];

async function packageFixture(importSpecifier = '@agent-workspace/library'): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-workspace-package-gate-'));
  temporaryRoots.push(root);
  await Promise.all(
    ['apps/consumer/src', 'packages/library/src', 'scripts', 'tests'].map((directory) =>
      mkdir(path.join(root, directory), { recursive: true }),
    ),
  );
  await writeFile(
    path.join(root, 'packages/library/package.json'),
    JSON.stringify({
      name: '@agent-workspace/library',
      type: 'module',
      main: './dist/index.js',
      types: './src/index.ts',
      exports: { '.': { types: './src/index.ts', default: './dist/index.js' } },
    }),
  );
  await writeFile(
    path.join(root, 'apps/consumer/package.json'),
    JSON.stringify({
      name: '@agent-workspace/consumer',
      type: 'module',
      exports: { '.': './src/index.ts' },
    }),
  );
  await writeFile(path.join(root, 'packages/library/src/index.ts'), 'export const value = 1;\n');
  await writeFile(
    path.join(root, 'apps/consumer/src/index.ts'),
    `import { value } from '${importSpecifier}';\nexport { value };\n`,
  );
  await writeFile(
    path.join(root, 'tsconfig.architecture.json'),
    JSON.stringify({
      compilerOptions: {
        paths: {
          '@agent-workspace/consumer': ['./apps/consumer/src/index.ts'],
          '@agent-workspace/library': ['./packages/library/src/index.ts'],
        },
      },
    }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('package export validator', () => {
  it('rejects imports through undeclared internal package subpaths', async () => {
    const root = await packageFixture('@agent-workspace/library/internal');
    const result = await validatePackageExports({ repositoryRoot: root, mode: 'source' });

    expect(result.errors).toContainEqual(
      expect.stringContaining('imports undeclared subpath @agent-workspace/library/internal'),
    );
  });

  it('allows source-backed declarations in fast mode but requires their built files in artifact mode', async () => {
    const root = await packageFixture();

    await expect(validatePackageExports({ repositoryRoot: root, mode: 'source' })).resolves.toEqual(
      { errors: [], workspaceCount: 2 },
    );
    const artifacts = await validatePackageExports({ repositoryRoot: root, mode: 'artifacts' });
    expect(artifacts.errors).toContainEqual(
      expect.stringContaining('is missing built artifact ./dist/index.js'),
    );
  });

  it('resolves a built CSS export to its source file before any build', async () => {
    const root = await packageFixture();
    const manifestPath = path.join(root, 'packages/library/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      exports: Record<string, unknown>;
    };
    manifest.exports['./styles.css'] = { default: './dist/styles.css' };
    await writeFile(manifestPath, JSON.stringify(manifest));
    const aliasPath = path.join(root, 'tsconfig.architecture.json');
    const aliases = JSON.parse(await readFile(aliasPath, 'utf8')) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    aliases.compilerOptions.paths['@agent-workspace/library/styles.css'] = [];
    await writeFile(aliasPath, JSON.stringify(aliases));

    const missing = await validatePackageExports({ repositoryRoot: root, mode: 'source' });
    expect(missing.errors).toContainEqual(
      expect.stringContaining('does not resolve to source: ./dist/styles.css'),
    );

    await writeFile(path.join(root, 'packages/library/src/styles.css'), 'a {}');
    const present = await validatePackageExports({ repositoryRoot: root, mode: 'source' });
    expect(present.errors).toEqual([]);
  });

  it('imports present JavaScript entrypoints and rejects a broken module graph', async () => {
    const root = await packageFixture();
    await mkdir(path.join(root, 'packages/library/dist'), { recursive: true });
    await writeFile(
      path.join(root, 'packages/library/dist/index.js'),
      "export { missing } from './missing.js';\n",
    );

    const result = await validatePackageExports({ repositoryRoot: root, mode: 'artifacts' });
    expect(result.errors).toContainEqual(expect.stringContaining('could not be imported'));
  });
});

describe('formal citation check', () => {
  const entry = (...ts: string[]) => [
    {
      name: 'Spec.thing',
      module: 'Spec',
      kind: 'theorem',
      tier: null,
      doc: [],
      ts,
      docstring: '',
      statement: '',
    },
  ];
  const failuresFor = (fragment: string, source: string, file = 'planted.ts') =>
    citationFailures(entry(`${file}#${fragment}`), () => source);

  it('rejects a symbol that only a comment, an import or a plain use mentions', () => {
    const message = 'symbol not declared in the file';
    expect(failuresFor('Thing', '// Thing\n/** Thing */\nexport const other = 1;\n')).toEqual([
      expect.stringContaining(message),
    ]);
    expect(failuresFor('Thing', "import { Thing } from './elsewhere';\n")).toEqual([
      expect.stringContaining(message),
    ]);
    expect(failuresFor('Thing', "import { Thing } from './elsewhere';\nuse(Thing);\n")).toEqual([
      expect.stringContaining(message),
    ]);
    expect(failuresFor('Thing', "export { Thing } from './elsewhere';\n")).toEqual([]);
  });

  it.each([
    ['an exported const', 'export const Thing = 1;'],
    ['a destructured const', 'const { a: [Thing] } = source;'],
    ['a function', 'function Thing() {}'],
    ['a class', 'class Thing {}'],
    ['a class member', 'class Box { Thing = 1; }'],
    ['an interface', 'interface Thing {}'],
    ['an interface member', 'interface Box { readonly Thing: string }'],
    ['a type alias', 'type Thing = string;'],
    ['a type literal member', 'type Box = { Thing(): void };'],
    ['an enum', 'enum Thing { A }'],
    ['an enum member', 'enum Box { Thing }'],
    ['a renamed export', 'const a = 1; export { a as Thing };'],
    ['an object literal property', 'export const wiring = { Thing: async () => 1 };'],
    [
      'a named database object',
      "const t = table(check('Thing', sql`1`));".replace('table(check', 'pgTable(check'),
    ],
  ])('accepts %s', (_label, source) => {
    expect(failuresFor('Thing', source)).toEqual([]);
  });

  it('resolves a non-identifier citation against a string literal and not a comment', () => {
    expect(failuresFor('runs wait', "program.command('runs wait');")).toEqual([]);
    expect(failuresFor('runs wait', '// runs wait\n')).toEqual([
      expect.stringContaining('symbol not declared in the file'),
    ]);
  });

  it('reads a data file as text', () => {
    expect(failuresFor('agents', 'ALTER TABLE agents ADD COLUMN x int;', 'planted.sql')).toEqual(
      [],
    );
  });

  it('resolves every citation of the committed catalogue', async () => {
    const catalogue = JSON.parse(
      await readFile(path.join(process.cwd(), 'formal/generated/catalogue.json'), 'utf8'),
    ) as { entries: Parameters<typeof citationFailures>[0] };

    expect(citationFailures(catalogue.entries)).toEqual([]);
  });
});
