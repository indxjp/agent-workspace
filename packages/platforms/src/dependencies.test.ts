import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ADR-0133 D6: vendor SDKs never enter the translator package. dependency-cruiser cannot hold this
// line (it excludes `node_modules` and `dist`, which is where every npm entry point resolves), so
// the allowlist is a test over the manifest and over every import specifier in `src`.
const ALLOWED_DEPENDENCIES = ['@indx-workspace/contracts', 'yaml', 'zod'];
const TEST_ONLY_SPECIFIERS = ['fast-check', 'vitest'];

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/gu;

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The bare specifiers `source` imports that the package may not depend on. */
function forbiddenImports(source: string, isTest: boolean): string[] {
  const allowed = isTest
    ? [...ALLOWED_DEPENDENCIES, ...TEST_ONLY_SPECIFIERS]
    : ALLOWED_DEPENDENCIES;
  return [...source.matchAll(SPECIFIER)]
    .map((match) => match[1] ?? '')
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
    .filter((specifier) => !allowed.includes(packageName(specifier)));
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    // This file quotes vendor imports as fixtures for the rule it tests.
    return path.endsWith('.ts') && entry.name !== 'dependencies.test.ts' ? [path] : [];
  });
}

describe('the npm dependency allowlist', () => {
  it('declares nothing but contracts, zod and yaml as a runtime dependency', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(manifest['dependencies'] as object).sort()).toEqual(ALLOWED_DEPENDENCIES);
    expect(manifest['peerDependencies']).toBeUndefined();
    expect(manifest['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the allowlist, and the test runner only from tests', () => {
    const offenders = sourceFiles(join(packageRoot, 'src')).flatMap((file) =>
      forbiddenImports(readFileSync(file, 'utf8'), file.endsWith('.test.ts')).map(
        (specifier) => `${file.slice(packageRoot.length + 1)} imports ${specifier}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('flags a vendor SDK, a deep import of one and the test runner in production code', () => {
    expect(forbiddenImports(`import Anthropic from '@anthropic-ai/sdk';`, false)).toEqual([
      '@anthropic-ai/sdk',
    ]);
    expect(forbiddenImports(`import { x } from 'openai/resources';`, true)).toEqual([
      'openai/resources',
    ]);
    expect(forbiddenImports(`const sdk = require('@aws-sdk/client-s3');`, false)).toEqual([
      '@aws-sdk/client-s3',
    ]);
    expect(forbiddenImports(`import 'vitest';`, false)).toEqual(['vitest']);
    expect(forbiddenImports(`import 'vitest';`, true)).toEqual([]);
    expect(forbiddenImports(`import fc from 'fast-check';`, false)).toEqual(['fast-check']);
    expect(forbiddenImports(`import fc from 'fast-check';`, true)).toEqual([]);
  });

  it('allows contracts subpaths, zod, yaml, relative paths and node built-ins', () => {
    const source = [
      `import { a } from '@indx-workspace/contracts/platforms';`,
      `import { z } from 'zod';`,
      `import { parse } from 'yaml';`,
      `import { b } from './b.js';`,
      `import { readFileSync } from 'node:fs';`,
    ].join('\n');
    expect(forbiddenImports(source, false)).toEqual([]);
  });
});
