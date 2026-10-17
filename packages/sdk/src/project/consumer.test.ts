import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  SETUP_THEMES,
  withRecommendedAnswers,
  type SetupAnswers,
} from '@indx-workspace/contracts/setup';

import { renderProjectFiles } from './render.js';

/**
 * The repository root as a filesystem path, from this file's URL. The SDK is isomorphic and has no
 * Node types, so `node:url` is not available: the pathname is decoded by hand, and on Windows the
 * `/` before the drive letter is dropped.
 */
function repositoryRoot(): string {
  const pathname = decodeURIComponent(new URL('../../../../', import.meta.url).pathname);
  return /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
}

/**
 * The strictest options a project might compile its definitions with. The consumer sits under
 * `packages/sdk`, so `@indx-workspace/sdk/define` resolves by package self-reference through the
 * `exports` map, as it does for a project that installed the package.
 */
const CONSUMER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

/** Type-checks `files` (relative to the repository root) as one program held in memory. */
function diagnosticsFor(
  files: Readonly<Record<string, string>>,
  options: ts.CompilerOptions = CONSUMER_OPTIONS,
): readonly string[] {
  const root = repositoryRoot();
  const virtual = new Map(
    Object.entries(files).map(([path, contents]) => [`${root}${path}`, contents] as const),
  );
  const host = ts.createCompilerHost(options, true);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => virtual.has(fileName) || fileExists(fileName);
  // A virtual file's directory exists too, so `../tools/orders` resolves to one.
  host.directoryExists = (directory) =>
    [...virtual.keys()].some((fileName) => fileName.startsWith(`${directory}/`)) ||
    ts.sys.directoryExists(directory);
  host.readFile = (fileName) => virtual.get(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const contents = virtual.get(fileName);
    return contents === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(fileName, contents, languageVersion, true);
  };
  const program = ts.createProgram([...virtual.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
}

/**
 * The definition files rendered from `answers`, placed in a consumer directory under
 * `packages/sdk`, in a subdirectory `directory` of it.
 */
function consumerFiles(
  edit: (contents: string) => string = (contents) => contents,
  answers: SetupAnswers = {},
  directory = '',
) {
  const files = renderProjectFiles(withRecommendedAnswers(answers), {
    name: 'my-project',
    version: '0.4.0',
  });
  return Object.fromEntries(
    files
      // A starter's fake API and run files are plain Node: `starters/tsconfig.json` checks them.
      .filter((file) => file.path.endsWith('.ts') && !/^fake-api\/|\.run\.ts$/u.test(file.path))
      .map(
        (file) =>
          [`packages/sdk/__consumer__/${directory}${file.path}`, edit(file.contents)] as const,
      ),
  );
}

/**
 * The options for a project whose agent imports its tools extensionless (SD12): NodeNext refuses
 * `../tools/orders`, which ADR-0111's linker resolves, so these resolve as a bundler does.
 */
const BUNDLER_OPTIONS: ts.CompilerOptions = {
  ...CONSUMER_OPTIONS,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

describe('the rendered definitions in a strict consumer', () => {
  it('type-check with no diagnostic', { timeout: 120_000 }, () => {
    expect(diagnosticsFor(consumerFiles())).toStrictEqual([]);
  });

  it('type-check for every theme with no diagnostic', { timeout: 120_000 }, () => {
    const files = SETUP_THEMES.map((theme) =>
      consumerFiles(undefined, { 'setup.theme': theme }, `${theme}/`),
    );
    // Bundler resolution: a starter's agent imports its tools extensionless (SD12).
    expect(
      diagnosticsFor(
        Object.fromEntries(files.flatMap((each) => Object.entries(each))),
        BUNDLER_OPTIONS,
      ),
    ).toStrictEqual([]);
  });

  it('type-check with the OpenAPI and PostgreSQL tools', { timeout: 120_000 }, () => {
    const answers = {
      'content.internalTools': ['openapi', 'postgres'],
      'content.openapiDocument': 'apis/orders.openapi.json',
      'content.permissions': ['readFiles'],
    } as const satisfies SetupAnswers;
    expect(diagnosticsFor(consumerFiles(undefined, answers), BUNDLER_OPTIONS)).toStrictEqual([]);
  });

  it(
    'would report a misspelled property, so the check above can fail',
    { timeout: 120_000 },
    () => {
      const diagnostics = diagnosticsFor(
        consumerFiles((contents) => contents.replace('colour:', 'colour2:')),
      );
      expect(diagnostics.length).toBeGreaterThan(0);
    },
  );
});
