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

  // EVL-04: a model or a tool can echo any credential shape, not only the Anthropic one. Each is
  // built from parts so this file holds no key-shaped text itself.
  it.each([
    ['OpenAI', ['sk', 'proj', 'AbCdEfGh1234567890abcdefGH'].join('-')],
    ['OpenAI legacy', ['sk', 'AbCdEfGh1234567890abcdefGHIJ'].join('-')],
    ['Google', ['AI', 'zaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'].join('')],
    ['AWS', ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join('')],
    ['Slack', ['xo', 'xb-1234567890-abcdefghij'].join('')],
    ['GitHub', ['gh', 'p_', 'a'.repeat(36)].join('')],
    ['GitHub fine-grained', ['github', 'pat', 'A'.repeat(24)].join('_')],
    ['API key', ['ak', 'live', 'AbCdEfGh12345678_secret'].join('_')],
    ['Console token', ['awt', 'live', 'AbCdEfGh12345678'].join('_')],
    ['session cookie', ['aw_session', '=abcDEF0123456789.signedtoken'].join('')],
    ['bearer', `Authorization: ${['Bear', 'er'].join('')} abcdefghijklmnopqrstuvwxyz012345`],
    ['JWT', ['eyJhbGciOiJIUzI1', 'eyJzdWIiOiIxMjM0NTY3', 'SflKxwRJSMeKKF2QT4fw'].join('.')],
    ['private key', ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ')],
  ])('finds a %s credential', (_name, text) => {
    expect(keyLines(`fine\n${text}\nfine`)).toEqual([2]);
  });

  it('passes prose and placeholders that merely look close', () => {
    for (const text of [
      'ask-the-owner-before-saving-anything-at-all',
      'a risk-assessment-for-the-whole-programme-plan',
      'Authorization: Bearer <token>',
      'send the bearer token in the header',
      'ak_live_...',
      'AKIA...',
      'ghp_...',
      '-----BEGIN CERTIFICATE-----',
    ]) {
      expect(keyLines(text), text).toEqual([]);
    }
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
