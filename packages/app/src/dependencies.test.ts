import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// ADR-0082 (amendment for issue #1500): the app kit is published, so it reaches Agent Workspace
// only through the published packages, and never a server package, a private
// `@agent-workspace/*` member or a vendor SDK. dependency-cruiser cannot hold this line (it
// excludes `node_modules`, which is where every npm entry point resolves), so the allowlist is a
// test over the manifest and over every import specifier in `src`. The manifest is checked as a
// subset: each later unit declares a dependency when it first imports it.
const ALLOWED_DEPENDENCIES = [
  '@indx-workspace/contracts',
  '@indx-workspace/react',
  '@indx-workspace/sdk',
  '@modelcontextprotocol/sdk',
  // The recipe runner's cron parser (issue #1513), the version apps/web schedules triggers with.
  'croner',
  'zod',
];
const ALLOWED_PEERS = ['drizzle-orm', 'next', 'pg', 'react'];
// `react-dom` renders the `./react` parts' markup in their tests (`renderToStaticMarkup`); a page
// that hydrates them brings its own, as a Next.js app does.
const TEST_ONLY_SPECIFIERS = ['fast-check', 'react-dom', 'vitest'];

const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"]+)['"]/gu;

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The bare specifiers `source` imports that the package may not depend on. */
function forbiddenImports(source: string, isTest: boolean): string[] {
  const allowed = [
    ...ALLOWED_DEPENDENCIES,
    ...ALLOWED_PEERS,
    ...(isTest ? TEST_ONLY_SPECIFIERS : []),
  ];
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
    // This file quotes forbidden imports as fixtures for the rule it tests.
    return /\.tsx?$/u.test(entry.name) && entry.name !== 'dependencies.test.ts' ? [path] : [];
  });
}

const isTestFile = (file: string): boolean => /\.test\.tsx?$/u.test(file);

describe('the npm dependency allowlist', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;

  it('declares only allowlisted runtime dependencies and peers, and nothing optional', () => {
    expect(
      Object.keys(manifest['dependencies'] ?? {}).filter(
        (name) => !ALLOWED_DEPENDENCIES.includes(name),
      ),
    ).toEqual([]);
    expect(
      Object.keys(manifest['peerDependencies'] ?? {}).filter(
        (name) => !ALLOWED_PEERS.includes(name),
      ),
    ).toEqual([]);
    expect(manifest['optionalDependencies']).toBeUndefined();
  });

  it('imports nothing outside the allowlist, and the test runner only from tests', () => {
    const offenders = sourceFiles(join(packageRoot, 'src')).flatMap((file) =>
      forbiddenImports(readFileSync(file, 'utf8'), isTestFile(file)).map(
        (specifier) => `${file.slice(packageRoot.length + 1)} imports ${specifier}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('flags a private workspace member, a server package, a vendor SDK and the test runner', () => {
    expect(forbiddenImports(`import { db } from '@agent-workspace/core';`, false)).toEqual([
      '@agent-workspace/core',
    ]);
    // A subpath outside core's database layer: core's database-reachability gate refuses any
    // string naming that layer, fixtures included.
    expect(
      forbiddenImports(`import type { Provider } from '@agent-workspace/gateway/providers';`, true),
    ).toEqual(['@agent-workspace/gateway/providers']);
    expect(forbiddenImports(`import Anthropic from '@anthropic-ai/sdk';`, false)).toEqual([
      '@anthropic-ai/sdk',
    ]);
    expect(forbiddenImports(`const cli = require('@indx-workspace/cli');`, false)).toEqual([
      '@indx-workspace/cli',
    ]);
    expect(forbiddenImports(`export * from '@indx-workspace/aw';`, false)).toEqual([
      '@indx-workspace/aw',
    ]);
    expect(forbiddenImports(`import 'vitest';`, false)).toEqual(['vitest']);
    expect(forbiddenImports(`import 'vitest';`, true)).toEqual([]);
  });

  it('allows the published packages, the peers, relative paths and node built-ins', () => {
    const source = [
      `import { a } from '@indx-workspace/contracts/identity-assertion';`,
      `import { b } from '@indx-workspace/sdk';`,
      `import { Chat } from '@indx-workspace/react';`,
      `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
      `import { z } from 'zod';`,
      `import { pgTable } from 'drizzle-orm/pg-core';`,
      `import { Pool } from 'pg';`,
      `import { NextResponse } from 'next/server';`,
      `import { jsx } from 'react/jsx-runtime';`,
      `import { c } from './c.js';`,
      `import { readFileSync } from 'node:fs';`,
    ].join('\n');
    expect(forbiddenImports(source, false)).toEqual([]);
  });
});
