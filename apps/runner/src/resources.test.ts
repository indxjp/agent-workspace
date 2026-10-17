import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RunRequest, type RunFileResource, type RunSkillResource } from '@agent-workspace/core';
import { skillsUnderConfigDirectory } from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

import { toEngineRunRequest } from './engines.js';
import { materializeRunResources, type SkillPlacingEngine } from './resources.js';

/**
 * The engine, as materialisation sees one (ENG-04b, #325).
 *
 * A stand-in for the Claude adapter rather than the adapter itself: what this file is about is the
 * *writing*, and the two answers it needs from an engine are a directory name and a list of paths.
 * Taking them from a fixture is what lets the escape cases below exist at all — the real adapter
 * cannot be asked to place a skill outside its own directory.
 */
const ENGINE: SkillPlacingEngine = {
  protectedConfigDirectory: '.claude',
  placeSkills: (engineRequest) =>
    skillsUnderConfigDirectory(engineRequest.resources.skills, '.claude'),
};

function request(
  root: string,
  files: readonly RunFileResource[],
  skills: readonly RunSkillResource[] = [],
) {
  const cwd = path.join(root, 'workspace');
  return RunRequest.parse({
    runId: '11111111-1111-4111-8111-111111111111',
    sessionId: '44444444-4444-4444-8444-444444444444',
    cwd,
    prompt: 'test',
    projectKey: 'workspace',
    portable: {
      name: 'test',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: { tools: null, fileGrantDeny: [] },
    session: { kind: 'fresh', sessionId: '44444444-4444-4444-8444-444444444444' },
    env: {},
    resources: { files, skills },
  });
}

/** Materialize one request through {@link ENGINE}, the way `index.ts` does through the real one. */
function materialize(parsed: RunRequest, engine: SkillPlacingEngine = ENGINE) {
  return materializeRunResources(parsed, toEngineRunRequest(parsed), engine);
}

/** Where {@link ENGINE} keeps its configuration, for a test that asserts about a written path. */
function configDirOf(parsed: RunRequest): string {
  return path.join(parsed.cwd, ENGINE.protectedConfigDirectory);
}

/**
 * Restore write permission across a scratch root before removing it.
 *
 * Materialization deliberately leaves a granted tree as `0o555` directories and `0o444` files, and
 * POSIX needs write permission on the *containing* directory to unlink anything inside it. A plain
 * `rm` of the root therefore fails with `EACCES` on the first entry the last turn locked down, so
 * these tests restore the modes before removing the temporary directory.
 */
async function restoreWritable(target: string): Promise<void> {
  const stats = await lstat(target).catch(() => null);
  if (stats === null || stats.isSymbolicLink()) return;
  await chmod(target, stats.isDirectory() ? 0o700 : 0o600);
  if (!stats.isDirectory()) return;
  for (const entry of await readdir(target)) await restoreWritable(path.join(target, entry));
}

async function removeRoot(root: string): Promise<void> {
  await restoreWritable(root);
  await rm(root, { recursive: true, force: true });
}

describe('run resource materialization', () => {
  it('materializes only selected files and removes an assignment revoked before resume', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-resources-'));
    try {
      const first = request(root, [
        {
          kind: 'file',
          path: 'assigned.txt',
          access: 'read-write',
          contentBase64: Buffer.from('assigned').toString('base64'),
        },
      ]);
      materialize(first);
      expect(await readFile(path.join(first.cwd, 'assigned.txt'), 'utf8')).toBe('assigned');
      await expect(readFile(path.join(first.cwd, 'unassigned.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      materialize(request(root, []));
      await expect(readFile(path.join(first.cwd, 'assigned.txt'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await removeRoot(root);
    }
  });

  it('makes a read-only assignment immutable at the filesystem boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-readonly-'));
    try {
      const parsed = request(root, [
        {
          kind: 'file',
          path: 'readonly.txt',
          access: 'read',
          contentBase64: Buffer.from('original').toString('base64'),
        },
      ]);
      materialize(parsed);
      if (process.platform !== 'win32') {
        await expect(writeFile(path.join(parsed.cwd, 'readonly.txt'), 'changed')).rejects.toThrow();
      }
      expect(await readFile(path.join(parsed.cwd, 'readonly.txt'), 'utf8')).toBe('original');
    } finally {
      await removeRoot(root);
    }
  });

  it('re-materializes an assigned skill on every turn of the same session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-turns-'));
    try {
      const skill = (body: string): RunSkillResource => ({
        name: 'reviewer',
        files: [
          { path: 'SKILL.md', contentBase64: Buffer.from(body).toString('base64') },
          { path: 'scripts/run.sh', contentBase64: Buffer.from('echo hi').toString('base64') },
        ],
      });
      const first = request(root, [], [skill('# first')]);
      materialize(first);
      const manifest = path.join(configDirOf(first), 'skills', 'reviewer', 'SKILL.md');
      expect(await readFile(manifest, 'utf8')).toBe('# first');

      // The first turn left the skill tree read-only. A second turn of the same session rewrites
      // it, which means unlinking entries inside a directory this process no longer has write
      // permission on unless the modes are restored first.
      materialize(request(root, [], [skill('# second')]));
      expect(await readFile(manifest, 'utf8')).toBe('# second');
    } finally {
      await removeRoot(root);
    }
  });

  it('removes a support file a skill dropped between two turns of one session', async () => {
    // ENG-04b's manifest records the *paths* it wrote rather than the skill names, so a file the
    // tenant removed from a still-assigned skill is removed from the sandbox too. On the pre-ENG-04b
    // tree-delete this worked by accident; recorded explicitly, it is a property rather than a
    // side effect.
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-dropped-'));
    try {
      const both: RunSkillResource = {
        name: 'reviewer',
        files: [
          { path: 'SKILL.md', contentBase64: Buffer.from('# skill').toString('base64') },
          { path: 'scripts/run.sh', contentBase64: Buffer.from('echo hi').toString('base64') },
        ],
      };
      const first = request(root, [], [both]);
      materialize(first);
      const dropped = path.join(configDirOf(first), 'skills', 'reviewer', 'scripts', 'run.sh');
      expect(await readFile(dropped, 'utf8')).toBe('echo hi');

      materialize(
        request(
          root,
          [],
          [{ name: 'reviewer', files: [both.files[0] as RunSkillResource['files'][number]] }],
        ),
      );
      await expect(readFile(dropped, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      // The skill itself is still assigned, so its SKILL.md is still there.
      expect(
        await readFile(path.join(configDirOf(first), 'skills', 'reviewer', 'SKILL.md'), 'utf8'),
      ).toBe('# skill');
    } finally {
      await removeRoot(root);
    }
  });

  it('removes a fully revoked skill recorded in the path manifest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-revoked-'));
    try {
      const first = request(
        root,
        [],
        [
          {
            name: 'reviewer',
            files: [
              { path: 'SKILL.md', contentBase64: Buffer.from('# skill').toString('base64') },
              { path: 'scripts/run.sh', contentBase64: Buffer.from('echo hi').toString('base64') },
            ],
          },
        ],
      );
      materialize(first);
      const skillRoot = path.join(configDirOf(first), 'skills', 'reviewer');
      expect(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe('# skill');

      materialize(request(root, []));
      await expect(lstat(skillRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeRoot(root);
    }
  });

  it('removes a revoked skill recorded by a pre-ENG-04b manifest', async () => {
    // The first turn after the upgrade reads a manifest that has skill *names* and no `skillFiles`.
    // Revocation must fall back to the layout that wrote it, or the revoked bytes stay forever.
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-legacy-'));
    try {
      const parsed = request(root, []);
      const configDir = configDirOf(parsed);
      const skillRoot = path.join(configDir, 'skills', 'reviewer');
      await mkdir(path.join(skillRoot, 'scripts'), { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), '# legacy');
      await writeFile(path.join(skillRoot, 'scripts', 'run.sh'), 'echo hi');
      await chmod(path.join(skillRoot, 'scripts'), 0o555);
      await chmod(skillRoot, 0o555);
      await writeFile(
        path.join(configDir, 'agent-workspace-materialized-resources.json'),
        JSON.stringify({ files: [], skills: ['reviewer'] }),
      );

      const manifest = materialize(parsed);
      await expect(lstat(skillRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(manifest).toEqual({ files: [], skills: [], skillFiles: [] });
    } finally {
      await removeRoot(root);
    }
  });

  it('rewrites a still-granted skill from a pre-ENG-04b manifest without its dropped files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-legacy-kept-'));
    try {
      const parsed = request(
        root,
        [],
        [
          {
            name: 'reviewer',
            files: [{ path: 'SKILL.md', contentBase64: Buffer.from('# new').toString('base64') }],
          },
        ],
      );
      const configDir = configDirOf(parsed);
      const skillRoot = path.join(configDir, 'skills', 'reviewer');
      await mkdir(skillRoot, { recursive: true });
      await writeFile(path.join(skillRoot, 'SKILL.md'), '# legacy');
      await writeFile(path.join(skillRoot, 'stale.sh'), 'echo stale');
      await writeFile(
        path.join(configDir, 'agent-workspace-materialized-resources.json'),
        JSON.stringify({ files: [], skills: ['reviewer'] }),
      );

      materialize(parsed);
      expect(await readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).toBe('# new');
      await expect(lstat(path.join(skillRoot, 'stale.sh'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await removeRoot(root);
    }
  });

  it('refuses to write a skill an engine placed outside its own configuration directory', async () => {
    // The runner does not trust the adapter's answer: a placement at the sandbox root would put
    // tenant-supplied content beside the agent's own working files. ENG-04b's negative case, on the
    // writing side rather than in the conformance kit.
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-escape-'));
    try {
      const parsed = request(
        root,
        [],
        [{ name: 'reviewer', files: [{ path: 'SKILL.md', contentBase64: 'IyB4' }] }],
      );
      const escaping: SkillPlacingEngine = {
        protectedConfigDirectory: '.claude',
        placeSkills: () => [
          { skill: 'reviewer', path: 'skills/reviewer/SKILL.md', contentBase64: 'IyB4' },
        ],
      };
      expect(() => materialize(parsed, escaping)).toThrow(/outside_config_directory/u);
      await expect(
        readFile(path.join(parsed.cwd, 'skills', 'reviewer', 'SKILL.md'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeRoot(root);
    }
  });

  it('refuses to write a skill placed with a ".." that would resolve onto the engine\'s own settings file', async () => {
    // `.claude/skills/reviewer/../../settings.json` normalises to `.claude/settings.json` — still
    // inside the declared directory, so a check that only compared the normalised path against the
    // directory boundary would accept it. That path is the SDK's own project settings file; a skill
    // must never be able to land on it.
    const root = await mkdtemp(path.join(tmpdir(), 'agent-skill-dotdot-'));
    try {
      const parsed = request(
        root,
        [],
        [{ name: 'reviewer', files: [{ path: 'SKILL.md', contentBase64: 'IyB4' }] }],
      );
      const escaping: SkillPlacingEngine = {
        protectedConfigDirectory: '.claude',
        placeSkills: () => [
          {
            skill: 'reviewer',
            path: '.claude/skills/reviewer/../../settings.json',
            contentBase64: 'IyB4',
          },
        ],
      };
      expect(() => materialize(parsed, escaping)).toThrow(/unusable_path/u);
      await expect(
        readFile(path.join(parsed.cwd, '.claude', 'settings.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeRoot(root);
    }
  });

  it('revokes a read-only file that sits inside a read-only folder grant', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-revoke-readonly-'));
    try {
      const granted: readonly RunFileResource[] = [
        { kind: 'directory', path: 'contracts', access: 'read' },
        {
          kind: 'file',
          path: 'contracts/agreement.txt',
          access: 'read',
          contentBase64: Buffer.from('terms').toString('base64'),
        },
      ];
      const first = request(root, granted);
      materialize(first);
      expect(await readFile(path.join(first.cwd, 'contracts/agreement.txt'), 'utf8')).toBe('terms');

      materialize(request(root, []));
      await expect(
        readFile(path.join(first.cwd, 'contracts/agreement.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await removeRoot(root);
    }
  });

  it('rejects mixed-case aliases of the private .claude directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-private-resource-'));
    try {
      const parsed = request(root, [
        {
          kind: 'file',
          path: '.ClAuDe/settings.json',
          access: 'read-write',
          contentBase64: Buffer.from('{}').toString('base64'),
        },
      ]);
      expect(() => materialize(parsed)).toThrow(/private \.claude directory/u);
    } finally {
      await removeRoot(root);
    }
  });

  it('rejects a relative-prefixed path that normalizes into the private .claude directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-private-relative-'));
    try {
      const parsed = request(root, [
        {
          kind: 'file',
          path: './.claude/settings.json',
          access: 'read-write',
          contentBase64: Buffer.from('{}').toString('base64'),
        },
      ]);
      expect(() => materialize(parsed)).toThrow('private .claude directory');
    } finally {
      await removeRoot(root);
    }
  });

  // Every spelling the writer (`normalizeArchivePath`) folds into `<cwd>/.claude/` must be refused by
  // the guard, because the guard judges the same normalised string (PR #327 review).
  it.each([
    ['a backslash separator', '.claude\\settings.json'],
    ['a percent-encoded leading dot', '%2Eclaude/settings.json'],
    ['a double-encoded leading dot', '%252Eclaude/settings.json'],
    ['an upper-case percent-encoded name', '%2E%43LAUDE/settings.json'],
    ['a repeated ./ prefix', './././.claude/settings.json'],
    ['an empty segment', './/.claude/settings.json'],
    ['a trailing slash on the directory itself', '.claude/'],
    ['the directory itself', '.claude'],
    ['a trailing dot Windows drops', '.claude./settings.json'],
    ['a trailing space Windows drops', '.claude /settings.json'],
  ])('rejects %s into the private .claude directory', async (_label, spelling) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-private-spelling-'));
    try {
      const parsed = request(root, [
        {
          kind: 'file',
          path: spelling,
          access: 'read-write',
          contentBase64: Buffer.from('{}').toString('base64'),
        },
      ]);
      expect(() => materialize(parsed)).toThrow('private .claude directory');
      await expect(lstat(path.join(configDirOf(parsed), 'settings.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await removeRoot(root);
    }
  });

  it.each([
    ['a parent segment that climbs back in', 'notes/../.claude/settings.json'],
    ['an encoded parent segment', 'notes/%2E%2E/.claude/settings.json'],
  ])('refuses %s before anything is written', async (_label, spelling) => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-private-parent-'));
    try {
      const parsed = request(root, [
        {
          kind: 'file',
          path: spelling,
          access: 'read-write',
          contentBase64: Buffer.from('{}').toString('base64'),
        },
      ]);
      expect(() => materialize(parsed)).toThrow(/unsafe archive path/u);
      await expect(lstat(path.join(configDirOf(parsed), 'settings.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await removeRoot(root);
    }
  });

  it('still writes a sibling whose name only starts with the private directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'agent-private-sibling-'));
    try {
      const parsed = request(root, [
        {
          kind: 'file',
          path: '.claude-backup/notes.md',
          access: 'read-write',
          contentBase64: Buffer.from('ok').toString('base64'),
        },
      ]);
      materialize(parsed);
      expect(await readFile(path.join(parsed.cwd, '.claude-backup', 'notes.md'), 'utf8')).toBe(
        'ok',
      );
    } finally {
      await removeRoot(root);
    }
  });
});
