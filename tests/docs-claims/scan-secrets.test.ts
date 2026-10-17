import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { findKeys, keyLines } from './scan-secrets.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-secrets.mjs');
// Built from parts so this file holds no key-shaped text itself.
const KEY = ['sk', 'ant', 'api03', 'AbCdEfGh1234'].join('-');

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function scratch(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'scan-secrets-'));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), text);
  }
  return directory;
}

describe('the key scan', () => {
  it('finds a key and the fake key of the journey, and passes the docs placeholder', () => {
    expect(keyLines(`a\nexport ANTHROPIC_API_KEY=${KEY}\nb`)).toEqual([2]);
    expect(keyLines(`${['sk', 'ant', 'e2e', 'fake', '0123456789abcdef'].join('-')}`)).toEqual([1]);
    expect(keyLines('export ANTHROPIC_API_KEY=sk-ant-...')).toEqual([]);
    expect(keyLines('the sk-ant- prefix')).toEqual([]);
  });

  it('walks nested directories and names file:line, never the key', () => {
    const directory = scratch({
      'logs/a.log': `fine\n${KEY}\n`,
      'logs/deep/b.json': '{"ok":true}',
      'summary.md': 'sk-ant-...',
    });
    expect(findKeys(directory)).toEqual([path.join(directory, 'logs', 'a.log:2')]);
    const run = spawnSync(process.execPath, [SCRIPT, directory], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('a.log:2');
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });

  it('exits 0 on a clean directory and 2 without one', () => {
    const clean = scratch({ 'a.txt': 'sk-ant-...' });
    expect(spawnSync(process.execPath, [SCRIPT, clean]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT, path.join(clean, 'missing.txt')]).status).toBe(0);
    expect(spawnSync(process.execPath, [SCRIPT]).status).toBe(2);
  });
});
