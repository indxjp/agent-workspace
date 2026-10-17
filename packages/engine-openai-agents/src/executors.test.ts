/**
 * The executors' path enforcement: our Editor, the read tools and the Shell (ENG-09, #308).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { normaliseGrants } from '@agent-workspace/engine';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyPatch,
  listWorkspaceFiles,
  readWorkspaceFile,
  runShell,
  searchWorkspaceFiles,
  type ApplyDiff,
} from './executors.js';
import { workspaceWriteAllowed, type OpenAiAgentsWorkspace } from './workspace.js';

/** A stand-in for the SDK's `applyDiff`: `+` lines become the file. Enough to test paths. */
const applyDiff: ApplyDiff = (_input, diff) =>
  diff
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .map((line) => `${line.slice(1)}\n`)
    .join('');

let root = '';
let outside = '';
afterEach(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
  if (outside !== '') rmSync(outside, { recursive: true, force: true });
  outside = '';
});

/**
 * A directory link. `junction` is what Windows grants without elevation and is ignored elsewhere;
 * Node's `lstat` reports both as a symbolic link, which is what the executors test.
 */
function linkDirectory(target: string, at: string): void {
  symlinkSync(path.resolve(target), at, 'junction');
}

function workspace(): OpenAiAgentsWorkspace {
  root = mkdtempSync(path.join(tmpdir(), 'openai-agents-exec-')).replaceAll('\\', '/');
  mkdirSync(path.join(root, 'docs'));
  writeFileSync(path.join(root, 'docs/spec.md'), 'spec\n');
  writeFileSync(path.join(root, 'notes.md'), 'find me\n');
  const grants = normaliseGrants(
    [{ kind: 'directory', path: 'docs', access: 'read' }],
    '.openai-agents',
  );
  if (!grants.ok) throw new Error('grants');
  return { cwd: root, grants: grants.grants, protectedDirectory: '.openai-agents' };
}

