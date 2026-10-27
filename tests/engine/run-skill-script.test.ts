/**
 * `run_skill_script` against a real process and a real disk (ADR-0137, #1089).
 *
 * `packages/engine/src/skill-script.test.ts` proves the decisions over a fake host. What only a
 * real `node --permission` can answer is here: that a read-only grant is readable and never
 * writable, that a script cannot make a link or start a program, and that a runaway script and a
 * flood of output are stopped. The host is the Claude adapter's; the other two are byte-for-byte
 * the same ten lines.
 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeSkillScriptHost } from '@agent-workspace/engine-claude-agent-sdk/testing';
import {
  SKILL_SCRIPT_LIMITS,
  runSkillScript,
  type SkillScriptOutcome,
  type SkillScriptSetup,
} from '@agent-workspace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SKILLS = '.claude/skills';

let root = '';

function write(relative: string, content: string): void {
  const target = join(root, relative);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function setup(writable: readonly string[] = []): SkillScriptSetup {
  return {
    cwd: root,
    skillsDirectory: SKILLS,
    skills: [{ name: 'review', scripts: ['a.mjs'] }],
    writable,
  };
}

function script(name: string, source: string): void {
  write(`${SKILLS}/review/scripts/${name}`, source);
}

async function run(
  name: string,
  args: readonly string[] = [],
  options: { writable?: readonly string[]; limits?: Partial<typeof SKILL_SCRIPT_LIMITS> } = {},
): Promise<SkillScriptOutcome> {
  return runSkillScript(
    nodeSkillScriptHost,
    setup(options.writable),
    { skill: 'review', script: name, args },
    { ...SKILL_SCRIPT_LIMITS, ...options.limits },
  );
}

function answered(outcome: SkillScriptOutcome): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  if (!outcome.ok) throw new Error(`refused: ${outcome.refusal}: ${outcome.reason}`);
  return outcome;
}

function readable(path: string): string | null {
  try {
    const content = readFileSync(path, 'utf8');
    return content.length === 0 ? null : content;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A script that tries `body` and prints the error code it gets, or `OK`. */
