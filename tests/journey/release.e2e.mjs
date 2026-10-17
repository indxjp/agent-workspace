/* global console, performance, process */
/**
 * The 80-08 demo as a journey check (issue #615), untimed: in the generated project, `aw promote`
 * shows the move and changes nothing without `--yes`, `aw promote --yes` points `production` at
 * `local`'s version, `aw rollback --yes` points it back in one request, and `aw versions` shows both
 * pointers and the two moves, newest first.
 *
 * `production` is first pointed at version 1 (`aw promote <agent> 1 --yes`), so the rollback has an
 * earlier entry whatever ran before this. Whether the widget then answers as the older version
 * waits for public surfaces to serve `production` (80-07 PR 3); this checks the CLI output and the
 * pointers only. `local` never moves.
 *
 * With `JOURNEY_PROMOTION_BAR` set, it instead checks the 80-12 gate (issue #619) against an
 * `aw dev` started with that bar in `policy.promotion.minEvalScore`, after `evals/<agent>.yaml`'s
 * cases passed: an added failing case makes `aw eval` fail and `aw promote --yes` refuse
 * production, naming the case; with the case removed, `aw eval` passes and promote moves it.
 *
 * It runs inside the clean container against the `aw dev` the journey started, like
 * `viewer.e2e.mjs`. Named `.e2e.mjs`, not `.spec.mjs`, so the `tests` Vitest project never loads it.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { agentNameOfSource } from './harness.mjs';

/** @param {string} name */
function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set: start this test with node tests/journey/run.mjs`);
  }
  return value;
}

const DEMO_DIR = required('JOURNEY_DEMO_DIR');
const PROMOTION_BAR = process.env['JOURNEY_PROMOTION_BAR'];

/**
 * `aw <args>` in the demo project, after checking it exited `status`.
 *
 * @param {readonly string[]} args @param {number} [status]
 */
function awRun(args, status = 0) {
  const run = spawnSync('npx', ['aw', ...args], {
    cwd: DEMO_DIR,
    encoding: 'utf8',
    timeout: 180_000,
  });
  expect(run.status, `aw ${args.join(' ')}\n${run.stdout}${run.stderr}`).toBe(status);
  return run;
}

/**
 * `aw <args>` in the demo project; its stdout, after checking it exited 0.
 *
 * @param {readonly string[]} args
 */
function aw(args) {
  return awRun(args).stdout;
}

/** The name of the one agent the generated project defines. */
function agentName() {
  // The workspace also holds agents earlier journey blocks made; the project defines one.
  const files = readdirSync(path.join(DEMO_DIR, 'agents')).filter((file) => file.endsWith('.ts'));
  expect(files, 'the generated project has one agent file').toHaveLength(1);
  return agentNameOfSource(readFileSync(path.join(DEMO_DIR, 'agents', files[0] ?? ''), 'utf8'));
}

/**
 * The environment pointers and the moves of `aw versions --json`.
 *
 * @returns {{ pointers: Record<string, number>, moves: readonly { environment: string, number: number, reason: string }[] }}
 */
function versions() {
  /** @type {{ pointers: readonly { environment: string, number: number }[], moves: readonly { environment: string, number: number, reason: string }[] }} */
  const list = JSON.parse(aw(['versions', '--json']));
  return {
    pointers: Object.fromEntries(
      list.pointers.map((pointer) => [pointer.environment, pointer.number]),
    ),
    moves: list.moves,
  };
}

test('aw promote moves production to local, aw rollback moves it back, aw versions shows both', () => {
  test.skip(PROMOTION_BAR !== undefined, 'the promotion gate run checks the gate instead');
  const name = agentName();

  aw(['promote', name, '1', '--yes']);
  const local = versions().pointers['local'];
  expect(local, 'local points at a version').toBeGreaterThanOrEqual(1);
  const to = String(local);

  const plan = awRun(['promote']);
  expect(plan.stdout).toBe(`production: 1 -> ${to}; pass --yes to move it\n`);
  // Issue #619: with no bar, promotion needs no evaluation, and says so in one line.
  expect(plan.stderr).toContain('no promotion bar is set; production needs no evaluation');
  expect(versions().pointers['production'], 'the plan moved nothing').toBe(1);

  expect(aw(['promote', '--yes'])).toBe(`production: 1 -> ${to}\n`);
  expect(versions().pointers['production']).toBe(local);

  expect(aw(['rollback', '--yes'])).toBe(`production: ${to} -> 1\n`);

  const after = versions();
  expect(after.pointers).toEqual({ local, production: 1 });
  expect(after.moves.slice(0, 2)).toEqual(
    [
      { environment: 'production', number: 1, reason: 'rollback' },
      { environment: 'production', number: local, reason: 'promote' },
    ].map((move) => expect.objectContaining(move)),
  );

  const text = aw(['versions']);
  expect(text).toContain(`local -> ${to}`);
  expect(text).toContain('production -> 1');
});

test('a failing case blocks promotion; fixing it lets promotion through (issue #619)', () => {
  test.skip(PROMOTION_BAR === undefined, 'needs aw dev started with a promotion bar');
  const started = performance.now();
  const name = agentName();
  const evalFile = path.join(DEMO_DIR, 'evals', `${name}.yaml`);
  const original = readFileSync(evalFile, 'utf8');
  const failing = `never says ${randomBytes(4).toString('hex')}`;
  writeFileSync(
    evalFile,
    `${original.trimEnd()}\n  - name: ${failing}\n    input: "Say hello"\n` +
      `    expect: { contains: ["${failing}"] }\n`,
  );
  try {
    awRun(['eval', name], 1);
    const refused = awRun(['promote', name, '--yes'], 1);
    expect(refused.stderr).toContain('production refused: v');
    expect(refused.stderr).toContain(`"${failing}"`);
    expect(refused.stderr).toContain('run `aw eval ');
  } finally {
    writeFileSync(evalFile, original);
  }

  aw(['eval', name]);
  const local = versions().pointers['local'];
  expect(aw(['promote', name, '--yes'])).toMatch(new RegExp(`-> ${String(local)}\n$`, 'u'));
  expect(versions().pointers['production']).toBe(local);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `journey: the promotion gate refused a failing case and passed the fix (${seconds}s)`,
  );
});
