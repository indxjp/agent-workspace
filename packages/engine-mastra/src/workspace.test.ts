/**
 * The filesystem wrapper's two questions — on the path a tool named (`./workspace.ts`) and on the
 * path the kernel will open (`./guard.ts`) — against real directories and links (ENG-10, #309).
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normaliseGrants } from '@agent-workspace/engine';
import { afterAll, describe, expect, it } from 'vitest';

import { mastraResolvedWriteVerdict } from './guard.js';
import {
  mastraRelativeWriteVerdict,
  mastraRemoveAllowed,
  mastraWorkspacePath,
  mastraWriteAllowed,
  mastraWriteVerdict,
  type MastraWorkspace,
} from './workspace.js';

function workspaceAt(cwd: string): MastraWorkspace {
  const grants = normaliseGrants(
    [
      { kind: 'file', path: 'contracts/signed.pdf', access: 'read' },
      { kind: 'directory', path: 'reference', access: 'read' },
      { kind: 'file', path: 'notes.md', access: 'read-write' },
    ],
    '.mastra',
  );
  if (!grants.ok) throw new Error(grants.reason);
  return { cwd, grants: grants.grants, protectedDirectory: '.mastra' };
}

const LEXICAL = workspaceAt('/workspace/tenant');

describe('mastraRemoveVerdict: removing or moving a path takes its subtree', () => {
  it('refuses a path that holds a read-only grant, however spelled, and allows its siblings', () => {
    for (const input of [
      'contracts',
      './contracts/',
      '/workspace/tenant/contracts',
      'drafts/../contracts',
      'reference',
      'contracts/signed.pdf',
    ]) {
      expect(mastraRemoveAllowed(LEXICAL, input), input).toBe(false);
    }
    for (const input of [
      'drafts',
      'notes.md',
      'contracts-old',
      'reference-copy',
      'contracts/other.pdf',
    ]) {
      expect(mastraRemoveAllowed(LEXICAL, input), input).toBe(true);
    }
  });

  it('refuses the root and the adapter directory, which hold everything and the configuration', () => {
    expect(mastraRemoveAllowed(LEXICAL, '.')).toBe(false);
    expect(mastraRemoveAllowed(LEXICAL, '.mastra')).toBe(false);
    const nested: MastraWorkspace = { ...LEXICAL, protectedDirectory: 'config' };
    expect(mastraRemoveAllowed(nested, 'config')).toBe(false);
  });
});

describe('mastraWorkspacePath / mastraWriteVerdict', () => {
  it.each([
    ['notes.md', 'notes.md'],
    ['./drafts/a.md', 'drafts/a.md'],
    ['/workspace/tenant/drafts/a.md', 'drafts/a.md'],
    ['/workspace/tenant', '.'],
    ['.', '.'],
  ])('resolves %j the way LocalFilesystem does', (input, relative) => {
    expect(mastraWorkspacePath(LEXICAL, input)).toEqual({ ok: true, relative });
  });

  it.each(['~/.ssh/id_rsa', '~', '/etc/passwd', '/workspace/tenant-other/x', '../escape.md'])(
    'refuses %j, which names a file outside the workspace',
    (input) => {
      expect(mastraWorkspacePath(LEXICAL, input).ok).toBe(false);
    },
  );

  it('allows a write outside every read-only grant, and refuses one inside, however spelled', () => {
    expect(mastraWriteAllowed(LEXICAL, 'notes.md')).toBe(true);
    expect(mastraWriteAllowed(LEXICAL, 'drafts/new.md')).toBe(true);
    for (const input of [
      'contracts/signed.pdf',
      './contracts/signed.pdf',
      '/workspace/tenant/contracts/signed.pdf',
      'drafts/../contracts/signed.pdf',
      'reference/deep/file.md',
      'reference',
      '.mastra/skills/x/SKILL.md',
      '.',
    ]) {
      expect(mastraWriteVerdict(LEXICAL, input), input).toMatchObject({ ok: false });
    }
  });
});

describe('the kit wording of the workspace refusals', () => {
  it('says the workspace root is not a file that can be written', () => {
    expect(mastraRelativeWriteVerdict(LEXICAL, '.')).toEqual({
      ok: false,
      reason: 'the workspace root itself is not a file that can be written.',
    });
  });
});

describe('mastraResolvedWriteVerdict', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): MastraWorkspace {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mastra-guard-')));
    roots.push(root);
    mkdirSync(path.join(root, 'contracts'));
    writeFileSync(path.join(root, 'contracts/signed.pdf'), 'signed');
    mkdirSync(path.join(root, 'drafts'));
    return workspaceAt(root);
  }

  it('allows a plain write and a write into a directory that does not exist yet', async () => {
    const workspace = fixture();
    await expect(mastraResolvedWriteVerdict(workspace, 'drafts/a.md')).resolves.toEqual({
      ok: true,
      relative: 'drafts/a.md',
    });
    await expect(mastraResolvedWriteVerdict(workspace, 'new/deep/a.md')).resolves.toMatchObject({
      ok: true,
    });
  });

  it('refuses a write through a link to a read-only file, and through a linked directory', async () => {
    const workspace = fixture();
    symlinkSync(
      path.join(workspace.cwd, 'contracts/signed.pdf'),
      path.join(workspace.cwd, 'drafts/link.pdf'),
    );
    symlinkSync(path.join(workspace.cwd, 'contracts'), path.join(workspace.cwd, 'drafts/dir'));
    expect(mastraWriteVerdict(workspace, 'drafts/link.pdf').ok).toBe(true);
    await expect(mastraResolvedWriteVerdict(workspace, 'drafts/link.pdf')).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      mastraResolvedWriteVerdict(workspace, 'drafts/dir/signed.pdf'),
    ).resolves.toMatchObject({
      ok: false,
    });
  });

  it('refuses a link out of the workspace and a dangling link', async () => {
    const workspace = fixture();
    symlinkSync(tmpdir(), path.join(workspace.cwd, 'out'));
    symlinkSync(path.join(workspace.cwd, 'nowhere/x'), path.join(workspace.cwd, 'dangling'));
    await expect(mastraResolvedWriteVerdict(workspace, 'out/x')).resolves.toMatchObject({
      ok: false,
      reason: '"out/x" resolves outside the workspace through a symbolic link.',
    });
    await expect(mastraResolvedWriteVerdict(workspace, 'dangling')).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining('link to nothing') as unknown,
    });
  });
});