function attempt(body: string): string {
  return `import fs from 'node:fs';
try { ${body}; console.log('OK'); } catch (error) { console.log(error.code ?? String(error)); }
`;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'run-skill-script-')));
  write('contracts/signed.txt', 'original');
  mkdirSync(join(root, 'drafts'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a read-only grant is readable and never writable', () => {
  it('(a) reads a file under the grant and returns its output', async () => {
    script(
      'read.mjs',
      `import fs from 'node:fs';\nconsole.log(fs.readFileSync(process.argv[2], 'utf8'));\n`,
    );
    const result = answered(await run('read.mjs', ['contracts/signed.txt']));
    expect(result).toMatchObject({ exitCode: 0, stdout: 'original\n' });
  });

  it('(b) refuses a write, an append, a delete and a rename with ERR_ACCESS_DENIED, and leaves the bytes', async () => {
    const target = 'contracts/signed.txt';
    for (const body of [
      `fs.writeFileSync('${target}', 'pwn')`,
      `fs.appendFileSync('${target}', 'pwn')`,
      `fs.unlinkSync('${target}')`,
      `fs.renameSync('${target}', 'drafts/moved.txt')`,
      `fs.writeFileSync('contracts/new.txt', 'pwn')`,
    ]) {
      script('write.mjs', attempt(body));
      expect(answered(await run('write.mjs')).stdout.trim(), body).toBe('ERR_ACCESS_DENIED');
    }
    expect(readFileSync(join(root, target), 'utf8')).toBe('original');
  });

  it('(b) refuses a write to a path outside the run directory', async () => {
    script(
      'outside.mjs',
      attempt(
        `fs.writeFileSync(${JSON.stringify(join(tmpdir(), 'run-skill-script-outside'))}, 'pwn')`,
      ),
    );
    expect(answered(await run('outside.mjs')).stdout.trim()).toBe('ERR_ACCESS_DENIED');
  });

  it('writes nowhere in the run directory unless a read-write grant is named', async () => {
    script('draft.mjs', attempt(`fs.writeFileSync('drafts/out.txt', 'x')`));
    expect(answered(await run('draft.mjs')).stdout.trim()).toBe('ERR_ACCESS_DENIED');
    expect(answered(await run('draft.mjs', [], { writable: ['drafts'] })).stdout.trim()).toBe('OK');
    expect(readFileSync(join(root, 'drafts/out.txt'), 'utf8')).toBe('x');
  });

  it('writes to its own temporary directory, which is gone after the call', async () => {
    script(
      'tmp.mjs',
      `import fs from 'node:fs';\nconst file = process.env.TMPDIR + '/note.txt';\nfs.writeFileSync(file, 'x');\nconsole.log(file);\n`,
    );
    const { stdout } = answered(await run('tmp.mjs'));
    expect(() => readFileSync(stdout.trim(), 'utf8')).toThrow();
  });

  it('(b′) cannot make a hard link or a symbolic link to a read-only file', async () => {
    script('hard.mjs', attempt(`fs.linkSync('contracts/signed.txt', 'drafts/hard.txt')`));
    script(
      'soft.mjs',
      attempt(
        `fs.symlinkSync(${JSON.stringify(join(root, 'contracts/signed.txt'))}, 'drafts/soft.txt')`,
      ),
    );
    for (const name of ['hard.mjs', 'soft.mjs']) {
      expect(answered(await run(name, [], { writable: ['drafts'] })).stdout.trim(), name).toBe(
        'ERR_ACCESS_DENIED',
      );
    }
    expect(() => readFileSync(join(root, 'drafts/hard.txt'))).toThrow();
    expect(() => readFileSync(join(root, 'drafts/soft.txt'))).toThrow();
  });

  it('(b′) pins the documented residual: a link that already exists in a writable grant is followed', async () => {
    // Node follows links that are already on the disk. Nothing in a run can create one — the test
    // above — and the runner refuses to place one, so this is the case ADR-0137 accepts and names.
    symlinkSync(join(root, 'contracts/signed.txt'), join(root, 'drafts/pre-existing'));
    script('through.mjs', attempt(`fs.writeFileSync('drafts/pre-existing', 'pwn')`));
    expect(answered(await run('through.mjs', [], { writable: ['drafts'] })).stdout.trim()).toBe(
      'OK',
    );
    expect(readFileSync(join(root, 'contracts/signed.txt'), 'utf8')).toBe('pwn');
  });

  it('(b′) does not write through that link when the grant is not writable', async () => {
    symlinkSync(join(root, 'contracts/signed.txt'), join(root, 'drafts/pre-existing'));
    script('through.mjs', attempt(`fs.writeFileSync('drafts/pre-existing', 'pwn')`));
    expect(answered(await run('through.mjs')).stdout.trim()).toBe('ERR_ACCESS_DENIED');
    expect(readFileSync(join(root, 'contracts/signed.txt'), 'utf8')).toBe('original');
  });
});

