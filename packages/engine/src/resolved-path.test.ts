/**
 * The symlink-resolving guard (#951), over an in-memory filesystem.
 *
 * The port has no `@types/node`, so the host is a fake: a set of existing paths and a map of links.
 * The cases are the ones a link makes possible: one that leaves the workspace, one that points at
 * nothing, one that points into a read-only grant, and a path with no link on it at all.
 */
import { describe, expect, it } from 'vitest';

import type { EngineWorkspace } from './path-grant.js';
import { resolvedWorkspacePathVerdict, type ResolvedPathHost } from './resolved-path.js';

function missing(): Error {
  return Object.assign(new Error('no such file'), { code: 'ENOENT' });
}

function fakeHost(
  entries: readonly string[],
  links: Readonly<Record<string, string>>,
): ResolvedPathHost {
  const existing = new Set(entries);
  const resolve = (target: string): string => {
    let current = '';
    for (const part of target.split('/').filter((segment) => segment !== '')) {
      current = `${current}/${part}`;
      const link = links[current];
      if (link !== undefined) current = resolve(link);
      else if (!existing.has(current)) throw missing();
    }
    return current === '' ? '/' : current;
  };
  const segments = (value: string): string[] => value.split('/').filter((part) => part !== '');
  return {
    realpath: (target) => {
      try {
        return Promise.resolve(resolve(target));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
    lstat: (target) => {
      if (target in links) return Promise.resolve({ isSymbolicLink: () => true });
      if (existing.has(target)) return Promise.resolve({ isSymbolicLink: () => false });
      return Promise.reject(missing());
    },
    path: {
      join: (...parts) => `/${segments(parts.join('/')).join('/')}`,
      dirname: (value) => `/${segments(value).slice(0, -1).join('/')}`,
      basename: (value) => segments(value).at(-1) ?? '',
      relative: (from, to) => {
        const a = segments(from);
        const b = segments(to);
        let shared = 0;
        while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
        return [...a.slice(shared).map(() => '..'), ...b.slice(shared)].join('/');
      },
      isAbsolute: (value) => value.startsWith('/'),
      sep: '/',
    },
  };
}

const workspace: EngineWorkspace = {
  cwd: '/ws',
  grants: [{ kind: 'directory', path: 'docs', segments: ['docs'], access: 'read' }],
  protectedDirectory: '.demo',
};

const host = fakeHost(
  ['/ws', '/ws/docs', '/ws/docs/spec.md', '/ws/notes', '/outside', '/outside/secret'],
  {
    '/ws/notes/escape': '/outside/secret',
    '/ws/notes/dangling': '/nowhere/at/all',
    '/ws/notes/readonly': '/ws/docs/spec.md',
  },
);

describe('resolvedWorkspacePathVerdict', () => {
  it('refuses a link that resolves outside the workspace, for a read and a write', async () => {
    for (const writes of [false, true]) {
      const verdict = await resolvedWorkspacePathVerdict(workspace, 'notes/escape', writes, host);
      expect(verdict, String(writes)).toEqual({
        ok: false,
        reason: '"notes/escape" resolves outside the workspace through a symbolic link.',
      });
    }
  });

  it('refuses a write through a dangling link, and still reads the path', async () => {
    expect(await resolvedWorkspacePathVerdict(workspace, 'notes/dangling', true, host)).toEqual({
      ok: false,
      reason:
        '"notes/dangling" is a symbolic link to nothing; writing it would create a file wherever it points.',
    });
    expect(await resolvedWorkspacePathVerdict(workspace, 'notes/dangling', false, host)).toEqual({
      ok: true,
      relative: 'notes/dangling',
    });
  });

  it('refuses a write through a link into a read-only grant, and reads it as the real path', async () => {
    const write = await resolvedWorkspacePathVerdict(workspace, 'notes/readonly', true, host);
    expect(write.ok).toBe(false);
    expect(write.ok ? '' : write.reason).toContain('read-only grant "docs"');
    expect(await resolvedWorkspacePathVerdict(workspace, 'notes/readonly', false, host)).toEqual({
      ok: true,
      relative: 'docs/spec.md',
    });
  });

  it('lets a plain path through, existing or not', async () => {
    expect(await resolvedWorkspacePathVerdict(workspace, 'notes/new.md', true, host)).toEqual({
      ok: true,
      relative: 'notes/new.md',
    });
    expect(await resolvedWorkspacePathVerdict(workspace, '.', false, host)).toEqual({
      ok: true,
      relative: '.',
    });
  });

  it('lets an infrastructure failure through rather than calling it absent', async () => {
    const broken: ResolvedPathHost = {
      ...host,
      realpath: () => Promise.reject(Object.assign(new Error('boom'), { code: 'EIO' })),
    };
    await expect(resolvedWorkspacePathVerdict(workspace, 'notes/x', false, broken)).rejects.toThrow(
      'boom',
    );
  });
});
