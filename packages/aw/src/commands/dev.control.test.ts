import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { LocalRuntimeStartMessageSchema } from '@indx-workspace/contracts/local-runtime';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { runCli } from '../testing.js';
import {
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  project,
  dev,
  signedIn,
} from './dev.test-support.js';
import { workspaceRoute } from './dev.routes.test-support.js';

describe('aw dev status and aw dev stop (BH061-005, BH061-045)', () => {
  async function withRecord(pid: number): Promise<string> {
    const cwd = await project();
    await mkdir(path.join(cwd, '.aw'), { recursive: true });
    await writeFile(path.join(cwd, '.aw', 'runtime.json'), JSON.stringify({ port: 3100, pid }));
    return cwd;
  }

  it('reports a ready aw dev with its URL, as text and as JSON', async () => {
    const cwd = await withRecord(process.pid);
    const text = await runCli(['dev', 'status'], { cwd });
    expect(text.code).toBe(EXIT_CODE.ok);
    expect(text.stdout).toBe(
      `aw dev is running at http://127.0.0.1:3100 (pid ${String(process.pid)})\n`,
    );
    const machine = await runCli(['dev', 'status', '--json'], { cwd });
    expect(JSON.parse(machine.stdout)).toEqual({
      running: true,
      url: 'http://127.0.0.1:3100',
      port: 3100,
      pid: process.pid,
    });
  });

  it('refuses status and stop when no aw dev is running, so a script can wait on it', async () => {
    const cwd = await project();
    for (const verb of ['status', 'stop']) {
      const run = await runCli(['dev', verb], { cwd });
      expect(run.code).toBe(EXIT_CODE.problem);
      expect(run.stderr).toContain('aw dev is not running in this project');
    }
  });

  it('stops the recorded aw dev and waits until it is gone', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const cwd = await withRecord(child.pid ?? 0);
      const run = await runCli(['dev', 'stop'], { cwd });
      expect(run.stdout).toBe('aw dev stopped\n');
      expect(run.code).toBe(EXIT_CODE.ok);
      await exited;
    } finally {
      child.kill();
    }
  });
});

describe('aw dev --port and PORT (BH061-012)', () => {
  async function startedPort(cwd: string): Promise<number> {
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    return start.environment.port;
  }

  /** A runtime that answers ready on the port it was started on. */
  const onItsPort = fakeRuntime(
    `await send({ ...${JSON.stringify(READY)}, url: 'http://127.0.0.1:' + start.environment.port });
${sends(CREDENTIAL)}`,
  );

  it('starts the runtime on --port, which wins over PORT', async () => {
    const cwd = await project({ script: onItsPort });
    const { run } = await dev(cwd, {
      argv: ['--port', '3300'],
      env: { PORT: '3301' },
      until: signedIn,
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(await startedPort(cwd)).toBe(3300);
  });

  it('starts the runtime on PORT from its environment', async () => {
    const cwd = await project({ script: onItsPort });
    const { run } = await dev(cwd, { env: { PORT: '3301' }, until: signedIn });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    expect(await startedPort(cwd)).toBe(3301);
  });

  it.each([
    ['--port', 'abc'],
    ['--port', '4000'],
    ['--port', '70000'],
  ])('refuses %s %s before anything starts', async (flag, value) => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { argv: [flag, value] });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--port must be a port from 1 to 65535');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});

describe('aw dev and the development OIDC issuer (ADR-0161 amendment, issue #2075)', () => {
  const OIDC = {
    OIDC_ISSUER_URL: 'https://idp.example.test',
    OIDC_CLIENT_ID: 'console',
    OIDC_CLIENT_SECRET: 'oidc-secret-SENTINEL',
    OIDC_REDIRECT_URI: 'http://127.0.0.1:3000/api/auth/callback',
  };

  it('with no OIDC_* sends devIssuer, never prints its secret, and stops the issuer with aw dev', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    const devIssuer = start.environment.devIssuer;
    if (devIssuer === undefined) throw new Error('no devIssuer in start');
    expect(`${run.stdout}${run.stderr}`).not.toContain(devIssuer.clientSecret);
    // The issuer stopped when aw dev ended.
    await expect(fetch(`${devIssuer.issuer}/jwks`)).rejects.toThrow();
  });

  it('with all four OIDC_* set starts no issuer, sends no devIssuer, and says so once', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { until: signedIn, env: OIDC });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const start = LocalRuntimeStartMessageSchema.parse(
      JSON.parse(await readFile(path.join(cwd, 'start.json'), 'utf8')),
    );
    expect(start.environment.devIssuer).toBeUndefined();
    expect(run.stderr.match(/aw dev runs no development issuer/gu)).toHaveLength(1);
    expect(`${run.stdout}${run.stderr}`).not.toContain('SENTINEL');
  });

  it('refuses one to three OIDC_* set, in the environment or .env, before the fork', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await writeFile(path.join(cwd, '.env'), 'OIDC_CLIENT_ID=from-dotenv\n');
    const { run } = await dev(cwd, {
      until: signedIn,
      env: { OIDC_ISSUER_URL: OIDC.OIDC_ISSUER_URL },
    });
    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(
      'oidc_configuration_incomplete: OIDC_ISSUER_URL, OIDC_CLIENT_ID are set but OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI are not',
    );
    expect(run.stderr).not.toContain('from-dotenv');
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});

describe('aw dev with a generated app (issue #1506)', () => {
  const MANIFEST = `${JSON.stringify({ version: 1, entries: { 'app:desk': { files: {}, edits: [] } } })}\n`;

  it('refuses a malformed aw-generated.json before the runtime is forked', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await writeFile(path.join(cwd, 'aw-generated.json'), '{"version":2}\n');
    const { run } = await dev(cwd, { until: signedIn });

    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses the app when the runtime names no loopback database, and starts nothing', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await writeFile(path.join(cwd, 'aw-generated.json'), MANIFEST);
    const { run } = await dev(cwd, { route: workspaceRoute(), until: signedIn });

    expect(run.code, run.stderr).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('app_database_unavailable');
    expect(run.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    expect(existsSync(path.join(cwd, '.aw', 'app-identity.json'))).toBe(false);
  });
});
