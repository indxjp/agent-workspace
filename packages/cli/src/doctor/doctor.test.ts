import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CONTRACTS_MINIMUM_VERSION_HEADER,
  CONTRACTS_VERSION,
  CONTRACTS_VERSION_HEADER,
} from '@indx-workspace/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { runAsProcess } from '../cli-failure.js';
import type { CommandProbe, CommandResult } from '../host-capabilities.js';
import type { ProfileProbes } from '../validate.js';
import { PROJECT_KIND_REFUSAL } from '../profile.js';
import type { DoctorCheck } from './checks.js';
import { runDoctorCommand, type DoctorOptions } from './index.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
});

async function fixtureProfile(
  cloud: 'local' | 'gcp' | 'aws' | 'azure' | 'cloudflare',
): Promise<string> {
  return readFile(new URL(`../fixtures/${cloud}/agent-workspace.yaml`, import.meta.url), 'utf8');
}

/** A project directory holding the given profile and, optionally, a `.env`. */
async function project(profile: string | null, env?: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-doctor-'));
  created.push(directory);
  if (profile !== null) await writeFile(path.join(directory, 'agent-workspace.yaml'), profile);
  if (env !== undefined) await writeFile(path.join(directory, '.env'), env);
  return directory;
}

const found = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });

/** Every tool but the one this command line runs. */
function without(
  tools: Readonly<Record<string, CommandResult>>,
  line: string,
): Readonly<Record<string, CommandResult>> {
  return Object.fromEntries(Object.entries(tools).filter(([key]) => key !== line));
}

/** Every tool any target needs, installed. */
const EVERY_TOOL: Readonly<Record<string, CommandResult>> = {
  'docker --version': found('Docker version 27.3.1, build ce12230'),
  'docker compose version --short': found('2.29.7'),
  'kubectl version --client': found('Client Version: v1.31.0'),
  'helm version --short': found('v3.16.2+g13654a5'),
  'terraform version': found('Terraform v1.9.5'),
};

function toolsOnPath(
  installed: Readonly<Record<string, CommandResult>> = EVERY_TOOL,
): CommandProbe {
  return (name, args) =>
    installed[[name, ...args].join(' ')] ?? { status: null, stdout: '', stderr: 'ENOENT' };
}

const answeringProbes: ProfileProbes = {
  relational: () => Promise.resolve(),
  objects: () => Promise.resolve('present'),
  identity: () => Promise.resolve(),
};

/** A stub control plane answering `GET /api/me` with the given served range, or none. */
function server(range: readonly [string, string] | null): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(null, {
        status: 401,
        headers:
          range === null
            ? {}
            : {
                [CONTRACTS_MINIMUM_VERSION_HEADER]: range[0],
                [CONTRACTS_VERSION_HEADER]: range[1],
              },
      }),
    );
}

const unreachable: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));

interface DoctorRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly checks: readonly DoctorCheck[];
}

/**
 * Run the command as the process would, with `--json` added to read the checks back. The
 * environment is stubbed unless `projectEnvironment` asks for the project's own `.env`.
 */
async function doctor(
  directory: string,
  { projectEnvironment = false, ...options }: DoctorOptions & { projectEnvironment?: boolean } = {},
): Promise<DoctorRun> {
  const environment = projectEnvironment
    ? {}
    : { environment: { AGENT_WORKSPACE_URL: 'https://aw.example' } };
  const run = async (argv: readonly string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runAsProcess(
      () =>
        runDoctorCommand(argv, {
          probes: answeringProbes,
          command: toolsOnPath(),
          fetch: server([CONTRACTS_VERSION, CONTRACTS_VERSION]),
          ...environment,
          ...options,
          stdout: (text) => {
            stdout += text;
          },
        }),
      (text) => {
        stderr += text;
      },
    );
    return { code, stdout, stderr };
  };
  const text = await run([directory]);
  const json = await run([directory, '--json']);
  const report = JSON.parse(json.stdout) as { ok: boolean; checks: DoctorCheck[] };
  expect(json.code).toBe(text.code);
  expect(report.ok).toBe(text.code === 0);
  return {
    ...text,
    stdout: `${text.stdout}${json.stdout}`,
    stderr: `${text.stderr}${json.stderr}`,
    checks: report.checks,
  };
}

