import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { DeploymentImages } from '../deployment.js';
import { validateProfile, type DeploymentCloud } from '../profile.js';
import { parseDeployArguments } from './command.js';
import { selectTarget, type RequestedTarget } from './targets.js';

const images: DeploymentImages = {
  web: 'registry.example/web@sha256:1',
  gateway: 'registry.example/gateway@sha256:2',
  runner: 'registry.example/runner@sha256:3',
  runtime: 'registry.example/runtime@sha256:4',
};
const projectDirectory = path.resolve('acme-ai');
const infraDirectory = path.resolve('infra');

const STORAGE: Readonly<Record<DeploymentCloud, Readonly<Record<string, string>>>> = {
  local: { relational: 'compose-postgres', objects: 's3://agent-workspace', secrets: 'local-key' },
  aws: { relational: 'rds', objects: 's3://acme-ai-files', secrets: 'local-key' },
  gcp: { relational: 'cloud-sql', objects: 'gcs://acme-ai-files', secrets: 'secret-manager' },
  azure: { relational: 'azure-postgres', objects: 'azblob://acme-ai-files', secrets: 'key-vault' },
  vercel: { relational: 'neon', objects: 's3://acme-ai-files', secrets: 'local-key' },
  cloudflare: { relational: 'neon', objects: 's3://acme-ai-files', secrets: 'local-key' },
};
const RUNTIME: Readonly<Record<DeploymentCloud, string>> = {
  local: 'docker',
  aws: 'kubernetes',
  gcp: 'cloud-run-service',
  azure: 'aca-sessions',
  vercel: 'vercel-sandbox',
  cloudflare: 'cloudflare-sandbox',
};

function select(
  cloud: DeploymentCloud,
  requested: RequestedTarget | null = null,
  options: { objects?: string; infra?: string | null } = {},
) {
  const profile = validateProfile({
    cloud,
    storage: {
      ...STORAGE[cloud],
      ...(options.objects === undefined ? {} : { objects: options.objects }),
    },
    runtime: { default: RUNTIME[cloud] },
    identity: { bootstrapAdmin: 'admin@localhost.test' },
  });
  return selectTarget({
    profile,
    images,
    requested,
    projectDirectory,
    infraDirectory: options.infra === undefined ? infraDirectory : options.infra,
  });
}

