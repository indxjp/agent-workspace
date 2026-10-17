import { describe, expect, it } from 'vitest';

import type { CommandProbe, CommandResult } from '../host-capabilities.js';
import { defaultProfile } from '../profile-defaults.js';
import type { DeploymentProfile } from '../profile.js';
import { checkPrerequisites, requiredTools } from './prerequisites.js';

const localProfile = defaultProfile({ cloud: 'local', projectName: 'acme-ai' });
const gcpProfile = defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' });
const awsProfile = defaultProfile({ cloud: 'aws', projectName: 'acme-ai' });
const azureProfile = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });
const vercelProfile = defaultProfile({ cloud: 'vercel', projectName: 'acme-ai' });
const cloudflareProfile = defaultProfile({ cloud: 'cloudflare', projectName: 'acme-ai' });

const found = (stdout: string): CommandResult => ({ status: 0, stdout, stderr: '' });
/** Every tool but the one this command line runs. */
function without(
  tools: Readonly<Record<string, CommandResult>>,
  line: string,
): Readonly<Record<string, CommandResult>> {
  return Object.fromEntries(Object.entries(tools).filter(([key]) => key !== line));
}

const absent: CommandResult = { status: null, stdout: '', stderr: 'spawnSync terraform ENOENT' };

/** A `PATH` made of the given command lines; anything else is not installed. */
function stubPath(installed: Readonly<Record<string, CommandResult>>) {
  const calls: string[] = [];
  const command: CommandProbe = (name, args) => {
    const line = [name, ...args].join(' ');
    calls.push(line);
    return installed[line] ?? absent;
  };
  return { calls, command };
}

const FULL_PATH: Readonly<Record<string, CommandResult>> = {
  'docker --version': found('Docker version 27.3.1, build ce12230'),
  'docker compose version --short': found('2.29.7\n'),
  'kubectl version --client': found('Client Version: v1.31.0\nKustomize Version: v5.4.2'),
  'helm version --short': found('v3.16.2+g13654a5'),
  'terraform version': found('Terraform v1.9.5\non linux_amd64'),
  'vercel --version': found('Vercel CLI 39.1.0\n'),
  'wrangler --version': found(' wrangler 4.97.0\n'),
};

function withRuntime(
  profile: DeploymentProfile,
  runtime: DeploymentProfile['runtime']['default'],
): DeploymentProfile {
  return { ...profile, runtime: { default: runtime } };
}

describe('requiredTools', () => {
  it('needs Docker and Compose for local, and nothing for the cloud tools', () => {
    expect(requiredTools(localProfile).map(({ tool }) => tool)).toEqual(['docker', 'compose']);
  });

  it('needs kubectl and helm for the aws chart', () => {
    expect(requiredTools(awsProfile)).toEqual([
      expect.objectContaining({ tool: 'kubectl', level: 'required' }),
      expect.objectContaining({ tool: 'helm', level: 'required' }),
    ]);
  });

  it('needs terraform for gcp, with the chart tools optional beside its module', () => {
    expect(requiredTools(gcpProfile)).toEqual([
      expect.objectContaining({ tool: 'terraform', level: 'required' }),
      expect.objectContaining({ tool: 'kubectl', level: 'optional' }),
      expect.objectContaining({ tool: 'helm', level: 'optional' }),
    ]);
  });

  it('needs only terraform for azure, whose Blob store gets no chart overlay', () => {
    expect(requiredTools(azureProfile).map(({ tool }) => tool)).toEqual(['terraform']);
  });

  it('needs the Vercel CLI and Docker for vercel (the one-shot migration), no chart or module', () => {
    expect(requiredTools(vercelProfile)).toEqual([
      expect.objectContaining({ tool: 'vercel', level: 'required' }),
      expect.objectContaining({
        tool: 'docker',
        level: 'required',
        reason: 'to run the database migrations once',
      }),
    ]);
  });

  it('never asks for bubblewrap: sandbox-runtime has no implementation (#818)', () => {
    const sandbox = withRuntime(localProfile, 'sandbox-runtime');
    expect(requiredTools(sandbox).map(({ tool }) => tool)).toEqual(['docker', 'compose']);
  });

  it('lets a required need outrank an optional one for the same tool', () => {
    const kubernetes = withRuntime(gcpProfile, 'kubernetes');
    expect(requiredTools(kubernetes)).toContainEqual(
      expect.objectContaining({ tool: 'kubectl', level: 'required' }),
    );
  });
});

