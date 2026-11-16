import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = ['run.mjs', 'host.mjs', 'use-cases.mjs', 'scan-secrets.mjs'];

/**
 * The part of the `resolve` job that picks the commit whose docs, gallery and harness test a
 * published version: from `ref="$DEFAULT_REF"` to the step's outputs, as the workflow runs it.
 */
function harnessSelection(): string {
  const workflow = readFileSync(
    path.join(ROOT, '.github', 'workflows', 'install-live.yml'),
    'utf8',
  );
  const start = workflow.indexOf('          ref="$DEFAULT_REF"\n');
  const end = workflow.indexOf('          {\n            echo "version=$version"');
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return workflow
    .slice(start, end)
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n');
}

const GIT_ENV = {
  PATH: process.env['PATH'] ?? '',
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

/** A repository with one commit holding `files`; returns its directory and the commit. */
function repository(
  root: string,
  name: string,
  message: string,
  files: readonly string[],
): { dir: string; commit: string } {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet', '--initial-branch=main');
  // GitHub serves any reachable commit by its sha, as `git fetch origin <sha>` needs.
  git(dir, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  for (const file of files) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), `${file}\n`);
  }
  git(dir, 'add', '--all');
  git(dir, 'commit', '--quiet', '--allow-empty', '--message', message);
  return { dir, commit: git(dir, 'rev-parse', 'HEAD') };
}

describe('the install-live resolve job', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /**
   * The development repository holds the release commit (with the harness) and a later `main`;
   * the public repository holds a snapshot of the release commit. Returns what the job prints.
   */
  function resolve(options: {
    devTag?: boolean;
    publicTag?: boolean;
    sourceCommit?: (release: string) => string;
    releaseHasHarness?: boolean;
  }): { output: string; release: string; main: string } {
    const root = mkdtempSync(path.join(tmpdir(), 'install-live-resolve-'));
    roots.push(root);
    const dev = repository(
      root,
      'dev',
      'release: 1.2.3',
      options.releaseHasHarness === false
        ? ['README.md']
        : HARNESS.map((file) => `tests/docs-claims/${file}`),
    );
    const release = dev.commit;
    if (options.devTag === true) git(dev.dir, 'tag', 'packages-v1.2.3');
    git(dev.dir, 'commit', '--quiet', '--allow-empty', '--message', 'later work on main');
    const main = git(dev.dir, 'rev-parse', 'HEAD');
    const named = options.sourceCommit?.(release) ?? release;
    const snapshot = repository(
      root,
      'public',
      `Snapshot of source ${named} (#15)\n\nSource-Commit: ${named}\n`,
      ['README.md'],
    );
    if (options.publicTag !== false) git(snapshot.dir, 'tag', 'packages-v1.2.3');
    const runner = path.join(root, 'runner');
    mkdirSync(runner);
    git(runner, 'init', '--quiet');
    git(runner, 'remote', 'add', 'origin', `file://${dev.dir}`);
    const output = execFileSync(
      'bash',
      ['-c', `set -euo pipefail\n${harnessSelection()}\nprintf 'ref=%s\\n' "$ref"\n`],
      {
        cwd: runner,
        encoding: 'utf8',
        env: {
          ...GIT_ENV,
          version: '1.2.3',
          DEFAULT_REF: main,
          PUBLIC_REPOSITORY: `file://${snapshot.dir}`,
        },
      },
    );
    return { output, release, main };
  }

  it('tests a release tagged in the public repository with the commit its snapshot names', () => {
    const { output, release } = resolve({});
    expect(output).toContain(`is the snapshot of ${release}`);
    expect(output).toMatch(new RegExp(`^ref=${release}$`, 'mu'));
  });

  it('still takes a tag of this repository first', () => {
    const { output } = resolve({ devTag: true, publicTag: false });
    expect(output).toMatch(/^ref=packages-v1\.2\.3$/mu);
  });

  it('falls back to its own commit, with a notice, when no tag names the release', () => {
    const { output, main } = resolve({ publicTag: false });
    expect(output).toContain('is in neither this repository nor');
    expect(output).toMatch(new RegExp(`^ref=${main}$`, 'mu'));
  });

  it('falls back when the snapshot names a commit this repository does not have', () => {
    const missing = 'f'.repeat(40);
    const { output, main } = resolve({ sourceCommit: () => missing });
    expect(output).toContain(`names Source-Commit ${missing}, which is not in this repository`);
    expect(output).toMatch(new RegExp(`^ref=${main}$`, 'mu'));
  });

  it('falls back when the release commit predates the harness', () => {
    const { output, main } = resolve({ releaseHasHarness: false });
    expect(output).toContain('(it predates install-live)');
    expect(output).toMatch(new RegExp(`^ref=${main}$`, 'mu'));
  });
});