function find(checks: readonly DoctorCheck[], check: DoctorCheck['check'], subject: string) {
  return checks.find((entry) => entry.check === check && entry.subject === subject);
}

describe('agent-workspace doctor: profile', () => {
  it('passes a valid profile', async () => {
    const { checks, code } = await doctor(await project(await fixtureProfile('gcp')), {
      environment: { DATABASE_URL: 'postgres://u:p@db.example/aw' },
    });

    expect(find(checks, 'profile', 'agent-workspace.yaml')).toMatchObject({
      status: 'pass',
      detail: 'valid for cloud gcp',
    });
    expect(code).toBe(0);
  });

  it('warns that cloudflare-sandbox refuses every network policy (ADR-0131)', async () => {
    const native = (await fixtureProfile('cloudflare')).replace(
      'default: external',
      'default: cloudflare-sandbox',
    );
    const { checks } = await doctor(await project(native));

    expect(find(checks, 'profile', 'runtime.default')).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('refuses every network policy (ADR-0131)') as unknown,
    });
  });

  it('gives the profile --cloud cloudflare writes a driver that runs sessions (BH061-029)', async () => {
    const generated = await fixtureProfile('cloudflare');
    expect(generated).toContain('default: external');

    const { checks } = await doctor(await project(generated));

    expect(find(checks, 'profile', 'runtime.default')).toBeUndefined();
  });

  it('warns about a profile without apiVersion, and still exits 0', async () => {
    const legacy = (await fixtureProfile('gcp')).replace(/^apiVersion:.*\n^kind:.*\n/mu, '');

    const { checks, code } = await doctor(await project(legacy));

    const warning = checks.find(({ check, status }) => check === 'profile' && status === 'warn');
    expect(warning?.detail).toContain('has no apiVersion');
    expect(warning?.advice).toContain('apiVersion: agentworkspace.dev/v1 and kind: Deployment');
    expect(code).toBe(0);
  });

  it('fails a profile with an unknown key, naming its line, and checks nothing that needs it', async () => {
    const broken = `${await fixtureProfile('gcp')}colour: blue\n`;

    const { checks, code } = await doctor(await project(broken));

    expect(find(checks, 'profile', 'agent-workspace.yaml')).toMatchObject({ status: 'fail' });
    expect(find(checks, 'profile', 'agent-workspace.yaml')?.detail).toMatch(
      /line \d+, column \d+/u,
    );
    expect(find(checks, 'stores', 'stores')).toMatchObject({ status: 'warn' });
    expect(find(checks, 'prerequisites', 'tools')).toMatchObject({ status: 'warn' });
    // The version check needs only the environment, so it still runs.
    expect(find(checks, 'version-skew', 'server')).toMatchObject({ status: 'pass' });
    expect(code).toBe(1);
  });

  it('fails a directory with no profile, naming the command that generates one', async () => {
    const { checks, code } = await doctor(await project(null));

    const profile = find(checks, 'profile', 'agent-workspace.yaml');
    expect(profile?.detail).toContain('could not be read');
    expect(profile?.advice).toContain('npm create @indx-workspace <directory> -- --cloud local');
    expect(profile?.advice).toContain('pass its directory');
    expect(code).toBe(1);
  });

  // #496: a kind: Project file is run by aw dev, not corrected at a line.
  it('fails a kind: Project file with advice naming aw dev, not a line to correct', async () => {
    const directory = await project(
      'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: acme\n',
    );

    const { checks, code } = await doctor(directory);

    const profile = find(checks, 'profile', 'agent-workspace.yaml');
    expect(profile).toMatchObject({ status: 'fail' });
    expect(profile?.detail).toContain(PROJECT_KIND_REFUSAL);
    expect(profile?.advice).toContain('aw dev');
    expect(profile?.advice).toContain('--cloud local');
    expect(profile?.advice).not.toContain('Correct');
    expect(code).toBe(1);
  });
});

