/**
 * `run_skill_script`'s decisions, over a fake host. The real process — the permission model refusing
 * a write, a symlink escape on a real disk — is `tests/engine/run-skill-script.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA,
  SKILL_SCRIPT_LIMITS,
  executeRunSkillScript,
  parseRunSkillScriptInput,
  runSkillScript,
  skillScriptSetup,
  skillScriptToolDescription,
  type SkillScriptHost,
  type SkillScriptSetup,
} from './skill-script.js';
import type { EngineRunRequest } from './port.js';

const CONFIG = '.engine-config';

/** The POSIX half of `node:path` these tests need, for absolute paths without dot segments. */
const posixPath: SkillScriptHost['path'] = {
  join: (...segments) => segments.join('/').replace(/\/+/gu, '/'),
  isAbsolute: (path) => path.startsWith('/'),
  relative: (from, to) => {
    const a = from.split('/');
    const b = to.split('/');
    let common = 0;
    while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
    return [...a.slice(common).map(() => '..'), ...b.slice(common)].join('/');
  },
};

type Recorded = {
  file: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  killSignal: string;
};

function fakeHost(
  options: {
    readonly realpaths?: Readonly<Record<string, string>>;
    readonly existing?: readonly string[];
    readonly exec?: () => Promise<{ stdout: string; stderr: string }>;
  } = {},
): { readonly host: SkillScriptHost; readonly calls: Recorded[]; readonly removed: string[] } {
  const calls: Recorded[] = [];
  const removed: string[] = [];
  const existing = new Set(
    options.existing ?? [
      '/work',
      '/work/.engine-config/skills/review/scripts',
      '/work/.engine-config/skills/review/scripts/check.mjs',
    ],
  );
  const host: SkillScriptHost = {
    execPath: '/usr/bin/node',
    realpath: (path) => {
      const mapped = options.realpaths?.[path];
      if (mapped !== undefined) return Promise.resolve(mapped);
      return existing.has(path)
        ? Promise.resolve(path)
        : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    },
    execFile: (file, args, execOptions) => {
      calls.push({
        file,
        args,
        cwd: execOptions.cwd,
        env: { ...execOptions.env },
        killSignal: execOptions.killSignal,
      });
      return (options.exec ?? (() => Promise.resolve({ stdout: 'ok', stderr: '' })))();
    },
    path: posixPath,
    makeScratchDirectory: () => Promise.resolve('/scratch/call-1'),
    removeDirectory: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { host, calls, removed };
}

const SETUP: SkillScriptSetup = {
  cwd: '/work',
  skillsDirectory: `${CONFIG}/skills`,
  skills: [{ name: 'review', scripts: ['check.mjs'] }],
  writable: ['drafts'],
};

function request(
  overrides: {
    readonly runCommands?: boolean;
    readonly writeFiles?: boolean;
    readonly skills?: EngineRunRequest['resources']['skills'];
    readonly files?: EngineRunRequest['resources']['files'];
    readonly policy?: EngineRunRequest['portable']['skills'];
  } = {},
): Pick<EngineRunRequest, 'cwd' | 'portable' | 'resources'> {
  return {
    cwd: '/work/',
    portable: {
      name: 'a',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: overrides.writeFiles ?? true,
        runCommands: overrides.runCommands ?? true,
        unrestrictedNetwork: false,
      },
      skills: overrides.policy ?? { mode: 'all' },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    resources: {
      files: overrides.files ?? [
        { kind: 'directory', path: 'contracts', access: 'read' },
        { kind: 'directory', path: 'drafts', access: 'read-write' },
      ],
      skills: overrides.skills ?? [
        { name: 'review', files: [{ path: 'scripts/check.mjs', contentBase64: 'eA==' }] },
        { name: 'prose', files: [{ path: 'SKILL.md', contentBase64: 'eA==' }] },
      ],
    },
  };
}

describe('skillScriptSetup: when the tool is offered', () => {
  it('is offered with runCommands and a skill that ships a script, under a read-only grant', () => {
    expect(skillScriptSetup(request(), CONFIG)).toEqual({
      cwd: '/work',
      skillsDirectory: '.engine-config/skills',
      skills: [{ name: 'review', scripts: ['check.mjs'] }],
      writable: ['drafts'],
    });
  });

  it('lists only the direct, sorted, unique file names under scripts/ of each skill', () => {
    const files = (...paths: string[]) => paths.map((path) => ({ path, contentBase64: 'eA==' }));
    const setup = skillScriptSetup(
      request({
        skills: [
          {
            name: 'review',
            files: files('scripts/b.mjs', 'scripts/a.mjs', 'scripts/lib/u.mjs', 'SKILL.md'),
          },
          { name: 'nested', files: files('scripts/lib/u.mjs') },
        ],
      }),
      CONFIG,
    );
    expect(setup?.skills).toEqual([
      { name: 'review', scripts: ['a.mjs', 'b.mjs'] },
      { name: 'nested', scripts: [] },
    ]);
  });

  it('describes each skill with its scripts and tells the model to read the skill first', () => {
    const description = skillScriptToolDescription({
      ...SETUP,
      skills: [
        { name: 'review', scripts: ['check.mjs', 'lint.mjs'] },
        { name: 'office-reader', scripts: [] },
      ],
    });
    expect(description).toContain(
      'Scripts by skill: review (check.mjs, lint.mjs); office-reader (none directly in scripts/).',
    );
    expect(description).toContain(
      "Read the skill (its SKILL.md) for a script's arguments before the first call.",
    );
  });

  it('lists at most 20 scripts per skill, then how many more', () => {
    const scripts = Array.from(
      { length: 25 },
      (_, index) => `s${String(index).padStart(2, '0')}.mjs`,
    );
    const description = skillScriptToolDescription({
      ...SETUP,
      skills: [{ name: 'many', scripts }],
    });
    expect(description).toContain(`many (${scripts.slice(0, 20).join(', ')}, +5 more).`);
    expect(description).not.toContain('s20.mjs');
  });

  it('is absent when runCommands is off', () => {
    expect(skillScriptSetup(request({ runCommands: false }), CONFIG)).toBeNull();
  });

  it('is absent when no granted skill ships a script', () => {
    expect(skillScriptSetup(request({ skills: [] }), CONFIG)).toBeNull();
    expect(
      skillScriptSetup(
        request({ skills: [{ name: 'p', files: [{ path: 'SKILL.md', contentBase64: 'eA==' }] }] }),
        CONFIG,
      ),
    ).toBeNull();
  });

  it('honours a skill allowlist', () => {
    expect(
      skillScriptSetup(request({ policy: { mode: 'allowlist', names: ['prose'] } }), CONFIG),
    ).toBeNull();
  });

  it('names no writable path unless writeFiles is on, and never a read-only grant', () => {
    expect(skillScriptSetup(request({ writeFiles: false }), CONFIG)?.writable).toEqual([]);
    expect(skillScriptSetup(request(), CONFIG)?.writable).not.toContain('contracts');
  });
});

describe('parseRunSkillScriptInput', () => {
  it('accepts the three fields, with args defaulting to none', () => {
    expect(parseRunSkillScriptInput({ skill: 'review', script: 'check.mjs' })).toEqual({
      ok: true,
      input: { skill: 'review', script: 'check.mjs', args: [] },
    });
  });

  it.each([
    ['a non-object', 'x'],
    ['an array', []],
    ['an unknown key', { skill: 's', script: 'a', cwd: '/' }],
    ['a non-string skill', { skill: 1, script: 'a' }],
    ['non-string args', { skill: 's', script: 'a', args: [1] }],
    ['args that are not an array', { skill: 's', script: 'a', args: 'x' }],
    ['too many args', { skill: 's', script: 'a', args: Array(65).fill('x') }],
    ['an oversize arg', { skill: 's', script: 'a', args: ['x'.repeat(8 * 1024 + 1)] }],
    ['a NUL in an arg', { skill: 's', script: 'a', args: ['a\0b'] }],
  ])('refuses %s as unusable_arguments', (_name, input) => {
    expect(parseRunSkillScriptInput(input)).toMatchObject({
      ok: false,
      refusal: 'unusable_arguments',
    });
  });

  it('declares the same fields as the JSON schema adapters validate against', () => {
    expect(Object.keys(RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA.properties)).toEqual([
      'skill',
      'script',
      'args',
    ]);
  });
});

describe('runSkillScript', () => {
  it('runs node under --permission with read on the root and write on the scratch and the writable grants only', async () => {
    const { host, calls, removed } = fakeHost();
    const outcome = await runSkillScript(host, SETUP, {
      skill: 'review',
      script: 'check.mjs',
      args: ['a.docx', '--flag'],
    });
    expect(outcome).toEqual({ ok: true, exitCode: 0, stdout: 'ok', stderr: '' });
    expect(calls).toEqual([
      {
        file: '/usr/bin/node',
        args: [
          '--permission',
          '--allow-fs-read=/work',
          '--allow-fs-read=/scratch/call-1',
          '--allow-fs-write=/scratch/call-1',
          '--allow-fs-write=/work/drafts',
          '/work/.engine-config/skills/review/scripts/check.mjs',
          'a.docx',
          '--flag',
        ],
        cwd: '/work',
        env: { TMPDIR: '/scratch/call-1' },
        killSignal: 'SIGKILL',
      },
    ]);
    expect(removed).toEqual(['/scratch/call-1']);
  });

  it('never puts a read-only path in --allow-fs-write', async () => {
    const { host, calls } = fakeHost();
    await runSkillScript(
      host,
      { ...SETUP, writable: [] },
      { skill: 'review', script: 'check.mjs', args: [] },
    );
    const writes = calls[0]?.args.filter((arg) => arg.startsWith('--allow-fs-write')) ?? [];
    expect(writes).toEqual(['--allow-fs-write=/scratch/call-1']);
  });

  it('refuses a skill the run does not grant scripts for', async () => {
    const { host, calls } = fakeHost();
    expect(
      await runSkillScript(host, SETUP, { skill: 'prose', script: 'x.mjs', args: [] }),
    ).toMatchObject({
      ok: false,
      refusal: 'unknown_skill',
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['../x.mjs', 'outside_skill_directory'],
    ['sub/x.mjs', 'outside_skill_directory'],
    ['..', 'outside_skill_directory'],
    ['.', 'outside_skill_directory'],
    ['a\\b.mjs', 'outside_skill_directory'],
    ['/etc/passwd', 'outside_skill_directory'],
    ['', 'unusable_script'],
    ['a\0.mjs', 'unusable_script'],
  ])('refuses the script name %j as %s before touching the disk', async (script, refusal) => {
    const { host, calls } = fakeHost();
    expect(await runSkillScript(host, SETUP, { skill: 'review', script, args: [] })).toMatchObject({
      ok: false,
      refusal,
    });
    expect(calls).toEqual([]);
  });

  it('refuses a script the skill does not ship as unusable_script, listing the ones it does', async () => {
    const { host } = fakeHost();
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'missing.mjs', args: [] }),
    ).toMatchObject({
      ok: false,
      refusal: 'unusable_script',
      reason: 'skill "review" has no "scripts/missing.mjs". Available: check.mjs.',
    });
  });

  it('says so when the skill ships no script directly in scripts/', async () => {
    const { host } = fakeHost();
    const outcome = await runSkillScript(
      host,
      { ...SETUP, skills: [{ name: 'review', scripts: [] }] },
      { skill: 'review', script: 'missing.mjs', args: [] },
    );
    expect(outcome).toMatchObject({
      ok: false,
      refusal: 'unusable_script',
      reason: expect.stringContaining('ships no script directly') as unknown,
    });
  });

  it('keeps naming the skills that have scripts when the skill is unknown', async () => {
    const { host } = fakeHost();
    expect(
      await runSkillScript(host, SETUP, { skill: 'other', script: 'a.mjs', args: [] }),
    ).toMatchObject({
      refusal: 'unknown_skill',
      reason: expect.stringContaining('Skills with scripts: review.') as unknown,
    });
  });

  it('refuses a script that is a link to a file outside scripts/', async () => {
    const { host, calls } = fakeHost({
      realpaths: { '/work/.engine-config/skills/review/scripts/check.mjs': '/etc/hosts' },
    });
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
    expect(calls).toEqual([]);
  });

  it("refuses a link to another skill's script, which is inside the skills directory but not this scripts/", async () => {
    const { host } = fakeHost({
      realpaths: {
        '/work/.engine-config/skills/review/scripts/check.mjs':
          '/work/.engine-config/skills/other/scripts/x.mjs',
      },
    });
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
  });

  it('refuses a scripts/ directory that is itself a link out, via the script it holds', async () => {
    const { host } = fakeHost({
      realpaths: {
        '/work/.engine-config/skills/review/scripts': '/elsewhere/scripts',
        '/work/.engine-config/skills/review/scripts/check.mjs': '/elsewhere/other/check.mjs',
      },
    });
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
  });

  it('refuses a scripts/ directory that is a link out even when the script sits inside its target', async () => {
    const { host, calls } = fakeHost({
      realpaths: {
        '/work/.engine-config/skills/review/scripts': '/elsewhere/scripts',
        '/work/.engine-config/skills/review/scripts/check.mjs': '/elsewhere/scripts/check.mjs',
      },
    });
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
    expect(calls).toEqual([]);
  });

  it('maps a host timeout to timeout and an overflow to output_too_large, and cleans up', async () => {
    const timeout = fakeHost({
      exec: () =>
        Promise.reject(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' })),
    });
    expect(
      await runSkillScript(timeout.host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toMatchObject({ ok: false, refusal: 'timeout' });
    expect(timeout.removed).toEqual(['/scratch/call-1']);

    const overflow = fakeHost({
      exec: () =>
        Promise.reject(
          Object.assign(new Error('x'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            killed: true,
          }),
        ),
    });
    expect(
      await runSkillScript(overflow.host, SETUP, {
        skill: 'review',
        script: 'check.mjs',
        args: [],
      }),
    ).toMatchObject({ ok: false, refusal: 'output_too_large' });
  });

  it("returns a non-zero exit as the script's answer, not as a refusal", async () => {
    const { host } = fakeHost({
      exec: () =>
        Promise.reject(Object.assign(new Error('x'), { code: 3, stdout: 'o', stderr: 'bad' })),
    });
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toEqual({ ok: true, exitCode: 3, stdout: 'o', stderr: 'bad' });
  });

  it("returns a death by signal as the script's answer, 128 + n, with no host text", async () => {
    const { host } = fakeHost({
      exec: () =>
        Promise.reject(
          Object.assign(new Error('Command failed: /usr/bin/node --permission /work/x'), {
            code: null,
            killed: false,
            signal: 'SIGABRT',
            stdout: 'o',
            stderr: 'core',
          }),
        ),
    });
    expect(
      await runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).toEqual({
      ok: true,
      exitCode: 134,
      stdout: 'o',
      stderr: 'core\nthe script was ended by SIGABRT.\n',
    });
  });

  it("forwards the run's signal to the host and propagates its abort", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const { host, removed } = fakeHost();
    const aborting: SkillScriptHost = {
      ...host,
      execFile: (_file, _args, options) => {
        seen = options.signal;
        return Promise.reject(
          Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' }),
        );
      },
    };
    controller.abort();
    await expect(
      runSkillScript(
        aborting,
        SETUP,
        { skill: 'review', script: 'check.mjs', args: [] },
        SKILL_SCRIPT_LIMITS,
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
    expect(seen).toBe(controller.signal);
    expect(removed).toEqual(['/scratch/call-1']);
  });

  it("propagates a host failure that is not the script's (the binary would not start)", async () => {
    const { host, removed } = fakeHost({
      exec: () => Promise.reject(Object.assign(new Error('spawn'), { code: 'ENOENT' })),
    });
    await expect(
      runSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs', args: [] }),
    ).rejects.toThrow('spawn');
    expect(removed).toEqual(['/scratch/call-1']);
  });
});

describe('executeRunSkillScript', () => {
  it('turns a refusal into error text that names it, and an exit 0 into plain text', async () => {
    const { host } = fakeHost();
    const refused = await executeRunSkillScript(host, SETUP, { skill: 'review', script: '../x' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('outside_skill_directory');
    expect(
      await executeRunSkillScript(host, SETUP, { skill: 'review', script: 'check.mjs' }),
    ).toEqual({
      text: 'exit code 0\n\nstdout:\nok',
      isError: false,
    });
  });

  it('reports the limits it applies', () => {
    expect(SKILL_SCRIPT_LIMITS).toMatchObject({ timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
  });
});