describe('checkPrerequisites', () => {
  it('passes each tool the target needs with its version, and probes nothing else', () => {
    const { calls, command } = stubPath(FULL_PATH);

    const checks = checkPrerequisites(localProfile, command);

    expect(checks).toEqual([
      { check: 'prerequisites', subject: 'docker', status: 'pass', detail: '27.3.1', advice: null },
      {
        check: 'prerequisites',
        subject: 'compose',
        status: 'pass',
        detail: '2.29.7',
        advice: null,
      },
    ]);
    expect(calls).toEqual(['docker --version', 'docker compose version --short']);
  });

  it('passes terraform on gcp with the version it reports', () => {
    const { command } = stubPath(FULL_PATH);
    expect(checkPrerequisites(gcpProfile, command)[0]).toMatchObject({
      subject: 'terraform',
      status: 'pass',
      detail: '1.9.5',
    });
  });

  it('fails a gcp profile without terraform, and says how to install it', () => {
    const withoutTerraform = without(FULL_PATH, 'terraform version');
    const { command } = stubPath(withoutTerraform);

    const terraform = checkPrerequisites(gcpProfile, command).find(
      ({ subject }) => subject === 'terraform',
    );

    expect(terraform).toMatchObject({ status: 'fail' });
    expect(terraform?.detail).toContain('needed to apply the gcp module');
    expect(terraform?.advice).toContain('https://developer.hashicorp.com/terraform/install');
  });

  it('fails a vercel profile without the Vercel CLI, and says how to install it', () => {
    const { command } = stubPath(without(FULL_PATH, 'vercel --version'));

    const vercel = checkPrerequisites(vercelProfile, command).find(
      ({ subject }) => subject === 'vercel',
    );

    expect(vercel).toMatchObject({ status: 'fail' });
    expect(vercel?.advice).toContain('https://vercel.com/docs/cli');
  });

  it('passes the Vercel CLI with the version it reports', () => {
    const { command } = stubPath(FULL_PATH);
    expect(checkPrerequisites(vercelProfile, command)[0]).toMatchObject({
      subject: 'vercel',
      status: 'pass',
    });
  });

  it('needs Wrangler and Docker for cloudflare, and says how to install Wrangler when it is missing', () => {
    expect(requiredTools(cloudflareProfile)).toEqual([
      expect.objectContaining({ tool: 'wrangler', level: 'required' }),
      expect.objectContaining({ tool: 'docker', level: 'required' }),
    ]);
    const { command } = stubPath(without(FULL_PATH, 'wrangler --version'));

    const wrangler = checkPrerequisites(cloudflareProfile, command).find(
      ({ subject }) => subject === 'wrangler',
    );

    expect(wrangler).toMatchObject({ status: 'fail' });
    expect(wrangler?.advice).toContain('https://developers.cloudflare.com/workers/wrangler');
    expect(checkPrerequisites(cloudflareProfile, stubPath(FULL_PATH).command)[0]).toMatchObject({
      subject: 'wrangler',
      status: 'pass',
    });
  });

  it('only warns for a missing optional tool', () => {
    const withoutHelm = without(FULL_PATH, 'helm version --short');
    const { command } = stubPath(withoutHelm);

    const helm = checkPrerequisites(gcpProfile, command).find(({ subject }) => subject === 'helm');

    expect(helm).toMatchObject({ status: 'warn' });
    expect(helm?.advice).toContain('helm.sh');
  });

  it('fails a tool that exits non-zero, naming the command rather than quoting its output', () => {
    const { command } = stubPath({
      ...FULL_PATH,
      'docker compose version --short': {
        status: 1,
        stdout: '',
        stderr: "docker: 'compose' is not a docker command.",
      },
    });

    const compose = checkPrerequisites(localProfile, command)[1];

    expect(compose).toMatchObject({ subject: 'compose', status: 'fail' });
    expect(compose?.detail).toContain('`docker compose version --short` exited 1');
    expect(compose?.detail).not.toContain('is not a docker command');
  });

  it('warns for a tool that prints no version, and for Compose older than v2', () => {
    const { command } = stubPath({
      ...FULL_PATH,
      'docker --version': found('a wrapper script'),
      'docker compose version --short': found('1.29.2'),
    });

    const [docker, compose] = checkPrerequisites(localProfile, command);

    expect(docker).toMatchObject({ subject: 'docker', status: 'warn' });
    expect(compose).toMatchObject({ subject: 'compose', status: 'warn' });
    expect(compose?.detail).toContain('older than v2');
  });

  it('passes a target that needs no tool on PATH', () => {
    const { calls, command } = stubPath({});
    const noTools = {
      ...azureProfile,
      cloud: 'aws' as const,
      storage: { ...azureProfile.storage, objects: 'local-filesystem' },
    };

    expect(checkPrerequisites(withRuntime(noTools, 'local'), command)).toEqual([
      expect.objectContaining({ subject: 'tools', status: 'pass' }),
    ]);
    expect(calls).toEqual([]);
  });
});