describe('agent-workspace doctor: stores', () => {
  it('passes a store that answers, probed the way validate probes it', async () => {
    const probed: string[] = [];
    const { checks } = await doctor(await project(await fixtureProfile('gcp')), {
      environment: { DATABASE_URL: 'postgres://u:p@db.example/aw' },
      probes: {
        ...answeringProbes,
        relational: (url) => {
          probed.push(url);
          return Promise.resolve();
        },
      },
    });

    expect(find(checks, 'stores', 'relational')).toMatchObject({ status: 'pass' });
    expect(find(checks, 'stores', 'objects')).toMatchObject({ status: 'pass' });
    // Once for the text report and once for --json.
    expect(probed).toEqual(['postgres://u:p@db.example/aw', 'postgres://u:p@db.example/aw']);
  });

  it('warns about a store it cannot probe, and a bucket the platform will create', async () => {
    const { checks, code } = await doctor(await project(await fixtureProfile('local')), {
      environment: {
        OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'object-store-secret',
        OBJECT_STORAGE_ENDPOINT: 'http://objects.example:8333',
      },
      probes: { ...answeringProbes, objects: () => Promise.resolve('absent') },
    });

    expect(find(checks, 'stores', 'relational')).toMatchObject({ status: 'warn' });
    expect(find(checks, 'stores', 'objects')).toMatchObject({ status: 'warn' });
    expect(find(checks, 'stores', 'objects')?.detail).toContain('does not exist yet');
    expect(code).toBe(0);
  });

  it('fails the store that does not answer, without its driver text, and reports the rest unchecked', async () => {
    const { checks, code, stdout, stderr } = await doctor(
      await project(await fixtureProfile('gcp')),
      {
        environment: { DATABASE_URL: 'postgres://u:hunter2@db.example/x' },
        probes: {
          ...answeringProbes,
          relational: () =>
            Promise.reject(new Error('connect ECONNREFUSED postgres://u:hunter2@db.example/x')),
        },
      },
    );

    expect(find(checks, 'stores', 'relational')).toMatchObject({ status: 'fail' });
    expect(find(checks, 'stores', 'objects')?.detail).toContain('not reported');
    expect(find(checks, 'stores', 'identity')?.detail).toContain('not reported');
    expect(`${stdout}${stderr}`).not.toContain('hunter2');
    expect(stderr).toContain('agent-workspace doctor: 1 check failed');
    expect(code).toBe(1);
  });

  it('fails a malformed .env without quoting it', async () => {
    const directory = await project(await fixtureProfile('gcp'), 'GATEWAY_TOKEN_SECRET tok-ABC\n');

    const { checks, code, stdout } = await doctor(directory, { projectEnvironment: true });

    expect(find(checks, 'stores', '.env')).toMatchObject({ status: 'fail' });
    expect(find(checks, 'version-skew', 'server')).toMatchObject({ status: 'warn' });
    expect(stdout).not.toContain('tok-ABC');
    expect(code).toBe(1);
  });
});

describe('agent-workspace doctor: prerequisites', () => {
  it('passes the tools the target needs, with their versions', async () => {
    const { checks } = await doctor(await project(await fixtureProfile('gcp')));

    expect(find(checks, 'prerequisites', 'terraform')).toMatchObject({
      status: 'pass',
      detail: '1.9.5',
    });
    expect(find(checks, 'prerequisites', 'docker')).toBeUndefined();
  });

  it('warns about a missing optional tool and exits 0', async () => {
    const withoutHelm = without(EVERY_TOOL, 'helm version --short');

    const { checks, code } = await doctor(await project(await fixtureProfile('gcp')), {
      command: toolsOnPath(withoutHelm),
    });

    expect(find(checks, 'prerequisites', 'helm')).toMatchObject({ status: 'warn' });
    expect(code).toBe(0);
  });

  it('fails a gcp profile without terraform, with the install page as advice', async () => {
    const withoutTerraform = without(EVERY_TOOL, 'terraform version');

    const { checks, code, stdout } = await doctor(await project(await fixtureProfile('gcp')), {
      command: toolsOnPath(withoutTerraform),
    });

    expect(find(checks, 'prerequisites', 'terraform')).toMatchObject({ status: 'fail' });
    expect(find(checks, 'prerequisites', 'terraform')?.advice).toContain(
      'https://developer.hashicorp.com/terraform/install',
    );
    expect(stdout).toMatch(/^fail {2}prerequisites {2}terraform: /mu);
    expect(code).toBe(1);
  });
});

