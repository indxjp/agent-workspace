import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { ENGINE_PACKAGES } from '@indx-workspace/sdk/project';
import { describe, expect, it } from 'vitest';

import { localCredentialsFilePath } from '../local-runtime/local-credentials.js';
import { EXIT_CODE } from '../output.js';
import { tempFile } from '../testing.js';
import {
  TOKEN,
  USER_TOKEN,
  INSTALL_LINE,
  DEFINE,
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  project,
  dev,
  signedIn,
} from './dev.test-support.js';
import { projectWithAgent, agentsRoute } from './dev.routes.test-support.js';

describe('aw dev (issue #451): reports a failing runtime', () => {
  it('stops the runtime when the sync fails beyond a refusal, and exits with that error', async () => {
    const cwd = await projectWithAgent();
    let thrown = false;
    const { run } = await dev(cwd, {
      route: agentsRoute,
      // The terminal going away while the sync prints: a failure no refusal describes.
      until: ({ stdout }) => {
        if (!thrown && stdout.includes('synced: ')) {
          thrown = true;
          throw new RangeError('the terminal went away');
        }
        return false;
      },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: unexpected: the terminal went away\n');
    expect(existsSync(path.join(cwd, 'stopped'))).toBe(true);
  });

  it('reports a failed runtime and exits 1', async () => {
    const cwd = await project({
      script: fakeRuntime(sends({ type: 'failed', message: 'Port 3000 is already in use.' })),
    });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('error: Port 3000 is already in use.\n');
    expect(run.stderr).toContain('full log: ');
    expect(run.stdout).toBe('');
    // Asked to stop, so its own shutdown ran — on Windows too, where SIGINT would kill it outright.
    expect(existsSync(path.join(cwd, 'stopped'))).toBe(true);
  });

  it('reports a runtime that stops on its own with its exit code', async () => {
    const cwd = await project({ script: fakeRuntime('process.exit(3);') });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('the local runtime stopped (exit code 3)');
  });

  it.each([
    ['a skewed runtime version', { embeddedVersion: '0.0.1' }, 'is installed, but aw'],
    ['no runtime installed', { embeddedVersion: null }, 'is not installed in this project'],
  ] as const)('refuses %s with the install line, before forking', async (_name, options, text) => {
    const cwd = await project(options);
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain(text);
    expect(run.stderr).toContain(`fix: ${INSTALL_LINE}\n`);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });
});

describe('aw dev (issue #451): refuses a runtime that cannot serve the project', () => {
  it("refuses an agent whose engine is not installed with that engine's install line (#691)", async () => {
    const cwd = await project({ engines: false, script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await tempFile(
      cwd,
      'agents/assistant.ts',
      `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });\n`,
    );
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('engine claude-agent-sdk is not installed');
    const specs = Object.entries(ENGINE_PACKAGES['claude-agent-sdk']).map(
      ([name, version]) => `${name}@${version}`,
    );
    expect(run.stderr).toContain(`fix: npm install ${specs.join(' ')}\n`);
    expect(existsSync(path.join(cwd, 'start.json'))).toBe(false);
  });

  it('refuses a runtime that speaks another contracts version with the install line', async () => {
    const cwd = await project({
      script: fakeRuntime(sends({ ...READY, contractsVersion: '9.9.9' })),
    });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('speaks contracts 9.9.9');
    expect(run.stderr).toContain(`fix: ${INSTALL_LINE}\n`);
    expect(run.stdout).toBe('');
  });

  it.each([
    ['a credential before ready', [CREDENTIAL], 'credential was sent before ready'],
    ['an unknown message type', [{ type: 'hello', token: TOKEN }], 'type'],
    ['a malformed ready', [{ ...READY, url: `http://127.0.0.1:3000/?${TOKEN}` }], 'url'],
    [
      'a ready on another port',
      [{ ...READY, url: 'http://127.0.0.1:4000' }],
      'ready.url is not on port 3000',
    ],
    ['a second ready', [READY, READY], 'ready was sent twice'],
    ['a credential holding a user token', [READY, { ...CREDENTIAL, token: USER_TOKEN }], 'token'],
  ] as const)('stops the runtime on %s and never echoes a value', async (_name, messages, text) => {
    const cwd = await project({ script: fakeRuntime(sends(...messages)) });
    const { run, home } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('the local runtime broke the protocol: ');
    expect(run.stderr).toContain(text);
    expect(run.stdout + run.stderr).not.toContain(TOKEN);
    expect(run.stdout + run.stderr).not.toContain(USER_TOKEN);
    expect(existsSync(localCredentialsFilePath(home))).toBe(false);
  });
});

describe('aw dev (issue #451): keeps the runtime log', () => {
  it('refuses instead of crashing when .aw/logs cannot be created', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await writeFile(path.join(cwd, '.aw'), 'not a directory');
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('could not write the runtime log');
  });

  it('keeps the output of the runtime in .aw/logs/runtime.log and prints the last 20 lines of it when it fails', async () => {
    const lines = Array.from({ length: 30 }, (_unused, index) => `line ${String(index + 1)}`);
    const cwd = await project({
      script: fakeRuntime(
        `console.log(${JSON.stringify(lines.join('\n'))});
console.error('initdb said this');
process.exit(3);`,
      ),
    });
    const { run } = await dev(cwd);
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('line 30\n');
    expect(run.stderr).toContain('line 12\n');
    expect(run.stderr).not.toContain('line 11\n');
    expect(run.stderr).toContain(path.join(cwd, '.aw', 'logs', 'runtime.log'));
    const log = await readFile(path.join(cwd, '.aw', 'logs', 'runtime.log'), 'utf8');
    expect(log).toContain('line 1\n');
    expect(log).toContain('initdb said this');
  });

  it('streams the output of the runtime with --verbose and prints no screen with --quiet', async () => {
    const script = fakeRuntime(`console.log('postgres is up'); ${sends(READY, CREDENTIAL)}`);
    const cwd = await project({ script });
    const verbose = await dev(cwd, { argv: ['--verbose'], until: signedIn });
    expect(verbose.run.stdout).toContain('postgres is up');
    const quiet = await dev(cwd, { argv: ['--quiet'], until: signedIn });
    expect(quiet.run.stdout).toBe('');
    expect(quiet.run.stderr).not.toContain('postgres is up');
    const refused = await dev(cwd, { argv: ['--quiet', '--verbose'] });
    expect(refused.run.code).toBe(EXIT_CODE.usage);
  });

  it('prints no runtime output, not even a sign-in line with a password (BH061-011)', async () => {
    const line =
      'Sign in at http://127.0.0.1:3000 as admin@localhost.test with password PPBRLllEuBBDmkK1 (shown once; it is kept in /x/local-secrets.json)';
    const cwd = await project({
      script: fakeRuntime(
        `console.log('postgres is up'); console.log(${JSON.stringify(line)}); ${sends(READY, CREDENTIAL)}`,
      ),
    });
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.stdout).not.toContain('PPBRLllEuBBDmkK1');
    expect(run.stdout).not.toContain('postgres is up');
  });
});

describe('aw dev (issue #451): forwards interrupts', () => {
  it('forwards an interrupt to the runtime and exits 130', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.code).toBe(EXIT_CODE.interrupted);
    expect(run.stderr.endsWith('interrupted\n')).toBe(true);
    // BH061-072: said at once, on its own line after the terminal's ^C.
    expect(run.stderr).toContain('\nstopping the local runtime…\n');
    // The runtime's own shutdown ran on every platform: the IPC channel closing asks it to stop.
    expect(existsSync(path.join(cwd, 'stopped'))).toBe(true);
  });

  it('stops the tool host child when it stops', async () => {
    const cwd = await project({ script: fakeRuntime(sends(READY, CREDENTIAL)) });
    await mkdir(path.join(cwd, 'tools'));
    // What `defineTool` makes, branded by hand: the temp project cannot import the SDK.
    await writeFile(
      path.join(cwd, 'tools', 'probe.ts'),
      `const tool = { name: 'probe', description: 'probe', inputSchema: { type: 'object' }, run: './tools/probe.run.js', limits: { timeoutMs: 1000 } };
Object.defineProperty(tool, Symbol.for('agentworkspace.dev/define'), { value: 'code' });
export default tool;
`,
    );
    await writeFile(
      path.join(cwd, 'tools', 'probe.run.js'),
      `import { writeFileSync } from 'node:fs';
writeFileSync('tool-host.pid', String(process.pid));
export default () => 1;
`,
    );
    const { run } = await dev(cwd, { until: signedIn });
    expect(run.code, run.stderr).toBe(EXIT_CODE.interrupted);
    const pid = Number(await readFile(path.join(cwd, 'tool-host.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // `aw dev` awaits the host, so the child is already gone when it returns.
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
