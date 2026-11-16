import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type RunFileResource } from '@agent-workspace/run-protocol';
import { type EngineSkillGrant } from '@agent-workspace/engine';
import { expect, it } from 'vitest';
import { type SkillPlacingEngine } from './resources.js';
import {
  request,
  fileRef,
  layFile,
  materialize,
  configDirOf,
  withResourceRoot,
} from './resources.fixture.test-support.js';

it('run resource materialization > materializes only selected files and removes an assignment revoked before resume', async () => {
  await withResourceRoot('agent-resources-', async (root) => {
    const first = request(root, [fileRef('assigned.txt', 'read-write')]);
    await layFile(first, 'assigned.txt', 'assigned');
    materialize(first);
    expect(await readFile(path.join(first.cwd, 'assigned.txt'), 'utf8')).toBe('assigned');
    await expect(readFile(path.join(first.cwd, 'unassigned.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    materialize(request(root, []));
    await expect(readFile(path.join(first.cwd, 'assigned.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('run resource materialization > makes a read-only assignment immutable at the filesystem boundary', async () => {
  await withResourceRoot('agent-readonly-', async (root) => {
    const parsed = request(root, [fileRef('readonly.txt', 'read')]);
    await layFile(parsed, 'readonly.txt', 'original');
    materialize(parsed);
    if (process.platform !== 'win32') {
      await expect(writeFile(path.join(parsed.cwd, 'readonly.txt'), 'changed')).rejects.toThrow();
    }
    expect(await readFile(path.join(parsed.cwd, 'readonly.txt'), 'utf8')).toBe('original');
  });
});

it('run resource materialization > re-materializes an assigned skill on every turn of the same session', async () => {
  await withResourceRoot('agent-skill-turns-', async (root) => {
    const skill = (body: string): EngineSkillGrant => ({
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
  });
});

it('run resource materialization > removes a support file a skill dropped between two turns of one session', async () => {
  // ENG-04b's manifest records the *paths* it wrote rather than the skill names, so a file the
  // tenant removed from a still-assigned skill is removed from the sandbox too. On the pre-ENG-04b
  // tree-delete this worked by accident; recorded explicitly, it is a property rather than a
  // side effect.
  await withResourceRoot('agent-skill-dropped-', async (root) => {
    const both: EngineSkillGrant = {
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
        [{ name: 'reviewer', files: [both.files[0] as EngineSkillGrant['files'][number]] }],
      ),
    );
    await expect(readFile(dropped, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    // The skill itself is still assigned, so its SKILL.md is still there.
    expect(
      await readFile(path.join(configDirOf(first), 'skills', 'reviewer', 'SKILL.md'), 'utf8'),
    ).toBe('# skill');
  });
});

it('run resource materialization > removes a fully revoked skill recorded in the path manifest', async () => {
  await withResourceRoot('agent-skill-revoked-', async (root) => {
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
  });
});

it('run resource materialization > removes a revoked skill recorded by a pre-ENG-04b manifest', async () => {
  // The first turn after the upgrade reads a manifest that has skill *names* and no `skillFiles`.
  // Revocation must fall back to the layout that wrote it, or the revoked bytes stay forever.
  await withResourceRoot('agent-skill-legacy-', async (root) => {
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
  });
});

it('run resource materialization > rewrites a still-granted skill from a pre-ENG-04b manifest without its dropped files', async () => {
  await withResourceRoot('agent-skill-legacy-kept-', async (root) => {
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
  });
});

it('run resource materialization > refuses to write a skill an engine placed outside its own configuration directory', async () => {
  // The runner does not trust the adapter's answer: a placement at the sandbox root would put
  // tenant-supplied content beside the agent's own working files. ENG-04b's negative case, on the
  // writing side rather than in the conformance kit.
  await withResourceRoot('agent-skill-escape-', async (root) => {
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
  });
});

it('run resource materialization > refuses to write a skill placed with a ".." that would resolve onto the engine\'s own settings file', async () => {
  // `.claude/skills/reviewer/../../settings.json` normalises to `.claude/settings.json` — still
  // inside the declared directory, so a check that only compared the normalised path against the
  // directory boundary would accept it. That path is the SDK's own project settings file; a skill
  // must never be able to land on it.
  await withResourceRoot('agent-skill-dotdot-', async (root) => {
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
  });
});

it('run resource materialization > revokes a read-only file that sits inside a read-only folder grant', async () => {
  await withResourceRoot('agent-revoke-readonly-', async (root) => {
    const granted: readonly RunFileResource[] = [
      { kind: 'directory', path: 'contracts', access: 'read' },
      fileRef('contracts/agreement.txt', 'read'),
    ];
    const first = request(root, granted);
    await layFile(first, 'contracts/agreement.txt', 'terms');
    materialize(first);
    expect(await readFile(path.join(first.cwd, 'contracts/agreement.txt'), 'utf8')).toBe('terms');

    materialize(request(root, []));
    await expect(
      readFile(path.join(first.cwd, 'contracts/agreement.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('run resource materialization > rejects mixed-case aliases of the private .claude directory', async () => {
  await withResourceRoot('agent-private-resource-', (root) => {
    const parsed = request(root, [fileRef('.ClAuDe/settings.json', 'read-write')]);
    expect(() => materialize(parsed)).toThrow(/private \.claude directory/u);
  });
});

it('run resource materialization > rejects a relative-prefixed path that normalizes into the private .claude directory', async () => {
  await withResourceRoot('agent-private-relative-', (root) => {
    const parsed = request(root, [fileRef('./.claude/settings.json', 'read-write')]);
    expect(() => materialize(parsed)).toThrow('private .claude directory');
  });
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
])(
  'run resource materialization > rejects %s into the private .claude directory',
  async (_label, spelling) => {
    await withResourceRoot('agent-private-spelling-', async (root) => {
      const parsed = request(root, [fileRef(spelling, 'read-write')]);
      expect(() => materialize(parsed)).toThrow('private .claude directory');
      await expect(lstat(path.join(configDirOf(parsed), 'settings.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

it.each([
  ['a parent segment that climbs back in', 'notes/../.claude/settings.json'],
  ['an encoded parent segment', 'notes/%2E%2E/.claude/settings.json'],
])(
  'run resource materialization > refuses %s before anything is written',
  async (_label, spelling) => {
    await withResourceRoot('agent-private-parent-', async (root) => {
      const parsed = request(root, [fileRef(spelling, 'read-write')]);
      expect(() => materialize(parsed)).toThrow(/unsafe archive path/u);
      await expect(lstat(path.join(configDirOf(parsed), 'settings.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);

it('run resource materialization > still writes a sibling whose name only starts with the private directory', async () => {
  await withResourceRoot('agent-private-sibling-', async (root) => {
    const parsed = request(root, [fileRef('.claude-backup/notes.md', 'read-write')]);
    await layFile(parsed, '.claude-backup/notes.md', 'ok');
    materialize(parsed);
    expect(await readFile(path.join(parsed.cwd, '.claude-backup', 'notes.md'), 'utf8')).toBe('ok');
  });
});
