import { failureOf, AGENT_SOURCE, SURFACE_SOURCE } from './harness-fixtures.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { TOOL_OWNED_PATHS, assertUnchanged, diffTrees, snapshotTree } from './harness.mjs';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function demo(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'journey-harness-'));
  directories.push(directory);
  mkdirSync(path.join(directory, 'agents'));
  mkdirSync(path.join(directory, 'surfaces'));
  writeFileSync(path.join(directory, 'agent-workspace.yaml'), 'apiVersion: v2\n');
  writeFileSync(path.join(directory, 'agents', 'assistant.ts'), AGENT_SOURCE);
  writeFileSync(path.join(directory, 'surfaces', 'main.ts'), SURFACE_SOURCE);
  return directory;
}

it('lists a written, a changed and a removed file by path', () => {
  const directory = demo();
  const before = snapshotTree(directory);
  expect(Object.keys(before)).toEqual([
    'agent-workspace.yaml',
    'agents/assistant.ts',
    'surfaces/main.ts',
  ]);
  writeFileSync(path.join(directory, 'agents', 'helper.ts'), 'export {};\n');
  writeFileSync(
    path.join(directory, 'surfaces', 'main.ts'),
    SURFACE_SOURCE.replace('#2F5FD0', '#000000'),
  );
  rmSync(path.join(directory, 'agent-workspace.yaml'));
  const after = snapshotTree(directory);
  expect(diffTrees(before, after)).toEqual({
    added: ['agents/helper.ts'],
    changed: ['surfaces/main.ts'],
    removed: ['agent-workspace.yaml'],
  });
  expect(failureOf(() => assertUnchanged('demo', before, after)).message).toBe(
    [
      'demo/ changed after init:',
      '  added: agents/helper.ts',
      '  changed: surfaces/main.ts',
      '  removed: agent-workspace.yaml',
    ].join('\n'),
  );
});

it('ignores the tool-owned paths: node_modules/, package-lock.json, the runtime state and .aw/', () => {
  expect(TOOL_OWNED_PATHS).toEqual([
    'node_modules/',
    'package-lock.json',
    '.agent-workspace/',
    '.aw/',
  ]);
  const directory = demo();
  const before = snapshotTree(directory);
  mkdirSync(path.join(directory, 'node_modules', '@indx-workspace'), { recursive: true });
  writeFileSync(path.join(directory, 'node_modules', '@indx-workspace', 'x.js'), '');
  writeFileSync(path.join(directory, 'package-lock.json'), '{}\n');
  mkdirSync(path.join(directory, '.agent-workspace', 'pg'), { recursive: true });
  writeFileSync(path.join(directory, '.agent-workspace', 'pg', 'PG_VERSION'), '17\n');
  mkdirSync(path.join(directory, '.aw', 'logs'), { recursive: true });
  writeFileSync(path.join(directory, '.aw', 'logs', 'runtime.log'), 'started');
  expect(() => assertUnchanged('demo', before, snapshotTree(directory))).not.toThrow();
});

it('does not take a nested package-lock.json for the tool-owned one', () => {
  const directory = demo();
  const before = snapshotTree(directory);
  writeFileSync(path.join(directory, 'agents', 'package-lock.json'), '{}\n');
  expect(
    failureOf(() => assertUnchanged('demo', before, snapshotTree(directory))).message,
  ).toContain('  added: agents/package-lock.json');
});
