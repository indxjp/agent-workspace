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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { nodeSkillScriptHost } from '@agent-workspace/engine-claude-agent-sdk/testing';
import { builtinSkillFiles } from '@agent-workspace/skills-office';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import {
  BUILTIN_IMPORTS,
  BUILTIN_SKILL_PACKAGE,
  SKILL_SCRIPT_INPUT_ENV,
  SKILL_SCRIPT_LIMITS,
  createToolAnswers,
  engineFrameBuilder,
  executeRunSkillScript,
  runSkillScript,
  type ToolAnswers,
  type SkillScriptOutcome,
  type SkillScriptSetup,
} from '@agent-workspace/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const SKILLS = '.claude/skills';

let root = '';

function write(relative: string, content: string | Buffer): void {
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
    writableDirectories: writable,
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

describe('a built-in skill’s module, imported by its package path (ADR-0173)', () => {
  const TABLE = `${BUILTIN_SKILL_PACKAGE}/office-reader/scripts/lib/table.mjs`;
  const CLI = `${BUILTIN_SKILL_PACKAGE}/office-reader/scripts/lib/cli.mjs`;

  /** Place the shipped office-reader as the runner would: beside the script's own skill. */
  function placeOfficeReader(): void {
    for (const file of builtinSkillFiles('office-reader'))
      write(`${SKILLS}/office-reader/${file.path}`, Buffer.from(file.contentBase64, 'base64'));
  }

  /** A use case's script: only its calculation, over the shipped table reader and command line. */
  const SUM = `import { readTable } from '${TABLE}';
import { runWhenMain } from '${CLI}';
const spec = { usage: 'sum.mjs <file>', positionals: ['file'] };
runWhenMain(import.meta.url, spec, ({ positionals }) => {
  const columns = { amount: { names: ['金額', 'amount'], type: 'whole' } };
  const { rows } = readTable(positionals.file, { columns });
  return { total: rows.reduce((total, row) => total + row.amount, 0) };
});
`;

  /** The one JSON line a refused import prints on stderr. */
  function refusalLine(stderr: string): unknown {
    expect(stderr.trim().split('\n')).toHaveLength(1);
    return JSON.parse(stderr);
  }

  it('lists the shipped digest of every file each importable module loads, and the package exports each module', () => {
    const manifest = z
      .object({ exports: z.record(z.string(), z.unknown()) })
      .parse(
        JSON.parse(
          readFileSync(
            new URL('../../packages/skills-office/package.json', import.meta.url),
            'utf8',
          ),
        ),
      );
    expect(Object.keys(BUILTIN_IMPORTS)).toStrictEqual(['office-reader']);
    for (const [skill, { modules, sha256 }] of Object.entries(BUILTIN_IMPORTS)) {
      if (!isBuiltinSkillName(skill)) throw new Error(`${skill} is not a built-in skill`);
      const shipped = new Map(
        builtinSkillFiles(skill).map((file) => [
          file.path,
          Buffer.from(file.contentBase64, 'base64'),
        ]),
      );
      const digests = Object.fromEntries(
        Object.keys(sha256).map((file) => [
          file,
          createHash('sha256')
            .update(shipped.get(file) ?? '')
            .digest('hex'),
        ]),
      );
      // On a mismatch, copy the received digests into BUILTIN_IMPORTS (packages/engine).
      expect(sha256).toStrictEqual(digests);
      // Every relative import of a listed file is listed too, so no unchecked file is loaded.
      for (const file of Object.keys(sha256)) {
        const text = String(shipped.get(file));
        for (const [, relative = ''] of text.matchAll(/^import .* from '(\.{1,2}\/[^']+)';$/gmu))
          expect(Object.keys(sha256)).toContain(posix.join(posix.dirname(file), relative));
      }
      for (const module of modules) {
        expect(Object.keys(sha256)).toContain(module);
        expect(Object.keys(manifest.exports)).toContain(`./${skill}/${module}`);
      }
    }
  });

  it('resolves to the placed office-reader, under the permission model, with no node_modules', async () => {
    placeOfficeReader();
    script('sum.mjs', SUM);
    write('data/amounts.csv', '﻿金額\r\n"1,200"\r\n34\r\n');
    const outcome = answered(await run('sum.mjs', ['data/amounts.csv']));
    expect(outcome).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toStrictEqual({ total: 1234 });
  });

  it('prints the reader’s refusal and exits 1: a stray quote is never swallowed', async () => {
    placeOfficeReader();
    script('sum.mjs', SUM);
    write('data/amounts.csv', 'amount\n1\n2"x\n3\n');
    const outcome = answered(await run('sum.mjs', ['data/amounts.csv']));
    expect(outcome.exitCode).toBe(1);
    expect(JSON.parse(outcome.stderr)).toMatchObject({ error: 'stray_quote', row: 3 });
  });

  it('refuses when office-reader is not granted, never loading a workspace node_modules', async () => {
    script('sum.mjs', SUM);
    write('data/amounts.csv', 'amount\n1\n');
    write(
      `node_modules/${BUILTIN_SKILL_PACKAGE}/office-reader/scripts/lib/table.mjs`,
      `console.log('SHADOWED');\nexport const readTable = () => ({ rows: [] });\n`,
    );
    const outcome = answered(await run('sum.mjs', ['data/amounts.csv']));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(refusalLine(outcome.stderr)).toStrictEqual({
      error: 'builtin_skill_not_granted',
      message: `${TABLE} needs the built-in skill office-reader, which this run does not grant: the agent grants builtinSkill('office-reader')`,
    });
  });

  it('refuses a skill named office-reader that is not the shipped one: a person’s own copy is not imported', async () => {
    placeOfficeReader();
    write(`${SKILLS}/office-reader/scripts/ooxml.mjs`, `console.log('EDITED');\n`);
    script('sum.mjs', SUM);
    write('data/amounts.csv', 'amount\n1\n');
    const outcome = answered(await run('sum.mjs', ['data/amounts.csv']));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout).toBe('');
    expect(refusalLine(outcome.stderr)).toStrictEqual({
      error: 'builtin_skill_modified',
      message: `the skill office-reader in this run is not the built-in one (scripts/ooxml.mjs differs), so ${TABLE} is not imported`,
    });
  });

  it('refuses any other path of the package with one line: a dot segment, an unlisted file, a skill that is not built in, the bare name', async () => {
    placeOfficeReader();
    script('a.mjs', `console.log('RAN');\n`);
    for (const specifier of [
      `${BUILTIN_SKILL_PACKAGE}/office-reader/scripts/lib/../../../review/scripts/a.mjs`,
      `${BUILTIN_SKILL_PACKAGE}/office-reader/scripts/ooxml.mjs`,
      `${BUILTIN_SKILL_PACKAGE}/office-writer/scripts/write.mjs`,
      `${BUILTIN_SKILL_PACKAGE}/review/scripts/a.mjs`,
      `${BUILTIN_SKILL_PACKAGE}/office-reader`,
      BUILTIN_SKILL_PACKAGE,
    ]) {
      script('import.mjs', `await import(${JSON.stringify(specifier)});\n`);
      const outcome = answered(await run('import.mjs'));
      expect(outcome.exitCode).toBe(1);
      expect(outcome.stdout).toBe('');
      expect(refusalLine(outcome.stderr)).toMatchObject({ error: 'not_importable' });
      expect(outcome.stderr).toContain(`${specifier} is not a module a built-in skill offers`);
    }
  });

  describe('the answer of an earlier tool call, by reference (ADR-0176)', () => {
    const PUBLIC_SOURCE = `${BUILTIN_SKILL_PACKAGE}/office-reader/scripts/lib/public-source.mjs`;
    const frames = engineFrameBuilder('claude-agent-sdk');

    /** The run's record, holding one public-source answer as the engine's frames carried it. */
    function answersHolding(output: string): ToolAnswers {
      const answers = createToolAnswers();
      answers.observe(
        frames.toolCall(
          {
            frame: 'agent.tool.call',
            toolCallId: 'toolu_peers',
            name: 'mcp__peers__public_source',
            kind: 'mcp',
            input: { query: 'retail' },
          },
          null,
        ),
      );
      answers.observe(
        frames.toolResult(
          {
            frame: 'agent.tool.result',
            toolCallId: 'toolu_peers',
            status: 'completed',
            output,
            isError: false,
          },
          null,
        ),
      );
      return answers;
    }

    const ITEM = {
      source: 'Fictional filings',
      url: 'https://example.test/filings/1',
      title: 'Sample Co.',
      summary: '',
      publishedAt: '2026-06-30',
      retrievedAt: '2026-11-01',
    };
    const ANSWER = JSON.stringify({
      mode: 'snapshot',
      asOf: '2026-11-01',
      notice: 'A dated snapshot.',
      truncated: false,
      records: Array.from({ length: 50 }, (_, index) => ({
        ...ITEM,
        id: `JP-${String(index).padStart(3, '0')}`,
        fields: { revenue: index * 100, segment: '小売', memo: 'x'.repeat(400) },
      })),
    });

    /** A use case's script: the records of the answer it was handed, summed, over the shipped reader. */
    const TOTAL = `import { readPublicSource } from '${PUBLIC_SOURCE}';
import { runWhenMain } from '${CLI}';
runWhenMain(import.meta.url, { usage: 'total.mjs', positionals: [] }, () => {
  const { asOf, records } = readPublicSource();
  return { asOf, count: records.length, revenue: records.reduce((sum, r) => sum + r.revenue, 0) };
});
`;

    async function runWith(
      name: string,
      answers: ToolAnswers,
      fromToolUse = 'toolu_peers',
    ): Promise<SkillScriptOutcome> {
      return runSkillScript(
        nodeSkillScriptHost,
        setup(),
        { skill: 'review', script: name, args: [], fromToolUse },
        SKILL_SCRIPT_LIMITS,
        undefined,
        answers,
      );
    }

    it('hands a 50-record answer, past the 8 KiB argument limit, to the shipped reader unchanged', async () => {
      expect(new TextEncoder().encode(ANSWER).length).toBeGreaterThan(
        SKILL_SCRIPT_LIMITS.maxArgumentBytes * 2,
      );
      placeOfficeReader();
      script('total.mjs', TOTAL);
      const outcome = answered(await runWith('total.mjs', answersHolding(ANSWER)));
      expect(outcome).toMatchObject({ exitCode: 0, stderr: '' });
      expect(JSON.parse(outcome.stdout)).toStrictEqual({
        asOf: '2026-11-01',
        count: 50,
        revenue: 122_500,
      });
    });

    it('prints the reader’s refusal of a cut answer and exits 1', async () => {
      placeOfficeReader();
      script('total.mjs', TOTAL);
      const cut = JSON.stringify({ ...JSON.parse(ANSWER), truncated: true });
      const outcome = answered(await runWith('total.mjs', answersHolding(cut)));
      expect(outcome.exitCode).toBe(1);
      expect(JSON.parse(outcome.stderr)).toMatchObject({ error: 'truncated_answer' });
    });

    it('gives the script the file read-only: a write, an append, a delete, a rename and a link from its scratch are refused', async () => {
      script(
        'tamper.mjs',
        `import fs from 'node:fs';
const file = process.env.${SKILL_SCRIPT_INPUT_ENV};
const codes = [];
for (const body of [
  () => fs.writeFileSync(file, 'edited'),
  () => fs.appendFileSync(file, 'edited'),
  () => fs.unlinkSync(file),
  () => fs.renameSync(file, file + '.moved'),
  () => fs.writeFileSync(file + '.new', 'x'),
  () => fs.symlinkSync(file, process.env.TMPDIR + '/link'),
  () => fs.writeFileSync(process.env.TMPDIR + '/link', 'edited'),
]) {
  try { body(); codes.push('OK'); } catch (error) { codes.push(error.code); }
}
console.log(JSON.stringify({ codes, content: fs.readFileSync(file, 'utf8') }));
`,
      );
      const outcome = answered(await runWith('tamper.mjs', answersHolding('{"verbatim":true}')));
      expect(JSON.parse(outcome.stdout)).toStrictEqual({
        // The link from the scratch directory is refused, so the last write only makes a plain
        // file of the script's own there.
        codes: [...Array<string>(6).fill('ERR_ACCESS_DENIED'), 'OK'],
        content: '{"verbatim":true}',
      });
    });

    it('names the file in the environment only for a call that references an answer, and removes it after', async () => {
      script(
        'where.mjs',
        `console.log(JSON.stringify({ keys: Object.keys(process.env).filter((key) => key !== 'TMPDIR' && key.startsWith('SKILL')), file: process.env.${SKILL_SCRIPT_INPUT_ENV} ?? null }));
`,
      );
      const referenced = JSON.parse(
        answered(await runWith('where.mjs', answersHolding('x'))).stdout,
      ) as { keys: string[]; file: string };
      expect(referenced.keys).toStrictEqual([SKILL_SCRIPT_INPUT_ENV]);
      expect(readable(referenced.file)).toBeNull();
      expect(JSON.parse(answered(await run('where.mjs')).stdout)).toStrictEqual({
        keys: [],
        file: null,
      });
    });

    it('refuses an id the run never received, and runs nothing', async () => {
      script('ran.mjs', `console.log('RAN');\n`);
      const answers = createToolAnswers({ waitMs: 10, maxRetainedBytes: 1024 });
      const outcome = await runWith('ran.mjs', answers, 'toolu_from_another_run');
      expect(outcome).toStrictEqual({
        ok: false,
        refusal: 'unknown_tool_answer',
        reason:
          'this run received no answer to a tool call "toolu_from_another_run". It has received no tool answer yet.',
      });
    });

    it('reads the reference from the model’s call through the one function every adapter calls', async () => {
      placeOfficeReader();
      script('total.mjs', TOTAL);
      const result = await executeRunSkillScript(
        nodeSkillScriptHost,
        setup(),
        { skill: 'review', script: 'total.mjs', input: { fromToolUse: 'toolu_peers' } },
        undefined,
        answersHolding(ANSWER),
      );
      expect(result.isError).toBe(false);
      expect(result.text).toContain('"count": 50');
    });
  });
});

