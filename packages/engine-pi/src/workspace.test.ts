/**
 * The tool guard: the path the model named (`./workspace.ts`) and the path the kernel will open
 * (`./guard.ts`) — `..`, absolute paths, pi's rewritten spellings and symbolic links (ENG-08, #307).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { normaliseGrants } from '@agent-workspace/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolvedPathVerdict } from './guard.js';
import { piPlanAllowsPermission, piToolPlan } from './tools.js';
import { piToolCallVerdict, workspaceWriteAllowed, type PiWorkspace } from './workspace.js';

const GRANTS = normaliseGrants(
  [
    { kind: 'file', path: 'contract.pdf', access: 'read' },
    { kind: 'directory', path: 'docs', access: 'read' },
    { kind: 'file', path: 'draft.md', access: 'read-write' },
  ],
  '.pi',
);
if (!GRANTS.ok) throw new Error(GRANTS.reason);

const WORKSPACE: PiWorkspace = {
  cwd: '/workspace/t',
  grants: GRANTS.grants,
  protectedDirectory: '.pi',
};

describe('piToolPlan', () => {
  it('maps each switch to its tools and withholds bash under a read-only grant', () => {
    const all = {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: false,
    };
    expect(piToolPlan(all, false)).toEqual({
      tools: ['read', 'write', 'edit', 'bash'],
      networkEgress: false,
    });
    expect(piToolPlan(all, true).tools).toEqual(['read', 'write', 'edit']);
    expect(piToolPlan({ ...all, writeFiles: false }, false).tools).toEqual(['read', 'bash']);
    const plan = piToolPlan({ ...all, runCommands: false, unrestrictedNetwork: true }, false);
    expect(piPlanAllowsPermission(plan, 'runCommands')).toBe(false);
    expect(piPlanAllowsPermission(plan, 'unrestrictedNetwork')).toBe(true);
  });
});

describe('piToolCallVerdict', () => {
  const offered = ['read', 'write', 'edit'] as const;

  it('blocks every tool the plan does not offer, bash included', () => {
    for (const tool of ['bash', 'grep', 'mcp__x__y']) {
      expect(piToolCallVerdict(WORKSPACE, offered, tool, { command: 'ls' })).toMatchObject({
        allow: false,
      });
    }
    expect(piToolCallVerdict(WORKSPACE, [...offered, 'bash'], 'bash', { command: 'ls' })).toEqual({
      allow: true,
      path: null,
      writes: false,
    });
  });

  it('lets a read inside the workspace through, and nothing outside it', () => {
    expect(piToolCallVerdict(WORKSPACE, offered, 'read', { path: 'contract.pdf' })).toMatchObject({
      allow: true,
    });
    expect(
      piToolCallVerdict(WORKSPACE, offered, 'read', { path: '/workspace/t/docs/a.md' }),
    ).toMatchObject({
      allow: true,
      path: 'docs/a.md',
    });
    for (const outside of ['/etc/passwd', '../other/x', '~/secrets', '@/etc/passwd', 'a b']) {
      expect(piToolCallVerdict(WORKSPACE, offered, 'read', { path: outside })).toMatchObject({
        allow: false,
      });
    }
    expect(piToolCallVerdict(WORKSPACE, offered, 'read', {})).toMatchObject({ allow: false });
  });

  it('blocks a write into a read-only grant, however it is spelled', () => {
    for (const target of [
      'contract.pdf',
      './contract.pdf',
      'notes/../contract.pdf',
      '/workspace/t/contract.pdf',
      'docs/sub/a.md',
      '.pi/skills/x/SKILL.md',
      '.pi',
    ]) {
      expect(piToolCallVerdict(WORKSPACE, offered, 'write', { path: target })).toMatchObject({
        allow: false,
      });
      expect(workspaceWriteAllowed(WORKSPACE, target)).toBe(false);
    }
    expect(piToolCallVerdict(WORKSPACE, offered, 'edit', { path: 'draft.md' })).toMatchObject({
      allow: true,
      writes: true,
    });
  });
});

describe('resolvedPathVerdict', () => {
  let cwd: string;
  let workspace: PiWorkspace;

  beforeAll(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'engine-pi-guard-'));
    cwd = path.join(root, 'ws');
    mkdirSync(path.join(cwd, 'notes'), { recursive: true });
    mkdirSync(path.join(root, 'outside'));
    writeFileSync(path.join(cwd, 'contract.pdf'), 'x');
    symlinkSync('../contract.pdf', path.join(cwd, 'notes', 'alias.pdf'));
    symlinkSync('../outside', path.join(cwd, 'escape'));
    symlinkSync('nowhere/at-all', path.join(cwd, 'dangling'));
    workspace = { ...WORKSPACE, cwd };
  });

  afterAll(() => {
    rmSync(path.dirname(cwd), { recursive: true, force: true });
  });

  it('follows a link into a read-only grant and blocks the write', async () => {
    expect(await resolvedPathVerdict(workspace, 'notes/alias.pdf', true)).toMatchObject({
      ok: false,
    });
    // Reading through the same link is a read of a readable file.
    expect(await resolvedPathVerdict(workspace, 'notes/alias.pdf', false)).toEqual({
      ok: true,
      relative: 'contract.pdf',
    });
  });

  it('blocks a path a link carries outside the workspace, for a read and a write', async () => {
    expect(await resolvedPathVerdict(workspace, 'escape/new.md', true)).toMatchObject({
      ok: false,
    });
    expect(await resolvedPathVerdict(workspace, 'escape/new.md', false)).toMatchObject({
      ok: false,
    });
  });

  it('blocks a write through a dangling link', async () => {
    expect(await resolvedPathVerdict(workspace, 'dangling', true)).toMatchObject({ ok: false });
  });

  it('lets a new file in an ordinary directory through', async () => {
    expect(await resolvedPathVerdict(workspace, 'notes/new/deep.md', true)).toEqual({
      ok: true,
      relative: 'notes/new/deep.md',
    });
  });
});