describe('agent-workspace doctor: version skew', () => {
  it('passes a server that serves this CLI', async () => {
    const { checks } = await doctor(await project(await fixtureProfile('gcp')));

    expect(find(checks, 'version-skew', 'server')).toMatchObject({ status: 'pass' });
  });

  it('warns when there is no server URL, no served range, or no answer', async () => {
    const directory = await project(await fixtureProfile('gcp'));

    const unset = await doctor(directory, { environment: {} });
    const silent = await doctor(directory, { fetch: server(null) });
    const down = await doctor(directory, { fetch: unreachable });

    expect(find(unset.checks, 'version-skew', 'server')?.detail).toContain('AGENT_WORKSPACE_URL');
    expect(find(silent.checks, 'version-skew', 'server')?.detail).toContain(
      'states no contracts version',
    );
    expect(find(down.checks, 'version-skew', 'server')?.detail).toContain('could not be reached');
    expect([unset.code, silent.code, down.code]).toEqual([0, 0, 0]);
  });

  it('fails a server outside the supported range, naming both versions and the fix', async () => {
    const { checks, code } = await doctor(await project(await fixtureProfile('gcp')), {
      fetch: server(['99.0.0', '99.1.0']),
    });

    const skew = find(checks, 'version-skew', 'server');
    expect(skew).toMatchObject({ status: 'fail' });
    expect(skew?.detail).toContain(`built against contracts ${CONTRACTS_VERSION}`);
    expect(skew?.detail).toContain('serves contracts 99.0.0 to 99.1.0');
    expect(skew?.detail).toContain('npm install --global @indx-workspace/cli@99.1');
    expect(code).toBe(1);
  });
});

describe('agent-workspace doctor: secrets and exit code', () => {
  it('never prints a password or token from the profile or .env, as text or JSON', async () => {
    const profile = (await fixtureProfile('gcp')).replace(
      'relational: cloud-sql',
      'relational: postgres://admin:S3cretPw@db.example/aw',
    );
    const directory = await project(
      profile,
      [
        'BOOTSTRAP_ADMIN_PASSWORD=pw-XYZ',
        'GATEWAY_TOKEN_SECRET=tok-ABC',
        'RUNNER_MANAGER_TOKEN=runner-tok-123',
        'DATABASE_URL=postgres://u:dbpass@h/x',
        'AGENT_WORKSPACE_URL=https://ops:urlpass@aw.example',
        '',
      ].join('\n'),
    );

    const run = await doctor(directory, {
      // Read the project's own `.env`, and make each path that echoes input fail.
      projectEnvironment: true,
      fetch: server(['99.0.0', '99.1.0']),
      probes: {
        ...answeringProbes,
        relational: (url) => Promise.reject(new Error(`password authentication failed: ${url}`)),
      },
    });

    expect(find(run.checks, 'version-skew', 'server')?.detail).toContain('https://***@aw.example');
    for (const secret of ['S3cretPw', 'pw-XYZ', 'tok-ABC', 'runner-tok-123', 'dbpass', 'urlpass']) {
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }
    expect(run.code).toBe(1);
  });

  it('masks a credential a profile refusal quotes', async () => {
    const profile = (await fixtureProfile('gcp')).replace(
      'apiVersion: agentworkspace.dev/v1',
      'apiVersion: postgres://x:leakpw1@h/y',
    );

    const { checks, stdout } = await doctor(await project(profile));

    expect(find(checks, 'profile', 'agent-workspace.yaml')?.detail).toContain('postgres://***@h/y');
    expect(stdout).not.toContain('leakpw1');
  });

  it('exits 0 with only warnings, and writes the report before refusing on a failure', async () => {
    const directory = await project(await fixtureProfile('gcp'));

    const warned = await doctor(directory, { fetch: unreachable });
    const failed = await doctor(directory, { command: toolsOnPath({}) });

    expect(warned.checks.some(({ status }) => status === 'warn')).toBe(true);
    expect(warned.checks.some(({ status }) => status === 'fail')).toBe(false);
    expect(warned.code).toBe(0);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain('failed\n');
    expect(failed.stderr).toBe(
      'agent-workspace doctor: 1 check failed\nagent-workspace doctor: 1 check failed\n',
    );
  });

  it('refuses an unknown option and a second directory', async () => {
    await expect(runDoctorCommand(['--fix'])).rejects.toThrow('unknown option "--fix"');
    await expect(runDoctorCommand(['a', 'b'])).rejects.toThrow('takes one directory');
  });
});