describe('selectTarget', () => {
  it('deploys local with Compose and refuses --target for it', () => {
    expect(select('local', null, { infra: null })).toEqual({ kind: 'compose' });
    expect(() => select('local', 'helm')).toThrow('does not apply to cloud "local"');
  });

  it('deploys vercel with the Vercel CLI, named after the project directory', () => {
    expect(select('vercel', null, { infra: null })).toEqual({
      kind: 'vercel',
      projectName: 'acme-ai',
      settingsFile: path.join(projectDirectory, 'deploy', 'vercel', 'vercel.json'),
    });
    expect(select('vercel', 'vercel', { infra: null }).kind).toBe('vercel');
  });

  it('deploys cloudflare with Wrangler, naming the Worker after the project directory', () => {
    expect(select('cloudflare', null, { infra: null })).toEqual({
      kind: 'cloudflare',
      workerName: 'acme-ai',
      configFile: path.join(projectDirectory, 'deploy', 'cloudflare', 'wrangler.jsonc'),
      controlPlaneWorkerName: 'acme-ai-control-plane',
      controlPlaneConfigFile: path.join(
        projectDirectory,
        'deploy',
        'cloudflare',
        'control-plane.wrangler.jsonc',
      ),
      gatewayWorkerName: 'acme-ai-gateway',
      gatewayConfigFile: path.join(
        projectDirectory,
        'deploy',
        'cloudflare',
        'gateway.wrangler.jsonc',
      ),
      managerWorkerName: 'acme-ai-manager',
      managerConfigFile: path.join(
        projectDirectory,
        'deploy',
        'cloudflare',
        'manager.wrangler.jsonc',
      ),
      frontendWorkerName: 'acme-ai-web',
    });
    expect(select('cloudflare', 'cloudflare', { infra: null }).kind).toBe('cloudflare');
  });

  it('refuses --target helm on cloudflare and --target cloudflare on every other cloud, by name', () => {
    expect(() => select('cloudflare', 'helm')).toThrow('does not apply to cloud "cloudflare"');
    expect(() => select('cloudflare', 'vercel')).toThrow('does not apply to cloud "cloudflare"');
    expect(() => select('gcp', 'cloudflare')).toThrow(
      '--target cloudflare does not apply to cloud "gcp"',
    );
    expect(() => select('vercel', 'cloudflare')).toThrow('does not apply to cloud "vercel"');
    expect(() => select('local', 'cloudflare')).toThrow('does not apply to cloud "local"');
  });

  it('refuses --target helm on vercel and --target vercel on every other cloud, by name', () => {
    expect(() => select('vercel', 'helm')).toThrow('does not apply to cloud "vercel"');
    expect(() => select('vercel', 'terraform')).toThrow('does not apply to cloud "vercel"');
    expect(() => select('gcp', 'vercel')).toThrow('--target vercel does not apply to cloud "gcp"');
    expect(() => select('aws', 'vercel')).toThrow('--target vercel does not apply to cloud "aws"');
    expect(() => select('local', 'vercel')).toThrow('does not apply to cloud "local"');
  });

  it('deploys gcp and azure with their Terraform module by default', () => {
    expect(select('gcp')).toEqual({
      kind: 'terraform',
      module: 'gcp-cloudrun',
      moduleDirectory: path.join(infraDirectory, 'terraform', 'gcp-cloudrun'),
      variablesFile: path.join(projectDirectory, 'deploy/terraform/gcp-cloudrun.auto.tfvars.json'),
    });
    expect(select('azure')).toMatchObject({ kind: 'terraform', module: 'azure-container-apps' });
  });

  it('deploys aws, and gcp with --target helm, with the chart and its cloud flavour', () => {
    const chart = path.join(infraDirectory, 'helm', 'agent-workspace');
    expect(select('aws')).toEqual({
      kind: 'helm',
      chart,
      flavourFile: path.join(chart, 'values-eks.yaml'),
      overlayFile: path.join(projectDirectory, 'deploy/helm/values.yaml'),
    });
    expect(select('gcp', 'helm')).toMatchObject({
      flavourFile: path.join(chart, 'values-gke.yaml'),
    });
  });

  it('refuses a target the profile has no artefact for, by name', () => {
    expect(() => select('aws', 'terraform')).toThrow('Cloud "aws" has no Terraform module');
    expect(() => select('azure', 'helm')).toThrow('No chart overlay was rendered');
    expect(select('azure', 'helm', { objects: 's3://acme-ai-files' })).toMatchObject({
      kind: 'helm',
      flavourFile: expect.stringMatching(/values-aks\.yaml$/u) as unknown,
    });
  });

  it('requires --infra for a cloud target', () => {
    expect(() => select('gcp', null, { infra: null })).toThrow('--infra <dir> is required');
    expect(() => select('aws', null, { infra: null })).toThrow('--infra <dir> is required');
  });
});

describe('parseDeployArguments', () => {
  it('defaults to the current directory, no apply and no target', () => {
    expect(parseDeployArguments([])).toEqual({
      directory: process.cwd(),
      apply: false,
      target: null,
      infraDirectory: null,
    });
  });

  it('reads the directory, --yes, --target and --infra in any order', () => {
    expect(
      parseDeployArguments(['--infra', 'infra', 'acme-ai', '--target', 'helm', '--yes']),
    ).toEqual({
      directory: projectDirectory,
      apply: true,
      target: 'helm',
      infraDirectory,
    });
  });

  it('refuses an unknown flag, an extra argument, a bad target and a missing value', () => {
    expect(() => parseDeployArguments(['--yse'])).toThrow('Unknown option "--yse"');
    expect(() => parseDeployArguments(['a', 'b'])).toThrow('Unexpected extra argument "b"');
    expect(() => parseDeployArguments(['--target', 'compose'])).toThrow(
      '--target must be helm, terraform, vercel or cloudflare',
    );
    expect(() => parseDeployArguments(['--infra'])).toThrow('--infra needs a value');
    expect(() => parseDeployArguments(['--target', '--yes'])).toThrow('--target needs a value');
  });
});