describe('which file may run', () => {
  it('(c) refuses ../x.mjs as outside_skill_directory, and does not run it', async () => {
    write(`${SKILLS}/review/x.mjs`, `console.log('ran');\n`);
    expect(await run('../x.mjs')).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
  });

  it('(c) refuses a script that is a link to a file outside scripts/', async () => {
    write('elsewhere/x.mjs', `console.log('ran');\n`);
    mkdirSync(join(root, SKILLS, 'review/scripts'), { recursive: true });
    symlinkSync(join(root, 'elsewhere/x.mjs'), join(root, SKILLS, 'review/scripts/link.mjs'));
    expect(await run('link.mjs')).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
  });

  it('refuses a scripts/ directory that is a link to a directory outside the skill', async () => {
    write('elsewhere/x.mjs', `console.log('ran');\n`);
    mkdirSync(join(root, SKILLS, 'review'), { recursive: true });
    // 'junction' is ignored off Windows, and on Windows needs no privilege a directory symlink does.
    symlinkSync(join(root, 'elsewhere'), join(root, SKILLS, 'review/scripts'), 'junction');
    expect(await run('x.mjs')).toMatchObject({ ok: false, refusal: 'outside_skill_directory' });
  });

  it('refuses a skill the run does not grant, and a script the skill does not ship', async () => {
    script('a.mjs', `console.log('a');\n`);
    expect(
      await runSkillScript(nodeSkillScriptHost, setup(), {
        skill: 'other',
        script: 'a.mjs',
        args: [],
      }),
    ).toMatchObject({ ok: false, refusal: 'unknown_skill' });
    expect(await run('missing.mjs')).toMatchObject({
      ok: false,
      refusal: 'unusable_script',
      reason: expect.stringContaining('Available: a.mjs.') as unknown,
    });
  });

  it('returns a non-zero exit, with its output, as the script’s own answer', async () => {
    script('fail.mjs', `console.error('no such clause');\nprocess.exit(3);\n`);
    expect(answered(await run('fail.mjs'))).toMatchObject({
      exitCode: 3,
      stderr: 'no such clause\n',
    });
  });

  it('passes arguments as arguments: no shell expands them', async () => {
    script('args.mjs', `console.log(JSON.stringify(process.argv.slice(2)));\n`);
    const { stdout } = answered(await run('args.mjs', ['$HOME', '*', 'a b', '; echo hi', '`id`']));
    expect(JSON.parse(stdout)).toEqual(['$HOME', '*', 'a b', '; echo hi', '`id`']);
  });

  it('gives the script an empty environment but TMPDIR', async () => {
    script('env.mjs', `console.log(Object.keys(process.env).sort().join(','));\n`);
    const keys = answered(await run('env.mjs'))
      .stdout.trim()
      .split(',');
    if (process.platform === 'win32') {
      // libuv adds the variables Windows needs to start a process (uv_spawn's `required_vars`).
      const libuv = new Set([
        'SYSTEMROOT',
        'SYSTEMDRIVE',
        'TEMP',
        'PATH',
        'USERPROFILE',
        'WINDIR',
        'HOMEDRIVE',
        'HOMEPATH',
        'LOGONSERVER',
        'USERDOMAIN',
        'USERNAME',
      ]);
      expect(keys).toContain('TMPDIR');
      expect(keys.filter((key) => key !== 'TMPDIR' && !libuv.has(key.toUpperCase()))).toEqual([]);
    } else {
      expect(keys).toEqual(['TMPDIR']);
    }
  });
});

