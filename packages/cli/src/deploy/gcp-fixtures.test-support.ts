import type { ProductionGcp, ProjectDocument } from '@indx-workspace/contracts/project-file';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';
import type { DeploymentImages } from '../deployment.js';
export const PROJECT = 'acme-prod';
export const REGION = 'asia-northeast1';
export const REGISTRY = `${REGION}-docker.pkg.dev/${PROJECT}/acme-ai`;
export const PASSWORD = ['S3cretPassw0rd', 'XYZ', '0123456789'].join('-');
export const WEB_URL = 'https://aw-web-123456789012.asia-northeast1.run.app';
export const PROVIDERS_HASH: unknown = expect.stringMatching(/^[0-9a-f]{64}$/u);
export const digest = (character: string) => `sha256:${character.repeat(64)}`;

export const release: DeploymentImages = {
  web: `ghcr.io/indxjp/aw-web@${digest('1')}`,
  gateway: `ghcr.io/indxjp/aw-gateway@${digest('2')}`,
  runner: `ghcr.io/indxjp/aw-runner@${digest('3')}`,
  runtime: `ghcr.io/indxjp/aw-runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
  toolHost: `ghcr.io/indxjp/aw-tool-host@${digest('a')}`,
};

/**
 * The release with the sandbox egress proxy pinned. A `sandboxInternet` scenario needs it: without
 * a pin or an override, `resolveEgressProxyImage` resolves the release tag on ghcr.io through the
 * host's docker, which a test must never reach. `release` itself leaves it out, as a deploy without
 * `sandboxInternet` is handed no egress proxy.
 */
export const egressRelease: DeploymentImages = {
  ...release,
  egressProxy: `ghcr.io/indxjp/aw-egress-proxy@${digest('7')}`,
};

export async function fixture(name: string): Promise<string> {
  return readFile(new URL(`./fixtures/gcp-lifecycle/${name}`, import.meta.url), 'utf8');
}

export async function gcpProject(
  name = 'acme-ai',
  extra: Partial<ProductionGcp> = {},
): Promise<ProjectDocument> {
  const read = parseProjectFile(
    await readFile(
      new URL('./fixtures/production-gcp-cloudrun.project.yaml', import.meta.url),
      'utf8',
    ),
  );
  if (read.lifted) throw new Error('not a v2 project file');
  const production = read.project.environments.production;
  if (production === undefined) throw new Error('no production environment');
  return {
    ...read.project,
    name,
    environments: {
      ...read.project.environments,
      production: { ...production, gcp: { project: PROJECT, region: REGION, ...extra } },
    },
  };
}
