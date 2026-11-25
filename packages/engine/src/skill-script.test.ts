/**
 * `run_skill_script`'s decisions, over a fake host. The real process — the permission model refusing
 * a write, a symlink escape on a real disk — is `tests/engine/run-skill-script.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import {
  BUILTIN_IMPORTS,
  BUILTIN_SKILL_PACKAGE,
  RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA,
  SKILL_SCRIPT_INPUT_ENV,
  SKILL_SCRIPT_LIMITS,
  builtinImportHook,
  executeRunSkillScript,
  parseRunSkillScriptInput,
  runSkillScript,
  skillScriptSetup,
  skillScriptToolDescription,
  type SkillScriptHost,
  type SkillScriptSetup,
} from './skill-script.js';
import { engineFrameBuilder } from './frames.js';
import type { EngineRunRequest } from './port.js';
import { createToolAnswers, type ToolAnswers } from './tool-answers.js';

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
    readonly makeDirectory?: (path: string) => Promise<void>;
    /** Paths whose `realpath` fails with something other than a missing file. */
    readonly unreadable?: readonly string[];
  } = {},
): {
  readonly host: SkillScriptHost;
  readonly calls: Recorded[];
  readonly removed: string[];
  readonly made: string[];
  readonly written: { readonly path: string; readonly content: string }[];
} {
  const calls: Recorded[] = [];
  const removed: string[] = [];
  const made: string[] = [];
  const written: { path: string; content: string }[] = [];
  let scratches = 0;
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
      if (options.unreadable?.includes(path) === true)
        return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
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
    makeScratchDirectory: () => {
      scratches += 1;
      return Promise.resolve(`/scratch/call-${String(scratches)}`);
    },
    writeFile: (path, content) => {
      written.push({ path, content });
      return Promise.resolve();
    },
    makeDirectory: (path) => {
      made.push(path);
      return (options.makeDirectory ?? (() => Promise.resolve()))(path);
    },
    removeDirectory: (path) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return { host, calls, removed, made, written };
}

const SETUP: SkillScriptSetup = {
  cwd: '/work',
  skillsDirectory: `${CONFIG}/skills`,
  skills: [{ name: 'review', scripts: ['check.mjs'] }],
  writable: ['drafts'],
  writableDirectories: ['drafts'],
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
      writable: ['drafts', 'outputs'],
      writableDirectories: ['drafts', 'outputs'],
    });
  });

  it('names a read-write file grant writable, but never a directory to make', () => {
    const setup = skillScriptSetup(
      request({
        files: [
          { kind: 'file', path: '.agent-memory/notes.md', access: 'read-write' },
          { kind: 'directory', path: 'drafts', access: 'read-write' },
        ],
      }),
      CONFIG,
    );
    expect(setup?.writable).toEqual(['.agent-memory/notes.md', 'drafts', 'outputs']);
    expect(setup?.writableDirectories).toEqual(['drafts', 'outputs']);
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

  it('lets a writeFiles agent write outputs/, where the run collects its files', () => {
    expect(skillScriptSetup(request(), CONFIG)?.writable).toContain('outputs');
    expect(skillScriptSetup(request({ writeFiles: false }), CONFIG)?.writable).not.toContain(
      'outputs',
    );
  });

  it.each(['outputs', 'outputs/reference', './outputs/x/'])(
    'does not name outputs/ when the read-only grant %s is outputs or lies under it',
    (path) => {
      const writable = skillScriptSetup(
        request({ files: [{ kind: 'directory', path, access: 'read' }] }),
        CONFIG,
      )?.writable;
      expect(writable).toEqual([]);
    },
  );

  it('compares outputs/ with a read-only grant by segment, not by prefix', () => {
    expect(
      skillScriptSetup(
        request({ files: [{ kind: 'directory', path: 'outputs-archive', access: 'read' }] }),
        CONFIG,
      )?.writable,
    ).toEqual(['outputs']);
  });

  it('does not name outputs/ when a grant does not normalise', () => {
    expect(
      skillScriptSetup(
        request({ files: [{ kind: 'directory', path: '/etc', access: 'read-write' }] }),
        CONFIG,
      )?.writable,
    ).toEqual([]);
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
      'input',
    ]);
    expect(RUN_SKILL_SCRIPT_INPUT_JSON_SCHEMA.properties.input).toMatchObject({
      required: ['fromToolUse'],
      additionalProperties: false,
    });
  });

  it('accepts a reference to an earlier tool call, and reads null or no input as none', () => {
    const call = { skill: 'review', script: 'check.mjs' };
    expect(parseRunSkillScriptInput({ ...call, input: { fromToolUse: 'toolu_1' } })).toEqual({
      ok: true,
      input: { ...call, args: [], fromToolUse: 'toolu_1' },
    });
    expect(parseRunSkillScriptInput({ ...call, input: null, args: null })).toEqual({
      ok: true,
      input: { ...call, args: [] },
    });
  });

  it.each([
    ['a string input', 'toolu_1'],
    ['an input array', ['toolu_1']],
    ['an input with another key', { fromToolUse: 'toolu_1', path: '/etc/passwd' }],
    ['an input without the id', {}],
    ['a non-string id', { fromToolUse: 1 }],
    ['an empty id', { fromToolUse: '' }],
    ['an id with NUL', { fromToolUse: 'a\0b' }],
    ['an oversize id', { fromToolUse: 'x'.repeat(257) }],
  ])('refuses %s as unusable_arguments', (_name, input) => {
    expect(parseRunSkillScriptInput({ skill: 'review', script: 'check.mjs', input })).toMatchObject(
      { ok: false, refusal: 'unusable_arguments' },
    );
  });
});

