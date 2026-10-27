import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  SkillDetailSchema,
  SkillExportSchema,
  SkillRevisionSchema,
} from '@indx-workspace/contracts/skills';
import { createClient } from '@indx-workspace/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson, tempDirectory, tempFile } from '../testing.js';
import { uploadSkill } from './skills.js';

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

  // @story US-STO-08
  it('[US-STO-08][api][cli] aw skills push sends multipart', async () => {
    await tempFile(directory, 'release-notes/SKILL.md', SKILL_MD);
    await tempFile(directory, 'release-notes/templates/notes.md', '# Notes\n');
    const skillDir = path.join(directory, 'release-notes');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let run: Awaited<ReturnType<typeof runCli>>;
    try {
      run = await runCli(['skills', 'import', skillDir, '--json'], {
        route: () => json(201, { skill: FIXTURES.skill }),
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(run.code).toBe(EXIT_CODE.ok);
    const [call] = run.calls;
    expect(call?.method).toBe('POST');
    expect(call?.url.pathname).toBe('/api/skills');
    expect(call?.json).toBeUndefined();
    const form = call?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect([...form.keys()]).toEqual(['name', 'file', 'file']);
    expect(form.get('name')).toBe('release-notes');
    const files = form.getAll('file') as File[];
    expect(files.map((file) => file.name)).toEqual(['SKILL.md', 'templates/notes.md']);
    expect(await files[0]?.text()).toBe(SKILL_MD);
    expect(await files[1]?.text()).toBe('# Notes\n');
    const renamed = await runCli(['skills', 'import', skillDir, '--name', 'notes'], {
      route: () => json(201, { skill: { ...FIXTURES.skill, name: 'notes' } }),
    });
    expect((renamed.calls[0]?.body as FormData).get('name')).toBe('notes');
    const absent = await runCli(['skills', 'import', path.join(directory, 'nope')]);
    expect(absent.code).toBe(EXIT_CODE.usage);
  });

  // @story US-STO-08
  it('[US-STO-08][api][cli] aw push creates a skill as multipart without the deprecated form', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const calls: RequestInit[] = [];
      const client = createClient({
        baseUrl: 'https://aw.example.com',
        auth: { kind: 'api-key', apiKey: 'ak_live_test' },
        fetch: (_input, init) => {
          calls.push(init ?? {});
          return Promise.resolve(json(201, { skill: FIXTURES.skill }));
        },
      });
      await uploadSkill(
        client,
        {
          name: 'release-notes',
          files: [
            { path: 'SKILL.md', contentBase64: Buffer.from(SKILL_MD).toString('base64') },
            { path: 'data.bin', contentBase64: Buffer.from([0, 255, 7]).toString('base64') },
          ],
        },
        new AbortController().signal,
      );
      const form = calls[0]?.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      const files = form.getAll('file') as File[];
      expect(files.map((file) => file.name)).toEqual(['SKILL.md', 'data.bin']);
      expect(await files[0]?.text()).toBe(SKILL_MD);
      expect([...new Uint8Array(await (files[1] as File).arrayBuffer())]).toEqual([0, 255, 7]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('publish posts the directory to the skill revisions and prints the revision', async () => {
    await tempFile(directory, 'frozen/SKILL.md', SKILL_MD);
    const revision = { number: 3, fileCount: 1, publishedAt: '2026-01-01T00:00:00.000Z' };
    const run = await runCli(
      ['skills', 'publish', 'release-notes', path.join(directory, 'frozen'), '--json'],
      { route: () => json(201, { revision }) },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('POST');
    expect(run.calls[0]?.url.pathname).toBe('/api/skills/release-notes/revisions');
    expect(run.calls[0]?.json).toEqual({
      files: [{ path: 'SKILL.md', contentBase64: Buffer.from(SKILL_MD).toString('base64') }],
    });
    expect(SkillRevisionSchema.parse(stdoutJson(run))).toEqual(revision);
    const absent = await runCli([
      'skills',
      'publish',
      'release-notes',
      path.join(directory, 'nope'),
    ]);
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
