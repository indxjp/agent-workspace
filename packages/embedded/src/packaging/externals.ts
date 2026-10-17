import { readdir, readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { EmbeddedBuildError } from './errors.ts';

/** An npm package name, scoped or not (lowercase, as the registry requires of new names). */
const PACKAGE_NAME = /^(?:@[a-z\d~-][a-z\d._~-]*\/)?[a-z\d~-][a-z\d._~-]*$/u;

/**
 * The npm package a module specifier names: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`.
 * A relative or absolute path, a URL, a Node builtin (`node:fs`, `fs`) or a string that is no
 * package name (a `%s` placeholder) names no package.
 */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || path.isAbsolute(specifier)) {
    return undefined;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(specifier) || isBuiltin(specifier)) return undefined;
  const segments = specifier.split('/');
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
  return name !== undefined && PACKAGE_NAME.test(name) ? name : undefined;
}

/** A literal `require("x")` or `import("x")`. */
const LITERAL_LOAD = /\b(?:require|import)\(\s*(["'])([^"'\s]+)\1\s*\)/gu;

/**
 * The form webpack emits an external module in: the module's whole body is
 * `module.exports = require("x")` (CommonJS) or `module.exports = import("x")` (ESM), minified
 * to `a.exports=require("x")`.
 */
const EXTERNAL_MODULE = /\bexports\s*=\s*(?:require|import)\(\s*(["'])([^"'\s]+)\1\s*\)/gu;

const ERROR_MESSAGE_TEXT =
  'only the text of an @aws-sdk error message that tells the reader how to register it';

/**
 * Literal loads in the server chunks that are not webpack externals, each with the reason the
 * package need not be installed. Any other such load fails the build, so each new one is a
 * reviewed decision rather than a silent drop.
 */
export const NON_EXTERNAL_LOADS: ReadonlyMap<string, string> = new Map([
  [
    'encoding',
    'node-fetch, bundled into the chunks, requires it inside try/catch as an optional charset converter',
  ],
  ['@aws-sdk/signature-v4-crt', ERROR_MESSAGE_TEXT],
  ['@aws-sdk/signature-v4a', ERROR_MESSAGE_TEXT],
]);

function packagesMatching(sources: readonly string[], pattern: RegExp): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    for (const match of source.matchAll(pattern)) {
      const name = packageNameOf(match[2] ?? '');
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/**
 * The packages webpack server chunks load at run time: the package of every webpack external
 * module. Every other literal `require("x")` or `import("x")` of a package must be one of
 * `NON_EXTERNAL_LOADS`. Relative and absolute paths and builtins are dropped.
 */
export function scanServerExternals(sources: readonly string[]): ReadonlySet<string> {
  const externals = packagesMatching(sources, EXTERNAL_MODULE);
  const unexplained = [...packagesMatching(sources, LITERAL_LOAD)].filter(
    (name) => !externals.has(name) && !NON_EXTERNAL_LOADS.has(name),
  );
  if (unexplained.length > 0) {
    throw new EmbeddedBuildError(
      'unexplained_server_load',
      `the web server chunks load ${unexplained.join(', ')} outside a webpack external; ` +
        'decide whether each is an external (a dependency) or list it, with the reason, in ' +
        'NON_EXTERNAL_LOADS',
    );
  }
  return externals;
}

/** `scanServerExternals` over `<distDir>/server/**\/*.js` of a webpack Next build. */
export async function readWebpackServerExternals(
  nextDistDirectory: string,
): Promise<ReadonlySet<string>> {
  const entries = await readdir(path.join(nextDistDirectory, 'server'), {
    withFileTypes: true,
    recursive: true,
  });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(entry.parentPath, entry.name));
  return scanServerExternals(await Promise.all(files.map(async (file) => readFile(file, 'utf8'))));
}