describe('a writable folder that does not exist yet (R1 run 44985488322)', () => {
  // Node's permission model reads an `--allow-fs-write` path missing at start as one file: the
  // script could make `outputs/` and then write nothing in it. The tool makes the folder first.
  it('writes the first file of a run into outputs/, which nothing made before the call', async () => {
    script(
      'out.mjs',
      attempt(
        `fs.mkdirSync('outputs', { recursive: true }); fs.writeFileSync('outputs/a.txt', 'x')`,
      ),
    );
    expect(answered(await run('out.mjs', [], { writable: ['outputs'] })).stdout.trim()).toBe('OK');
    expect(readFileSync(join(root, 'outputs/a.txt'), 'utf8')).toBe('x');
  });

  it('renders an office-writer document into a missing outputs/, as an approved render does', async () => {
    for (const file of builtinSkillFiles('office-writer'))
      write(`${SKILLS}/office-writer/${file.path}`, Buffer.from(file.contentBase64, 'base64'));
    write(
      'drafts/guide.json',
      JSON.stringify({
        format: 'docx',
        title: '初週ガイド',
        blocks: [{ type: 'heading', level: 1, text: 'はじめに' }],
      }),
    );
    const outcome = answered(
      await runSkillScript(
        nodeSkillScriptHost,
        {
          cwd: root,
          skillsDirectory: SKILLS,
          skills: [{ name: 'office-writer', scripts: ['write.mjs'] }],
          writable: ['outputs'],
          writableDirectories: ['outputs'],
        },
        {
          skill: 'office-writer',
          script: 'write.mjs',
          args: ['drafts/guide.json', 'outputs/初週ガイド.docx'],
        },
      ),
    );
    expect(outcome).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toMatchObject({ written: 'outputs/初週ガイド.docx' });
    expect(readFileSync(join(root, 'outputs/初週ガイド.docx')).subarray(0, 2).toString()).toBe(
      'PK',
    );
  });

  it('makes no folder through a link in a parent path that leads out of the run directory', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'run-skill-script-outside-')));
    try {
      symlinkSync(outside, join(root, 'linked'));
      script('noop.mjs', `console.log('ran');\n`);
      expect(answered(await run('noop.mjs', [], { writable: ['linked/out'] })).stdout).toBe(
        'ran\n',
      );
      expect(() => readFileSync(join(outside, 'out'))).toThrow(/ENOENT/u);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
