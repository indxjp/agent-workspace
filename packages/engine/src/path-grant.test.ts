/**
 * Path normalisation and file grants — the shared half of every adapter's grant enforcement.
 *
 * The cases here are the ones a path check is *usually* wrong about, and each is written as the
 * spelling an attacker would reach for rather than as the canonical form: `..` that climbs past
 * the root, `..` that climbs and comes back, a symlink target that is an absolute path, a
 * Windows drive letter reaching a Linux sandbox, and a prefix that looks like a directory name
 * and is not (`docs-private` against a grant on `docs`).
 *
 * `formal/AgentWorkspace/Authz/PathGrant.lean` models the same function and
 * `tests/formal/path-grant.test.ts` replays the Lean vectors against it, so these cases are the
 * hand-written ones and that suite is the exhaustive one. Both are wanted: a vector file says
 * what was proved, and this file says what somebody thought of.
 */
import { describe, expect, it } from 'vitest';

import {
  normaliseGrantPath,
  normaliseGrants,
  relativeSubtreeVerdict,
  relativeWriteVerdict,
  workspacePathVerdict,
  workspaceWriteVerdict,
  writeGrantVerdict,
  type EngineWorkspace,
} from './path-grant.js';

describe('normaliseGrantPath', () => {
  it('normalises the redundant spellings of one path to one answer', () => {
    for (const spelling of ['docs/spec.md', './docs/spec.md', 'docs//spec.md', 'docs/./spec.md']) {
      const verdict = normaliseGrantPath(spelling);
      expect(verdict.ok, spelling).toBe(true);
      expect(verdict.ok ? verdict.path : '').toBe('docs/spec.md');
    }
  });

  it('resolves `..` inside the root and refuses it at the root', () => {
    const inside = normaliseGrantPath('docs/nested/../spec.md');
    expect(inside.ok ? inside.path : '').toBe('docs/spec.md');

    for (const escape of ['../etc/passwd', 'docs/../../etc/passwd', '..', 'a/../..']) {
      const verdict = normaliseGrantPath(escape);
      expect(verdict.ok, escape).toBe(false);
      expect(verdict.ok ? '' : verdict.refusal).toBe('escapes_root');
    }
  });

  it('refuses an absolute path under every platform, not only POSIX', () => {
    for (const absolute of ['/etc/passwd', '\\\\server\\share', 'C:/Windows', 'c:\\Windows']) {
      const verdict = normaliseGrantPath(absolute);
      expect(verdict.ok, absolute).toBe(false);
      // A backslash is refused as an illegal character before the absolute check can see it;
      // both answers are refusals, and which one fires is not the property under test.
      expect(['absolute', 'illegal_character']).toContain(verdict.ok ? '' : verdict.refusal);
    }
  });

  it('refuses a NUL byte and a backslash rather than normalising around them', () => {
    expect(normaliseGrantPath('docs/spec\0.md').ok).toBe(false);
    const backslash = normaliseGrantPath('docs\\spec.md');
    expect(backslash.ok).toBe(false);
    expect(backslash.ok ? '' : backslash.refusal).toBe('illegal_character');
  });

  it('refuses a path that names nothing inside the workspace', () => {
    for (const empty of ['', '.', './', './/.']) {
      const verdict = normaliseGrantPath(empty);
      expect(verdict.ok, JSON.stringify(empty)).toBe(false);
      expect(verdict.ok ? '' : verdict.refusal).toBe('empty');
    }
    // `//` is refused one rule earlier, as an absolute path: it begins with a separator, and
    // that is decided before any segment is looked at. Both are refusals; the assertion names
    // which one fires so a future reordering of the rules is a visible change.
    const doubleSlash = normaliseGrantPath('//');
    expect(doubleSlash.ok ? '' : doubleSlash.refusal).toBe('absolute');
  });

  it("refuses the engine's own configuration directory however it is spelled", () => {
    for (const spelling of ['.claude/settings.json', './.claude/x', 'a/../.claude/x', '.claude']) {
      const verdict = normaliseGrantPath(spelling, '.claude');
      expect(verdict.ok, spelling).toBe(false);
      expect(verdict.ok ? '' : verdict.refusal).toBe('protected_directory');
    }
    // The directory is the *adapter's*, so a different engine protects a different name and
    // `.claude` is an ordinary path to it.
    expect(normaliseGrantPath('.claude/settings.json', '.scripted-engine').ok).toBe(true);
  });
});

