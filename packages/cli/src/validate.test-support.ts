import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, vi } from 'vitest';

import type { DeploymentImages } from './deployment.js';
import { defaultProfile } from './profile-defaults.js';
import { renderProfileDocument, type DeploymentProfile } from './profile.js';
import { type EnvSecrets } from './render/env.js';
import { runProfileProbes, type ProfileProbes } from './validate.js';

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((entry) => rm(entry, { recursive: true })));
  vi.restoreAllMocks();
});

export const localProfile = defaultProfile({
  cloud: 'local',
  projectName: 'acme-ai',
  localObjectStore: 'seaweedfs',
});
export const gcpProfile = defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' });
export const azureProfile = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });

const digest = (character: string) => `registry.example/image@sha256:${character.repeat(64)}`;
export const images: DeploymentImages = {
  web: digest('1'),
  gateway: digest('2'),
  runner: digest('3'),
  runtime: digest('4'),
  postgres: digest('5'),
  seaweedfs: digest('6'),
};
export const secrets: EnvSecrets = {
  adminPassword: 'admin-password',
  postgresPassword: 'pw',
  objectStoreSecretKey: 'object-store-secret',
  masterEncryptionKey: 'a'.repeat(64),
  gatewayTokenSecret: 'b'.repeat(64),
  runnerManagerToken: 'c'.repeat(64),
  sessionSecret: 'd'.repeat(64),
  cronSecret: 'e'.repeat(64),
};

/** Every probe is injected, so nothing in this file opens a socket. */
export function recordingProbes(overrides: Partial<ProfileProbes> = {}) {
  const calls: string[] = [];
  const record = (entry: string) => {
    calls.push(entry);
    return Promise.resolve();
  };
  const probes: ProfileProbes = {
    relational: (url) => record(`relational:${url}`),
    // The default double answers for a bucket that is there; `missing` has its own test.
    objects: (input) => record(`objects:${input.bucket}`).then(() => 'present' as const),
    identity: (issuer) => record(`identity:${issuer}`),
    ...overrides,
  };
  return { calls, probes };
}

export const outcomes = (results: Awaited<ReturnType<typeof runProfileProbes>>) =>
  Object.fromEntries(results.map(({ store, outcome }) => [store, outcome]));

/**
 * The local profile names `compose-postgres`, so its connection string is a credential the
 * environment carries — exactly as `rds` or `cloud-sql` do. This is what the rendered `.env`
 * holds, and the host it names is one of the Compose services, which is why a test about the
 * probe machinery itself uses the managed URL below instead.
 */
export const COMPOSE_DATABASE_URL = 'postgres://agent_workspace:pw@postgres:5432/agent_workspace';

/**
 * A store the host can actually reach. Every test about what a probe does — that it runs, that it
 * is cancellable, that its failure becomes a typed refusal — uses this, because a store on a
 * Compose service is skipped before any probe is reached.
 */
export const MANAGED_DATABASE_URL = 'postgres://ops:pw@10.0.0.2:5432/agent_workspace';
export const GCS_STORAGE = { AW_STORAGE_URL: 'gcs://acme-ai-files' };
export const MANAGED_STORE_ENVIRONMENT = { DATABASE_URL: MANAGED_DATABASE_URL, ...GCS_STORAGE };

export async function projectWith(profile: DeploymentProfile) {
  const directory = await validationDirectory();
  await writeFile(
    path.join(directory, 'agent-workspace.yaml'),
    renderProfileDocument(profile),
    'utf8',
  );
  return directory;
}
export async function validationDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-validate-'));
  created.push(directory);
  return directory;
}