describe('builtinImportHook', () => {
  const sourceOf = (argument: string): string => {
    const prefix = '--import=data:text/javascript,';
    expect(argument.startsWith(prefix)).toBe(true);
    return decodeURIComponent(argument.slice(prefix.length));
  };

  it('is one --import of a data: module that maps the built-in package to the placed skills', () => {
    const source = sourceOf(builtinImportHook('/work/.engine-config/skills'));
    expect(BUILTIN_SKILL_PACKAGE).toBe('@indx-workspace/builtin-skills');
    expect(source).toContain(`const root="/work/.engine-config/skills";`);
    expect(source).toContain(`const imports=${JSON.stringify(BUILTIN_IMPORTS)};`);
    expect(source).toContain(`createHash(`);
    expect(source).toContain(`const name="@indx-workspace/builtin-skills";`);
    expect(source).toContain('registerHooks({resolve(');
  });

  it('carries the skills directory as a JSON string, whatever characters it holds', () => {
    const root = String.raw`/work/it's "odd"\dir,%20`;
    expect(sourceOf(builtinImportHook(root))).toContain(`const root=${JSON.stringify(root)};`);
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
          builtinImportHook('/work/.engine-config/skills'),
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

  it('makes every writable directory before the process starts, so a missing outputs/ is a folder to Node', async () => {
    const order: string[] = [];
    const { host, made } = fakeHost({
      makeDirectory: (path) => {
        order.push(`mkdir ${path}`);
        return Promise.resolve();
      },
      exec: () => {
        order.push('exec');
        return Promise.resolve({ stdout: 'ok', stderr: '' });
      },
    });
    await runSkillScript(
      host,
      { ...SETUP, writable: ['drafts', 'outputs'], writableDirectories: ['drafts', 'outputs'] },
      { skill: 'review', script: 'check.mjs', args: [] },
    );
    expect(made).toEqual(['/work/drafts', '/work/outputs']);
    expect(order).toEqual(['mkdir /work/drafts', 'mkdir /work/outputs', 'exec']);
  });

  it('leaves a writable directory that cannot be made to the script, and still runs it', async () => {
    const { host, calls } = fakeHost({
      makeDirectory: () => Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' })),
    });
    const outcome = await runSkillScript(
      host,
      { ...SETUP, writable: ['outputs'], writableDirectories: ['outputs'] },
      { skill: 'review', script: 'check.mjs', args: [] },
    );
    expect(outcome).toEqual({ ok: true, exitCode: 0, stdout: 'ok', stderr: '' });
    expect(calls[0]?.args).toContain('--allow-fs-write=/work/outputs');
  });

  it('never makes a folder for a missing read-write file grant, though the script may write it', async () => {
    const { host, calls, made } = fakeHost();
    await runSkillScript(
      host,
      {
        ...SETUP,
        writable: ['.agent-memory/notes.md', 'outputs'],
        writableDirectories: ['outputs'],
      },
      { skill: 'review', script: 'check.mjs', args: [] },
    );
    expect(made).toEqual(['/work/outputs']);
    expect(calls[0]?.args).toContain('--allow-fs-write=/work/.agent-memory/notes.md');
  });

  it('makes nothing under a parent that resolves outside the run directory, or cannot be resolved', async () => {
    const { host, calls, made } = fakeHost({
      realpaths: { '/work/linked': '/etc', '/work/inside': '/work/inside' },
      unreadable: ['/work/locked'],
    });
    await runSkillScript(
      host,
      {
        ...SETUP,
        writable: ['linked/out', 'locked/out', 'inside/out'],
        writableDirectories: ['linked/out', 'locked/out', 'inside/out'],
      },
      { skill: 'review', script: 'check.mjs', args: [] },
    );
    expect(made).toEqual(['/work/inside/out']);
    expect(calls).toHaveLength(1);
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

describe('runSkillScript with a referenced tool answer (ADR-0176)', () => {
  const frames = engineFrameBuilder('demo');

  function answersHolding(
    ...held: readonly { id: string; name: string; output: string; isError?: boolean }[]
  ): ToolAnswers {
    const answers = createToolAnswers({ waitMs: 0, maxRetainedBytes: 1024 * 1024 });
    for (const answer of held) {
      answers.observe(
        frames.toolCall(
          {
            frame: 'agent.tool.call',
            toolCallId: answer.id,
            name: answer.name,
            kind: 'mcp',
            input: {},
          },
          null,
        ),
      );
      answers.observe(
        frames.toolResult(
          {
            frame: 'agent.tool.result',
            toolCallId: answer.id,
            status: 'completed',
            output: answer.output,
            isError: answer.isError ?? false,
          },
          null,
        ),
      );
    }
    return answers;
  }

  const CALL = { skill: 'review', script: 'check.mjs', args: ['--top', '5'] };

  it('writes the answer into a read-only directory of the call and names it in SKILL_SCRIPT_INPUT', async () => {
    const { host, calls, removed, written } = fakeHost();
    const answers = answersHolding({
      id: 'toolu_1',
      name: 'mcp__s__public_source',
      output: '{"a":1}',
    });
    const outcome = await runSkillScript(
      host,
      SETUP,
      { ...CALL, fromToolUse: 'toolu_1' },
      SKILL_SCRIPT_LIMITS,
      undefined,
      answers,
    );
    expect(outcome).toEqual({ ok: true, exitCode: 0, stdout: 'ok', stderr: '' });
    expect(written).toEqual([{ path: '/scratch/call-2/tool-answer.txt', content: '{"a":1}' }]);
    expect(calls[0]?.args).toEqual([
      '--permission',
      '--allow-fs-read=/work',
      '--allow-fs-read=/scratch/call-1',
      '--allow-fs-read=/scratch/call-2',
      '--allow-fs-write=/scratch/call-1',
      '--allow-fs-write=/work/drafts',
      builtinImportHook('/work/.engine-config/skills'),
      '/work/.engine-config/skills/review/scripts/check.mjs',
      '--top',
      '5',
    ]);
    expect(calls[0]?.args.filter((arg) => arg.includes('call-2'))).toEqual([
      '--allow-fs-read=/scratch/call-2',
    ]);
    expect(calls[0]?.env).toEqual({
      TMPDIR: '/scratch/call-1',
      [SKILL_SCRIPT_INPUT_ENV]: '/scratch/call-2/tool-answer.txt',
    });
    expect(removed).toEqual(['/scratch/call-1', '/scratch/call-2']);
  });

  it('removes both directories when writing the answer fails, and propagates the failure', async () => {
    const { host, calls, removed } = fakeHost();
    const failing: typeof host = {
      ...host,
      writeFile: () => Promise.reject(new Error('disk full')),
    };
    await expect(
      runSkillScript(
        failing,
        SETUP,
        { ...CALL, fromToolUse: 'toolu_1' },
        SKILL_SCRIPT_LIMITS,
        undefined,
        answersHolding({ id: 'toolu_1', name: 't', output: 'x' }),
      ),
    ).rejects.toThrow('disk full');
    expect(calls).toEqual([]);
    expect(removed).toEqual(['/scratch/call-1', '/scratch/call-2']);
  });

  it('removes both directories after a timeout', async () => {
    const { host, removed } = fakeHost({
      exec: () => Promise.reject(Object.assign(new Error('killed'), { killed: true })),
    });
    const outcome = await runSkillScript(
      host,
      SETUP,
      { ...CALL, fromToolUse: 'toolu_1' },
      SKILL_SCRIPT_LIMITS,
      undefined,
      answersHolding({ id: 'toolu_1', name: 't', output: 'x' }),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: 'timeout' });
    expect(removed).toEqual(['/scratch/call-1', '/scratch/call-2']);
  });

  it('still removes the input directory when removing the scratch directory fails', async () => {
    const { host, removed } = fakeHost();
    const stuck: typeof host = {
      ...host,
      removeDirectory: (path) =>
        path === '/scratch/call-1' ? Promise.reject(new Error('busy')) : host.removeDirectory(path),
    };
    await expect(
      runSkillScript(
        stuck,
        SETUP,
        { ...CALL, fromToolUse: 'toolu_1' },
        SKILL_SCRIPT_LIMITS,
        undefined,
        answersHolding({ id: 'toolu_1', name: 't', output: 'x' }),
      ),
    ).rejects.toThrow('busy');
    expect(removed).toEqual(['/scratch/call-2']);
  });

  it('refuses an id this run received no answer to, naming the answers it holds, and runs nothing', async () => {
    const { host, calls } = fakeHost();
    const held = Array.from({ length: 22 }, (_, index) => ({
      id: `t${String(index)}`,
      name: index === 21 ? '' : 'lookup',
      output: 'x',
    }));
    const outcome = await runSkillScript(
      host,
      SETUP,
      { ...CALL, fromToolUse: 'toolu_other_run' },
      SKILL_SCRIPT_LIMITS,
      undefined,
      answersHolding(...held),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: 'unknown_tool_answer' });
    const reason = outcome.ok ? '' : outcome.reason;
    expect(reason).toContain('"toolu_other_run"');
    expect(reason).toContain('t2 (lookup)');
    expect(reason).toContain('t21 (unnamed)');
    expect(reason).not.toContain('t1 (');
    expect(calls).toEqual([]);
  });

  it('refuses a reference in a run that has received no answer, or keeps no record', async () => {
    const { host } = fakeHost();
    for (const answers of [answersHolding(), undefined]) {
      const outcome = await runSkillScript(
        host,
        SETUP,
        { ...CALL, fromToolUse: 'toolu_1' },
        SKILL_SCRIPT_LIMITS,
        undefined,
        answers,
      );
      expect(outcome).toEqual({
        ok: false,
        refusal: 'unknown_tool_answer',
        reason:
          'this run received no answer to a tool call "toolu_1". It has received no tool answer yet.',
      });
    }
  });

  it('refuses an error answer and one over maxInputBytes as unusable_tool_answer', async () => {
    const { host, calls } = fakeHost();
    const answers = answersHolding(
      { id: 'err', name: 'lookup', output: 'not found', isError: true },
      { id: 'big', name: 'lookup', output: 'éé' },
    );
    const refused = async (id: string) =>
      runSkillScript(
        host,
        SETUP,
        { ...CALL, fromToolUse: id },
        { ...SKILL_SCRIPT_LIMITS, maxInputBytes: 3 },
        undefined,
        answers,
      );
    expect(await refused('err')).toMatchObject({
      ok: false,
      refusal: 'unusable_tool_answer',
      reason: expect.stringContaining('is an error') as unknown,
    });
    expect(await refused('big')).toMatchObject({
      ok: false,
      refusal: 'unusable_tool_answer',
      reason: expect.stringContaining('is 4 bytes; a script may be handed at most 3') as unknown,
    });
    expect(calls).toEqual([]);
  });

  it('checks the skill and the script before it reads a reference', async () => {
    const { host } = fakeHost();
    const outcome = await runSkillScript(
      host,
      SETUP,
      { skill: 'other', script: 'check.mjs', args: [], fromToolUse: 'toolu_1' },
      SKILL_SCRIPT_LIMITS,
      undefined,
      answersHolding(),
    );
    expect(outcome).toMatchObject({ ok: false, refusal: 'unknown_skill' });
  });
});

describe('executeRunSkillScript', () => {
  it('hands the run’s answers to the call', async () => {
    const { host, written } = fakeHost();
    const answers = createToolAnswers({ waitMs: 0, maxRetainedBytes: 1024 });
    answers.observe(
      engineFrameBuilder('demo').toolResult(
        {
          frame: 'agent.tool.result',
          toolCallId: 'c',
          status: 'completed',
          output: 'v',
          isError: false,
        },
        null,
      ),
    );
    const result = await executeRunSkillScript(
      host,
      SETUP,
      { skill: 'review', script: 'check.mjs', input: { fromToolUse: 'c' } },
      undefined,
      answers,
    );
    expect(result.isError).toBe(false);
    expect(written).toEqual([{ path: '/scratch/call-2/tool-answer.txt', content: 'v' }]);
  });

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
    expect(SKILL_SCRIPT_LIMITS).toMatchObject({
      timeoutMs: 120_000,
      maxOutputBytes: 1024 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
    });
    expect(SKILL_SCRIPT_INPUT_ENV).toBe('SKILL_SCRIPT_INPUT');
  });
});