describe('writeGrantVerdict', () => {
  const grants = [
    { kind: 'directory' as const, path: 'docs', segments: ['docs'], access: 'read' as const },
    {
      kind: 'file' as const,
      path: 'config/app.yaml',
      segments: ['config', 'app.yaml'],
      access: 'read' as const,
    },
    {
      kind: 'directory' as const,
      path: 'scratch',
      segments: ['scratch'],
      access: 'read-write' as const,
    },
  ];

  it('refuses a write anywhere under a read-only directory grant', () => {
    for (const candidate of ['docs/spec.md', 'docs/a/b/c.md', 'docs', 'x/../docs/spec.md']) {
      expect(writeGrantVerdict(candidate, grants).ok, candidate).toBe(false);
    }
  });

  it('refuses a write to a read-only file grant and to nothing beside it', () => {
    expect(writeGrantVerdict('config/app.yaml', grants).ok).toBe(false);
    // A *file* grant protects exactly itself: a sibling in the same directory was never granted
    // and is therefore not covered by it.
    expect(writeGrantVerdict('config/other.yaml', grants).ok).toBe(true);
  });

  it('compares by segment, so a name that merely starts with a grant is not covered', () => {
    // `docs-private` starts with `docs` as text. A prefix comparison would deny it here and,
    // with the arguments the other way round, would allow a write a grant did covered.
    expect(writeGrantVerdict('docs-private/secret.md', grants).ok).toBe(true);
  });

  it('allows a write under a read-write grant and outside every grant', () => {
    expect(writeGrantVerdict('scratch/output.md', grants).ok).toBe(true);
    expect(writeGrantVerdict('notes.md', grants).ok).toBe(true);
  });

  it('refuses rather than compares when the candidate does not normalise', () => {
    const verdict = writeGrantVerdict('../../etc/passwd', grants);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok ? '' : verdict.refusal).toBe('escapes_root');
  });
});

describe('normaliseGrants', () => {
  it('normalises a whole list', () => {
    const result = normaliseGrants([
      { kind: 'directory', path: './docs/', access: 'read' },
      { kind: 'file', path: 'a/../b.md', access: 'read-write' },
    ]);
    expect(result.ok && result.grants.map((grant) => grant.path)).toEqual(['docs', 'b.md']);
  });

  it('refuses the list rather than dropping the entry it could not read', () => {
    // Dropping it would compile a *narrower* protection set than the control plane sent and the
    // run would look exactly as though it had been granted correctly.
    const result = normaliseGrants([
      { kind: 'directory', path: 'docs', access: 'read' },
      { kind: 'file', path: '../escape.md', access: 'read' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain('escape.md');
  });
});

describe('workspace verdicts', () => {
  const workspace: EngineWorkspace = {
    cwd: '/workspace/tenant',
    grants: [
      {
        kind: 'directory',
        path: 'docs/contracts',
        segments: ['docs', 'contracts'],
        access: 'read',
      },
      { kind: 'directory', path: 'scratch', segments: ['scratch'], access: 'read-write' },
    ],
    protectedDirectory: '.demo',
  };

  it('resolves an absolute path only under cwd, and cwd itself to the root', () => {
    expect(workspacePathVerdict(workspace, '/workspace/tenant/notes/a.md')).toEqual({
      ok: true,
      relative: 'notes/a.md',
    });
    for (const root of ['/workspace/tenant', '/workspace/tenant/', '.', './', '']) {
      expect(workspacePathVerdict(workspace, root), root).toEqual({ ok: true, relative: '.' });
    }
    expect(workspacePathVerdict(workspace, '/etc/passwd').ok).toBe(false);
    expect(workspacePathVerdict(workspace, '/workspace/tenant-other/a.md').ok).toBe(false);
  });

  it('refuses a relative path that climbs out', () => {
    expect(workspacePathVerdict(workspace, '../outside').ok).toBe(false);
    expect(workspacePathVerdict(workspace, 'a/../../outside').ok).toBe(false);
  });

  it('refuses to write the root, the protected directory and a read-only grant', () => {
    expect(relativeWriteVerdict(workspace, '.')).toEqual({
      ok: false,
      reason: 'the workspace root itself is not a file that can be written.',
    });
    expect(relativeWriteVerdict(workspace, '.demo/settings.json').ok).toBe(false);
    expect(relativeWriteVerdict(workspace, 'docs/contracts/a.pdf').ok).toBe(false);
    expect(relativeWriteVerdict(workspace, 'docs/other.md')).toEqual({
      ok: true,
      relative: 'docs/other.md',
    });
  });

  it('writes by the named path: resolve, then check', () => {
    expect(workspaceWriteVerdict(workspace, '/workspace/tenant/scratch/a.md')).toEqual({
      ok: true,
      relative: 'scratch/a.md',
    });
    expect(workspaceWriteVerdict(workspace, '/workspace/tenant/docs/contracts/a.pdf').ok).toBe(
      false,
    );
    expect(workspaceWriteVerdict(workspace, '/etc/passwd').ok).toBe(false);
  });

  it('refuses to remove or move a parent of a read-only grant, and the protected directory', () => {
    for (const relative of ['docs', 'docs/contracts']) {
      const verdict = relativeSubtreeVerdict(workspace, relative);
      expect(verdict.ok, relative).toBe(false);
      expect(verdict.ok ? '' : verdict.reason, relative).toContain('read-only grant');
    }
    const protectedDirectory = relativeSubtreeVerdict(workspace, '.demo');
    expect(protectedDirectory.ok ? '' : protectedDirectory.reason).toContain('".demo"');
  });

  it('compares subtrees by segment: docs-private is not docs', () => {
    expect(relativeSubtreeVerdict(workspace, 'docs-private')).toEqual({
      ok: true,
      relative: 'docs-private',
    });
    expect(relativeSubtreeVerdict(workspace, 'docs/contracts-old')).toEqual({
      ok: true,
      relative: 'docs/contracts-old',
    });
    expect(relativeSubtreeVerdict(workspace, 'scratch/a.md').ok).toBe(true);
  });
});
