import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractRepositoryClaims } from './extract.mjs';
import { parseKnown, verdict } from './install-live-report.mjs';

const row = (result: string) => ({ where: 'page.mdx:1', what: 'npm install x', result });

describe('the install-live verdict', () => {
  it('passes when every lane ran and nothing failed or was skipped', () => {
    const { outcome, markdown } = verdict([
      { name: 'ubuntu', rows: [row('pass'), row('n/a (powershell only)')] },
    ]);
    expect(outcome).toBe('pass');
    expect(markdown).toContain('| ubuntu | 2 | 0 | 0 | 1 |');
  });

  it('reads a skipped row as skipped, never as a pass, and says why', () => {
    const { outcome, markdown } = verdict([
      {
        name: 'ubuntu',
        rows: [row('pass'), row('skipped: needs ANTHROPIC_API_KEY (not configured)')],
      },
    ]);
    expect(outcome).toBe('skipped');
    expect(markdown).toContain('It is not a pass.');
  });

  it('fails on a FAIL row, naming it, even when another lane is skipped', () => {
    const { outcome, markdown } = verdict([
      { name: 'windows', rows: [row('FAIL: a command did not exit 0')] },
      { name: 'ubuntu', rows: [row('skipped: needs ANTHROPIC_API_KEY (not configured)')] },
    ]);
    expect(outcome).toBe('fail');
    expect(markdown).toContain(
      '- windows: page.mdx:1 (npm install x): FAIL: a command did not exit 0',
    );
  });

  it('does not blame the key for rows skipped after a failure', () => {
    const { outcome, markdown } = verdict([
      {
        name: 'use-cases',
        rows: [row('FAIL: not what the use case promises'), row('skipped: an earlier step failed')],
      },
    ]);
    expect(outcome).toBe('fail');
    expect(markdown).toContain('| use-cases | 2 | 1 | 1 | 0 |');
    expect(markdown).not.toContain('ANTHROPIC_API_KEY');
  });

  it('fails when a lane left no results', () => {
    const { outcome, markdown } = verdict([
      { name: 'ubuntu', rows: [row('pass')] },
      { name: 'macos', rows: null },
    ]);
    expect(outcome).toBe('fail');
    expect(markdown).toContain('| macos | missing | | | |');
    expect(markdown).toContain('No results from: macos.');
  });

  it('digests the failure set, so the same failures in any order give the same digest', () => {
    const a = { name: 'macos', rows: [row('FAIL: one'), row('FAIL: two')] };
    const b = { name: 'macos', rows: [row('FAIL: two'), row('FAIL: one')] };
    expect(verdict([a]).digest).toBe(verdict([b]).digest);
    expect(verdict([a]).digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(verdict([{ name: 'macos', rows: [row('FAIL: one')] }]).digest).not.toBe(
      verdict([a]).digest,
    );
    expect(verdict([{ name: 'macos', rows: null }]).digest).not.toBe(
      verdict([{ name: 'macos', rows: [] }]).digest,
    );
  });

  it('shows a known failure with its issue, keeps the run red, and leaves it out of the digest', () => {
    const known = [{ lane: 'windows-pwsh', where: 'page.mdx:1', issue: 901 }];
    const lanes = [
      { name: 'windows-pwsh', rows: [row('FAIL: a command did not exit 0')] },
      { name: 'ubuntu', rows: [row('pass')] },
    ];
    const { outcome, markdown, digest } = verdict(lanes, known);
    expect(outcome).toBe('fail');
    expect(markdown).toContain(
      '- windows-pwsh: page.mdx:1 (npm install x): known failure (#901): FAIL: a command did not exit 0',
    );
    expect(digest).toBe(verdict([{ name: 'ubuntu', rows: [row('pass')] }]).digest);
    expect(verdict([{ name: 'macos', rows: lanes[0]?.rows ?? [] }], known).markdown).not.toContain(
      'known failure',
    );
  });

  it('names a known failure whose row passes as stale', () => {
    const { outcome, markdown } = verdict(
      [{ name: 'macos', rows: [row('pass')] }],
      [{ lane: 'macos', where: 'page.mdx:1', issue: 902 }],
    );
    expect(outcome).toBe('pass');
    expect(markdown).toContain('- stale known failure: macos: page.mdx:1 (#902) passes');
  });

  it('accepts the checked-in known list and rejects a malformed entry', () => {
    const file = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'install-live-known.json'),
      'utf8',
    );
    expect(() => parseKnown(JSON.parse(file))).not.toThrow();
    expect(parseKnown([{ lane: 'macos', where: 'a:1', issue: 3 }])).toEqual([
      { lane: 'macos', where: 'a:1', issue: 3 },
    ]);
    expect(() => parseKnown({})).toThrow(/array/u);
    expect(() => parseKnown([{ lane: 'macos', where: 'a:1', issue: '3' }])).toThrow();
    expect(() => parseKnown([{ lane: 'macos', where: 'a:1', issue: 3, os: 'x' }])).toThrow();
  });

  it('names only run claims that exist, so a line shift fails here and not on the lane', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const file = readFileSync(
      path.join(root, 'tests', 'docs-claims', 'install-live-known.json'),
      'utf8',
    );
    const claims = new Set(
      extractRepositoryClaims(root)
        .filter((claim) => claim.state === 'run')
        .map((claim) => `${claim.page}:${String(claim.line)}`),
    );
    for (const entry of parseKnown(JSON.parse(file)))
      expect(claims, entry.where).toContain(entry.where);
  });
});
