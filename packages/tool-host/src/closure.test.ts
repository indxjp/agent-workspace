import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const PACKAGES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
}

/** The workspace packages by name: only these are walked, so the closure is this repository's own. */
const WORKSPACE = new Map<string, string>([
  ['@agent-workspace/tool-host', 'tool-host'],
  ['@indx-workspace/aw', 'aw'],
  ['@indx-workspace/contracts', 'contracts'],
  ['@indx-workspace/platforms', 'platforms'],
  ['@indx-workspace/sdk', 'sdk'],
]);

function manifest(directory: string): Manifest {
  return JSON.parse(
    readFileSync(path.join(PACKAGES, directory, 'package.json'), 'utf8'),
  ) as Manifest;
}

describe('the tool sandbox image (ADR-0118 TS9)', () => {
  it('never reaches the database layer, through any workspace package it depends on', () => {
    const seen = new Set<string>();
    const walk = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      if (!/^@(?:agent|indx)-workspace\//u.test(name)) return;
      const directory = WORKSPACE.get(name);
      // A workspace dependency this test does not know is a new edge: it must be named above.
      expect(directory, name).toBeDefined();
      if (directory === undefined) return;
      for (const dependency of Object.keys(manifest(directory).dependencies ?? {})) {
        walk(dependency);
      }
    };
    walk('@agent-workspace/tool-host');
    expect([...seen]).not.toContain('@agent-workspace/core');
    expect([...seen].filter((name) => name.startsWith('@agent-workspace/'))).toEqual([
      '@agent-workspace/tool-host',
    ]);
  });
});