describe('what a script may not do', () => {
  it('(e) cannot start a program', async () => {
    script(
      'spawn.mjs',
      `import cp from 'node:child_process';
try { cp.execFileSync(${JSON.stringify(process.execPath)}, ['-e', '0']); console.log('OK'); } catch (error) { console.log(error.code ?? String(error)); }
`,
    );
    expect(answered(await run('spawn.mjs')).stdout.trim()).toBe('ERR_ACCESS_DENIED');
  });

  it('(e) cannot start a worker', async () => {
    script(
      'worker.mjs',
      `import { Worker } from 'node:worker_threads';
try { new Worker('1', { eval: true }); console.log('OK'); } catch (error) { console.log(error.code ?? String(error)); }
`,
    );
    expect(answered(await run('worker.mjs')).stdout.trim()).toBe('ERR_ACCESS_DENIED');
  });

  it('(d) stops a script that never ends: timeout', async () => {
    script('loop.mjs', 'while (true) {}\n');
    expect(await run('loop.mjs', [], { limits: { timeoutMs: 700 } })).toMatchObject({
      ok: false,
      refusal: 'timeout',
    });
  });

  it('(d) stops a script that traps SIGTERM and never ends: timeout', async () => {
    script('trap.mjs', `process.on('SIGTERM', () => {});\nwhile (true) {}\n`);
    expect(await run('trap.mjs', [], { limits: { timeoutMs: 700 } })).toMatchObject({
      ok: false,
      refusal: 'timeout',
    });
  });

  it('(d) stops a script that traps SIGTERM and floods stdout: output_too_large', async () => {
    script(
      'trap-flood.mjs',
      `process.on('SIGTERM', () => {});\nfor (;;) process.stdout.write('x'.repeat(10_000));\n`,
    );
    expect(await run('trap-flood.mjs', [], { limits: { maxOutputBytes: 10_000 } })).toMatchObject({
      ok: false,
      refusal: 'output_too_large',
    });
  });

  it('returns a script that aborts itself as its own answer (exit 128 + SIGABRT on POSIX)', async () => {
    script('abort.mjs', `console.log('before');\nprocess.abort();\n`);
    const outcome = answered(await run('abort.mjs'));
    expect(outcome.stdout).toBe('before\n');
    expect(outcome.stderr).not.toContain('--permission');
    if (process.platform === 'win32') {
      // Windows has no signals: the process ends with the C runtime's abort status, not SIGABRT.
      expect(outcome.exitCode).not.toBe(0);
    } else {
      expect(outcome.exitCode).toBe(134);
      expect(outcome.stderr).toContain('the script was ended by SIGABRT.');
    }
  });

  it("stops a running script that traps SIGTERM when the run's signal aborts", async () => {
    mkdirSync(join(root, 'out'));
    script(
      'pid.mjs',
      `import fs from 'node:fs';\nprocess.on('SIGTERM', () => {});\nfs.writeFileSync('out/pid', String(process.pid));\nwhile (true) {}\n`,
    );
    const controller = new AbortController();
    const pending = runSkillScript(
      nodeSkillScriptHost,
      setup(['out']),
      { skill: 'review', script: 'pid.mjs', args: [] },
      SKILL_SCRIPT_LIMITS,
      controller.signal,
    );
    const pidFile = join(root, 'out/pid');
    const started = Date.now();
    while (readable(pidFile) === null && Date.now() - started < 10_000) await sleep(50);
    const pid = Number(readable(pidFile));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(alive(pid)).toBe(false);
  });

  it('the host rejects an aborted call only after the killed process has exited', async () => {
    write(
      'host/pid.mjs',
      `import fs from 'node:fs';\nprocess.on('SIGTERM', () => {});\nfs.writeFileSync('pid', String(process.pid));\nwhile (true) {}\n`,
    );
    const cwd = join(root, 'host');
    const controller = new AbortController();
    const pending = nodeSkillScriptHost.execFile(nodeSkillScriptHost.execPath, ['pid.mjs'], {
      cwd,
      timeout: 60_000,
      maxBuffer: 1_000_000,
      env: {},
      killSignal: 'SIGKILL',
      signal: controller.signal,
    });
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    const started = Date.now();
    while (readable(join(cwd, 'pid')) === null && Date.now() - started < 10_000) await sleep(50);
    const pid = Number(readable(join(cwd, 'pid')));
    controller.abort();
    expect(await settled).toMatchObject({ code: 'ABORT_ERR' });
    expect(alive(pid)).toBe(false);
  });

  it('(d) stops a script that floods stdout: output_too_large', async () => {
    script('flood.mjs', `process.stdout.write('x'.repeat(200_000));\n`);
    expect(await run('flood.mjs', [], { limits: { maxOutputBytes: 10_000 } })).toMatchObject({
      ok: false,
      refusal: 'output_too_large',
    });
  });

  it('keeps a script a user cannot execute runnable: it needs no execute bit', async () => {
    script('plain.mjs', `console.log('ok');\n`);
    chmodSync(join(root, SKILLS, 'review/scripts/plain.mjs'), 0o444);
    expect(answered(await run('plain.mjs')).stdout.trim()).toBe('ok');
  });
});

describe('hard links made by the harness', () => {
  it('a hard link already in a writable grant shares the inode, which the model cannot create', async () => {
    // Documents why (b′) matters: a link to a read-only file inside a writable directory is a write
    // path. A run cannot make one, so only an operator or an uploaded archive could.
    linkSync(join(root, 'contracts/signed.txt'), join(root, 'drafts/hard.txt'));
    script('hard.mjs', attempt(`fs.writeFileSync('drafts/hard.txt', 'pwn')`));
    expect(answered(await run('hard.mjs', [], { writable: ['drafts'] })).stdout.trim()).toBe('OK');
    expect(readFileSync(join(root, 'contracts/signed.txt'), 'utf8')).toBe('pwn');
  });
});
