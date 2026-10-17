/**
 * `run_skill_script`'s containment check over Windows paths (#1095): `path.win32` decides, so the
 * `\` separator, drive letters and case-insensitivity are tested on every platform. The real
 * process on a real disk is `run-skill-script.test.ts`.
 */
import path from 'node:path';

import {
  runSkillScript,
  type SkillScriptHost,
  type SkillScriptSetup,
} from '@agent-workspace/engine';
import { describe, expect, it } from 'vitest';

const SETUP: SkillScriptSetup = {
  cwd: 'C:\\work',
  skillsDirectory: '.engine-config/skills',
  skills: [{ name: 'review', scripts: ['check.mjs'] }],
  writable: ['drafts'],
};
const SCRIPTS = 'C:\\work\\.engine-config\\skills\\review\\scripts';
const CALL = { skill: 'review', script: 'check.mjs', args: [] };
const EXISTING = ['C:\\work', SCRIPTS, `${SCRIPTS}\\check.mjs`, `${SCRIPTS}\\..notes.mjs`];

function windows(
  existing: readonly string[],
  realpaths: Readonly<Record<string, string>> = {},
): { readonly host: SkillScriptHost; readonly commands: string[][] } {
  const commands: string[][] = [];
  const known = new Set(existing);
  const host: SkillScriptHost = {
    execPath: 'C:\\node\\node.exe',
    path: path.win32,
    realpath: (target) => {
      const mapped = realpaths[target];
      if (mapped !== undefined) return Promise.resolve(mapped);
      return known.has(target)
        ? Promise.resolve(target)
        : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    },
    execFile: (_file, args) => {
      commands.push([...args]);
      return Promise.resolve({ stdout: 'ok', stderr: '' });
    },
    makeScratchDirectory: () => Promise.resolve('C:\\scratch\\call-1'),
    removeDirectory: () => Promise.resolve(),
  };
  return { host, commands };
}

describe('runSkillScript: containment with Windows paths', () => {
  it('accepts the script and builds the command line with native separators', async () => {
    const { host, commands } = windows(EXISTING);
    expect(await runSkillScript(host, SETUP, CALL)).toMatchObject({ ok: true, exitCode: 0 });
    expect(commands[0]).toContain(`${SCRIPTS}\\check.mjs`);
    expect(commands[0]).toContain('--allow-fs-write=C:\\work\\drafts');
  });

  it('accepts real paths that differ from the placed ones only in drive-letter and name case', async () => {
    const { host } = windows(EXISTING, {
      [SCRIPTS]: SCRIPTS.toUpperCase().replace('C:', 'c:'),
      [`${SCRIPTS}\\check.mjs`]: `${SCRIPTS.toUpperCase()}\\CHECK.MJS`,
    });
    expect(await runSkillScript(host, SETUP, CALL)).toMatchObject({ ok: true });
  });

  it('accepts a working directory given by its 8.3 short name once it is resolved', async () => {
    const short = 'C:\\Users\\RUNNER~1\\work';
    const long = 'C:\\Users\\runneradmin\\work';
    const scripts = `${long}\\.engine-config\\skills\\review\\scripts`;
    const { host } = windows([scripts, `${scripts}\\check.mjs`], { [short]: long });
    expect(await runSkillScript(host, { ...SETUP, cwd: short }, CALL)).toMatchObject({ ok: true });
  });

  it('accepts a file whose name merely begins with two dots', async () => {
    const { host } = windows(EXISTING);
    expect(await runSkillScript(host, SETUP, { ...CALL, script: '..notes.mjs' })).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ['a file outside scripts/ on the same drive', 'C:\\elsewhere\\x.mjs'],
    ['a file on another drive', `D:${SCRIPTS.slice(2)}\\check.mjs`],
    ['a sibling directory sharing the prefix', `${SCRIPTS}-evil\\check.mjs`],
    ['the scripts/ directory itself', SCRIPTS],
  ])('refuses a script that resolves to %s', async (_name, target) => {
    const { host, commands } = windows(EXISTING, { [`${SCRIPTS}\\check.mjs`]: target });
    expect(await runSkillScript(host, SETUP, CALL)).toMatchObject({
      ok: false,
      refusal: 'outside_skill_directory',
    });
    expect(commands).toEqual([]);
  });

  it('refuses a scripts/ directory that is a link out, even with the script inside its target', async () => {
    const { host, commands } = windows(EXISTING, {
      [SCRIPTS]: 'C:\\elsewhere\\scripts',
      [`${SCRIPTS}\\check.mjs`]: 'C:\\elsewhere\\scripts\\check.mjs',
    });
    expect(await runSkillScript(host, SETUP, CALL)).toMatchObject({
      ok: false,
      refusal: 'outside_skill_directory',
    });
    expect(commands).toEqual([]);
  });
});
