import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ startComposeDeployment: vi.fn() }));

vi.mock('./deployment.ts', () => ({ startComposeDeployment: mocks.startComposeDeployment }));

import { CONTRACTS_VERSION } from '@indx-workspace/contracts';

import {
  describeInsecureSignIn,
  EMBEDDED_MODE_REFUSAL,
  runStartCommand,
  waitForWebUrl,
} from './start.ts';

describe('runStartCommand', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  const stubFetch = (headers: Record<string, string>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 401, headers }))),
    );
  const unsupported = {
    'x-agent-workspace-contracts': '99.1.0',
    'x-agent-workspace-contracts-minimum': '99.0.0',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refuses a Compose deployment whose server serves another contracts version', async () => {
    mocks.startComposeDeployment.mockResolvedValue('http://127.0.0.1:3000');
    stubFetch(unsupported);
    await expect(runStartCommand([])).rejects.toThrow(
      new RegExp(
        `contracts ${CONTRACTS_VERSION.replaceAll('.', '\\.')}.*serves contracts 99\\.0\\.0 to 99\\.1\\.0.*@indx-workspace/cli@99\\.1`,
        'u',
      ),
    );
  });

  it('leaves a Compose deployment in range unchanged and silent', async () => {
    mocks.startComposeDeployment.mockResolvedValue('http://127.0.0.1:3000');
    stubFetch({
      'x-agent-workspace-contracts': CONTRACTS_VERSION,
      'x-agent-workspace-contracts-minimum': CONTRACTS_VERSION,
    });
    await expect(runStartCommand([])).resolves.toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();
  });

  /**
   * #377 F1: Compose reported every container up while Docker had published no port, and `start`
   * only warned. A web URL that never answers is a failed start with a non-zero exit.
   */
  it('fails, naming the URL, the logs and PORT, when the web URL never answers', async () => {
    mocks.startComposeDeployment.mockResolvedValue('http://127.0.0.1:3000');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    let clock = 0;
    const rejection = runStartCommand([], {
      timeoutMs: 10_000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });
    await expect(rejection).rejects.toThrow(
      /did not answer at http:\/\/127\.0\.0\.1:3000 within 10s.*docker compose logs web.*PORT in \.env.*remote Docker daemon or docker context/su,
    );
  });

  /**
   * The project `start` just brought up pins a server that states its contracts version on every
   * answer, so an answer without it on the published port is another process holding that port.
   */
  it('fails, naming the port conflict, when something without the contracts headers answers', async () => {
    mocks.startComposeDeployment.mockResolvedValue('http://127.0.0.1:3417');
    stubFetch({});
    const rejection = runStartCommand([]);
    await expect(rejection).rejects.toThrow(/not this project's web service/u);
    await expect(rejection).rejects.toThrow(/holding port 3417.*PORT in \.env/su);
    expect(stderr).not.toHaveBeenCalled();
  });

  /**
   * #389: the session cookie is `__Host-` and `Secure`, so a browser drops it over plain http
   * anywhere but localhost. A remote daemon's URL says how to sign in instead.
   */
  it('says how to sign in when the web URL is plain http on another host', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    mocks.startComposeDeployment.mockResolvedValue('http://10.0.0.5:3417');
    stubFetch({
      'x-agent-workspace-contracts': CONTRACTS_VERSION,
      'x-agent-workspace-contracts-minimum': CONTRACTS_VERSION,
    });
    await runStartCommand([]);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain(
      'Agent Workspace is up: http://10.0.0.5:3417 (first run: create the owner at http://10.0.0.5:3417/setup)',
    );
    expect(output).toMatch(
      /only over HTTPS or on localhost.*ssh -L 3417:127\.0\.0\.1:3417 <user>@10\.0\.0\.5.*http:\/\/localhost:3417\/setup/su,
    );
  });

  it('names Docker, not .env, when the docker binary is missing', async () => {
    mocks.startComposeDeployment.mockRejectedValue(
      Object.assign(new Error('spawn docker ENOENT'), {
        code: 'ENOENT',
        syscall: 'spawn docker',
        path: 'docker',
      }),
    );
    const rejection = runStartCommand([]);
    await expect(rejection).rejects.toThrow(/Docker is not installed or not on PATH/);
    await expect(rejection).rejects.not.toThrow(/\.env/);
  });

  it('refuses --embedded and names the command that runs it', async () => {
    await expect(runStartCommand(['--embedded'])).rejects.toThrow(EMBEDDED_MODE_REFUSAL);
    expect(mocks.startComposeDeployment).not.toHaveBeenCalled();
    expect(EMBEDDED_MODE_REFUSAL).toContain('npm run dev');
  });

  it('refuses a directory without a generated .env instead of starting a server', async () => {
    mocks.startComposeDeployment.mockRejectedValue(
      Object.assign(new Error('no .env'), { code: 'ENOENT' }),
    );
    await expect(runStartCommand([])).rejects.toThrow(/There is no \.env in .*npm run dev/su);
  });

  // #496: `npm create @indx-workspace` without --cloud writes a kind: Project directory, no .env.
  it('names aw dev and the --cloud local project in a kind: Project directory', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aw-start-project-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory);
    try {
      await writeFile(
        path.join(directory, 'agent-workspace.yaml'),
        'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: acme\n',
      );
      mocks.startComposeDeployment.mockRejectedValue(
        Object.assign(new Error('no .env'), { code: 'ENOENT' }),
      );
      const rejection = runStartCommand([]);
      await expect(rejection).rejects.toThrow(`There is no .env in ${directory}.`);
      await expect(rejection).rejects.toThrow(/aw dev/u);
      await expect(rejection).rejects.toThrow(
        /npm create @indx-workspace <directory> -- --cloud local/u,
      );
      await expect(rejection).rejects.toThrow(/npm run dev/u);
      await expect(rejection).rejects.not.toThrow(/create-agent-workspace/u);
    } finally {
      cwd.mockRestore();
      await rm(directory, { recursive: true });
    }
  });

  it('passes any other Compose failure through unchanged', async () => {
    const failure = new Error('docker compose exited with status 1');
    mocks.startComposeDeployment.mockRejectedValue(failure);
    await expect(runStartCommand([])).rejects.toBe(failure);
  });
});

describe('waitForWebUrl', () => {
  it('keeps asking while the server boots, and returns the first answer', async () => {
    const answers = [
      { kind: 'unreachable', reason: 'TypeError' },
      { kind: 'unreachable', reason: 'TypeError' },
      { kind: 'served' },
    ] as const;
    const probe = vi.fn(() => Promise.resolve(answers[probe.mock.calls.length - 1] ?? answers[2]));
    const sleep = vi.fn(() => Promise.resolve());
    await expect(
      waitForWebUrl('http://127.0.0.1:3000', { probe, sleep, now: () => 0 }),
    ).resolves.toEqual({ kind: 'served' });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('describeInsecureSignIn', () => {
  it('stays silent where a browser keeps a Secure cookie', () => {
    expect(describeInsecureSignIn('http://127.0.0.1:3000')).toBeUndefined();
    expect(describeInsecureSignIn('http://localhost:3000')).toBeUndefined();
    expect(describeInsecureSignIn('http://[::1]:3000')).toBeUndefined();
    expect(describeInsecureSignIn('https://workspace.example.com')).toBeUndefined();
  });

  it('names the tunnel and HTTPS for plain http at any other address', () => {
    expect(describeInsecureSignIn('http://docker.internal')).toMatch(
      /ssh -L 80:127\.0\.0\.1:80 <user>@docker\.internal.*serve the project over HTTPS/su,
    );
  });
});
