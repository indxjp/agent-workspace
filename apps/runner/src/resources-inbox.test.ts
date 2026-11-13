import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type RunSkillReference } from '@agent-workspace/run-protocol';
import { expect, it } from 'vitest';
import {
  readSkillInbox,
  removeSkillInbox,
  SkillInboxMismatchError,
  withoutSkills,
} from './resources.js';
import {
  ENGINE,
  wireRequest,
  materialize,
  configDirOf,
  withResourceRoot,
} from './resources.fixture.test-support.js';

// @story US-STO-06
// @story US-STO-11
const bytes = '# support skill';

const granted: RunSkillReference = {
  name: 'support',
  files: [
    {
      path: 'SKILL.md',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ],
};

async function lay(cwd: string): Promise<string> {
  const inbox = path.join(cwd, '.aw-inbox', 'skills', 'support');
  await mkdir(inbox, { recursive: true });
  await writeFile(path.join(inbox, 'SKILL.md'), bytes);
  return inbox;
}

it('skill references through the inbox > [US-STO-06][contract][run] a skill reference is placed from the inbox', async () => {
  await withResourceRoot('agent-skill-inbox-', async (root) => {
    const parsed = wireRequest(root, [], [granted]);
    await lay(parsed.cwd);
    const inlined = await readSkillInbox(parsed, ENGINE.protectedConfigDirectory);
    removeSkillInbox(parsed.cwd, ENGINE.protectedConfigDirectory);
    materialize(inlined);
    const placed = path.join(configDirOf(parsed), 'skills', 'support', 'SKILL.md');
    expect(await readFile(placed, 'utf8')).toBe(bytes);
    expect((await lstat(placed)).mode & 0o777).toBe(0o444);
    await expect(lstat(path.join(parsed.cwd, '.aw-inbox'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('skill references through the inbox > [US-STO-06][contract][run] an inbox file whose bytes differ from its reference is refused', async () => {
  await withResourceRoot('agent-skill-inbox-swap-', async (root) => {
    const parsed = wireRequest(root, [], [granted]);
    const inbox = await lay(parsed.cwd);
    // Same size, other bytes.
    await writeFile(path.join(inbox, 'SKILL.md'), bytes.toUpperCase());
    await expect(readSkillInbox(parsed, ENGINE.protectedConfigDirectory)).rejects.toBeInstanceOf(
      SkillInboxMismatchError,
    );
  });
});

it('skill references through the inbox > [US-STO-06][contract][run] a request that grants skills is not stripped of them', () => {
  expect(() => withoutSkills(wireRequest('/tmp', [], [granted]))).toThrow(/grants skills/);
});

it('skill references through the inbox > [US-STO-06][contract][run] a symlinked inbox path is refused', async () => {
  await withResourceRoot('agent-skill-inbox-link-', async (root) => {
    const parsed = wireRequest(root, [], [granted]);
    const outside = path.join(root, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'SKILL.md'), bytes);
    await mkdir(path.join(parsed.cwd, '.aw-inbox', 'skills'), { recursive: true });
    await symlink(outside, path.join(parsed.cwd, '.aw-inbox', 'skills', 'support'));
    await expect(readSkillInbox(parsed, ENGINE.protectedConfigDirectory)).rejects.toThrow();
  });
});

it('skill references through the inbox > [US-STO-11][contract][run] a read-only inbox is still removed', async () => {
  await withResourceRoot('agent-skill-inbox-ro-', async (root) => {
    const parsed = wireRequest(root, [], [granted]);
    const inbox = await lay(parsed.cwd);
    await chmod(path.join(inbox, 'SKILL.md'), 0o444);
    await chmod(inbox, 0o555);
    removeSkillInbox(parsed.cwd, ENGINE.protectedConfigDirectory);
    await expect(lstat(path.join(parsed.cwd, '.aw-inbox'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