describe('the Editor', () => {
  it('writes outside every read-only grant, relative or absolute under cwd', async () => {
    const ws = workspace();
    expect(
      await applyPatch(ws, { type: 'create_file', path: 'out/a.md', diff: '+a' }, applyDiff),
    ).toBe('created out/a.md');
    expect(
      await applyPatch(
        ws,
        { type: 'update_file', path: `${ws.cwd}/notes.md`, diff: '+b' },
        applyDiff,
      ),
    ).toBe('updated notes.md');
    expect(readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('b\n');
  });

  it('refuses a read-only grant, the protected directory, an escape and a foreign absolute path', async () => {
    const ws = workspace();
    for (const target of [
      'docs/spec.md',
      'notes/../docs/spec.md',
      '.openai-agents/x',
      '../x',
      '/etc/passwd',
    ]) {
      const answer = await applyPatch(
        ws,
        { type: 'update_file', path: target, diff: '+x' },
        applyDiff,
      );
      expect(answer.startsWith('ERROR: '), target).toBe(true);
    }
    const moved = await applyPatch(
      ws,
      { type: 'update_file', path: 'notes.md', diff: '+x', moveTo: 'docs/notes.md' },
      applyDiff,
    );
    expect(moved.startsWith('ERROR: ')).toBe(true);
    expect(readFileSync(path.join(root, 'docs/spec.md'), 'utf8')).toBe('spec\n');
    expect(readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('find me\n');
    expect(workspaceWriteAllowed(ws, 'docs')).toBe(false);
    expect(workspaceWriteAllowed(ws, 'docs-private/a.md')).toBe(true);
  });
});

describe('a symbolic link on the path', () => {
  it('cannot alias a read-only grant: write, delete and move through it are refused', async () => {
    const ws = workspace();
    linkDirectory(path.join(root, 'docs'), path.join(root, 'alias'));
    const attempts = [
      { type: 'update_file', path: 'alias/spec.md', diff: '+x' },
      { type: 'delete_file', path: 'alias/spec.md' },
      { type: 'create_file', path: 'alias/new.md', diff: '+x' },
      { type: 'update_file', path: 'notes.md', diff: '+x', moveTo: 'alias/notes.md' },
    ] as const;
    for (const operation of attempts) {
      const answer = await applyPatch(ws, operation, applyDiff);
      expect(answer, JSON.stringify(operation)).toMatch(/^ERROR: .*"alias" is a symbolic link/u);
    }
    expect(readFileSync(path.join(root, 'docs/spec.md'), 'utf8')).toBe('spec\n');
    expect(existsSync(path.join(root, 'docs/new.md'))).toBe(false);
    expect(existsSync(path.join(root, 'docs/notes.md'))).toBe(false);
    expect(readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('find me\n');
  });

  it('cannot reach outside cwd: read, list and search through a link are refused', async () => {
    const ws = workspace();
    outside = mkdtempSync(path.join(tmpdir(), 'openai-agents-outside-'));
    writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
    linkDirectory(outside, path.join(root, 'escape'));
    const answers = [
      await readWorkspaceFile(ws, 'escape/secret.txt'),
      await listWorkspaceFiles(ws, 'escape'),
      await searchWorkspaceFiles(ws, 'escape', 'secret'),
    ];
    for (const answer of answers) {
      expect(answer).toMatch(/^ERROR: .*"escape" is a symbolic link/u);
      expect(answer).not.toContain('top secret');
    }
    // A search from the root skips the link rather than following it.
    expect(await searchWorkspaceFiles(ws, '.', 'secret')).toBe('no matches');
  });
});

describe('the read tools', () => {
  it('read, list and search inside the workspace and refuse outside it', async () => {
    const ws = workspace();
    expect(await readWorkspaceFile(ws, 'docs/spec.md')).toBe('spec\n');
    expect(await listWorkspaceFiles(ws, '.')).toBe('docs/\nnotes.md');
    expect(await searchWorkspaceFiles(ws, '.', 'find')).toBe('notes.md:1: find me');
    expect((await readWorkspaceFile(ws, '../secret')).startsWith('ERROR: ')).toBe(true);
    expect((await listWorkspaceFiles(ws, '/etc')).startsWith('ERROR: ')).toBe(true);
  });
});

describe('the Shell', () => {
  const env = {
    PATH: process.env['PATH'] ?? '',
    ...(process.env['SystemRoot'] === undefined ? {} : { SystemRoot: process.env['SystemRoot'] }),
  };

  it('runs in cwd and stops at the first failing command', async () => {
    const ws = workspace();
    const ok = await runShell(ws, env, {
      commands: ['node -e "process.stdout.write(process.cwd())"'],
    });
    expect(ok).toContain('[exit 0]');
    expect(ok.replaceAll('\\', '/').toLowerCase()).toContain(root.toLowerCase());
    const failed = await runShell(ws, env, {
      commands: ['node -e "process.exit(3)"', 'node -e "process.stdout.write(\'never\')"'],
    });
    expect(failed.startsWith('ERROR: ')).toBe(true);
    expect(failed).toContain('[exit 3]');
    expect(failed).not.toContain('never');
  });

  it('keeps at most the answer limit of a command that prints without end, and says so', async () => {
    const ws = workspace();
    const answer = await runShell(ws, env, {
      commands: ['node -e "process.stdout.write(\'x\'.repeat(300000))"'],
    });
    expect(answer).toContain(
      '[exit 0; truncated: 234464 more characters were printed and not kept]',
    );
    expect(answer.length).toBeLessThan(2 * 64 * 1024);
  });

  // POSIX only: there is no process group to kill on Windows, where only the shell is killed.
  it.skipIf(process.platform === 'win32')(
    'kills a whole pipeline on timeout, even one whose children hold the output open',
    async () => {
      const ws = workspace();
      const started = Date.now();
      const answer = await runShell(ws, env, { commands: ['sleep 30 | cat'], timeoutMs: 300 });
      expect(answer).toContain('[timeout]');
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers when the shell exits, though a background job it left would hold the output open',
    async () => {
      const ws = workspace();
      const started = Date.now();
      const answer = await runShell(ws, env, { commands: ['sleep 30 & echo started'] });
      expect(answer).toContain('[exit 0]');
      expect(answer).toContain('started');
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );
});
