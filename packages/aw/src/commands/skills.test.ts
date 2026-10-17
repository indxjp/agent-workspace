import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { SkillDetailSchema, SkillExportSchema } from '@indx-workspace/contracts/skills';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';

let directory: string;

beforeAll(async () => {
  directory = await tempDirectory();
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const SKILL_MD = '---\ndescription: Write release notes\n---\nDo it.';

describe('aw skills', () => {
  it('list and get round-trip through the contract', async () => {
    const list = await runCli(['skills', 'list', '--json'], {
      route: () => json(200, { skills: [FIXTURES.skill] }),
    });
    expect(SkillDetailSchema.array().parse(stdoutJson(list))).toEqual([FIXTURES.skill]);
    const human = await runCli(['skills', 'list'], {
      route: () => json(200, { skills: [FIXTURES.skill] }),
    });
    expect(human.stdout.split('\n')[0]).toMatch(
      /^name\s+enabled\s+description\s+fileCount\s+updatedAt$/u,
    );
    const get = await runCli(['skills', 'get', 'release-notes', '--json'], {
      route: () => json(200, { skill: FIXTURES.skill }),
    });
    expect(get.calls[0]?.url.pathname).toBe('/api/skills/release-notes');
    expect(SkillDetailSchema.parse(stdoutJson(get))).toEqual(FIXTURES.skill);
  });

  it('import reads a directory into base64 files, named after the directory unless --name says otherwise', async () => {
    await tempFile(directory, 'release-notes/SKILL.md', SKILL_MD);
    await tempFile(directory, 'release-notes/templates/notes.md', '# Notes\n');
    const skillDir = path.join(directory, 'release-notes');
    const run = await runCli(['skills', 'import', skillDir, '--json'], {
      route: () => json(201, { skill: FIXTURES.skill }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.json).toEqual({
      name: 'release-notes',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from(SKILL_MD).toString('base64') },
        { path: 'templates/notes.md', contentBase64: Buffer.from('# Notes\n').toString('base64') },
      ],
    });
    const renamed = await runCli(['skills', 'import', skillDir, '--name', 'notes'], {
      route: () => json(201, { skill: { ...FIXTURES.skill, name: 'notes' } }),
    });
    expect(renamed.calls[0]?.json).toMatchObject({ name: 'notes' });
    const absent = await runCli(['skills', 'import', path.join(directory, 'nope')]);
    expect(absent.code).toBe(EXIT_CODE.usage);
  });

  it('export writes every file under the directory and refuses a path that escapes it', async () => {
    const exported = {
      name: 'release-notes',
      files: [
        { path: 'SKILL.md', contentBase64: Buffer.from(SKILL_MD).toString('base64') },
        { path: 'templates/notes.md', contentBase64: Buffer.from('# Notes\n').toString('base64') },
      ],
    };
    const out = path.join(directory, 'exported');
    const run = await runCli(['skills', 'export', 'release-notes', out], {
      route: () => json(200, { skill: exported }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.url.search).toBe('?export=true');
    expect(await readFile(path.join(out, 'SKILL.md'), 'utf8')).toBe(SKILL_MD);
    expect(await readFile(path.join(out, 'templates', 'notes.md'), 'utf8')).toBe('# Notes\n');
    expect(run.stdout).toBe('SKILL.md\ntemplates/notes.md\n');
    const structured = await runCli(['skills', 'export', 'release-notes', out, '--json'], {
      route: () => json(200, { skill: exported }),
    });
    expect(SkillExportSchema.parse(stdoutJson(structured))).toEqual(exported);

    const hostile = await runCli(['skills', 'export', 'release-notes', out], {
      route: () =>
        json(200, {
          skill: {
            name: 'release-notes',
            files: [{ path: '../../escape.md', contentBase64: 'YQ==' }],
          },
        }),
    });
    expect(hostile.code).toBe(EXIT_CODE.usage);
    expect(hostile.stderr).toContain('refusing to write outside');
  });

  it('update, enable and disable patch the skill', async () => {
    const update = await runCli(['skills', 'update', 'release-notes', '--file', '-'], {
      stdin: '{"removeFiles":["templates/notes.md"]}',
      route: () => json(200, { skill: FIXTURES.skill }),
    });
    expect(update.calls[0]?.method).toBe('PATCH');
    expect(update.calls[0]?.json).toEqual({ removeFiles: ['templates/notes.md'] });
    const disable = await runCli(['skills', 'disable', 'release-notes'], {
      route: () => json(200, { skill: { ...FIXTURES.skill, enabled: false } }),
    });
    expect(disable.calls[0]?.json).toEqual({ enabled: false });
    const enable = await runCli(['skills', 'enable', 'release-notes'], {
      route: () => json(200, { skill: FIXTURES.skill }),
    });
    expect(enable.calls[0]?.json).toEqual({ enabled: true });
  });

  it('removes a skill by name', async () => {
    const run = await runCli(['skills', 'remove', 'demo'], {
      route: () => new Response(null, { status: 204 }),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('DELETE');
    expect(run.calls[0]?.url.pathname).toBe('/api/skills/demo');
  });
});
