import { readFile } from 'node:fs/promises';

import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { parseEnvironment, type DeploymentImages } from '../deployment.js';
import { defaultProfile } from '../profile-defaults.js';
import { renderEnv, type EnvSecrets } from './env.js';

interface ComposeFile {
  readonly services: Record<
    string,
    {
      readonly ports?: readonly string[];
      readonly networks?: readonly string[];
      readonly environment?: Record<string, string>;
    }
  >;
  readonly networks: Record<string, { readonly internal?: boolean } | null>;
}

const ROOT_BINDING = '127.0.0.1:8333:8333';
const TEMPLATE_BINDING = '127.0.0.1:${SEAWEEDFS_PORT:-8333}:8333';
const PUBLIC_ENDPOINT = 'OBJECT_STORAGE_PUBLIC_ENDPOINT';

/** The host signed links name: the `publicEndpoint` of an `AW_STORAGE_URL`, if it has one. */
function signedFor(url: string | undefined): string | undefined {
  const parsed = parseStorageUrl(url ?? '');
  return parsed.ok && parsed.location.kind === 's3' ? parsed.location.publicEndpoint : undefined;
}

async function readCompose(url: URL): Promise<ComposeFile> {
  return parseYaml(await readFile(url, 'utf8'), { merge: true }) as ComposeFile;
}

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const images: DeploymentImages = {
  web: `registry.example/web@${digest('1')}`,
  gateway: `registry.example/gateway@${digest('2')}`,
  runner: `registry.example/runner@${digest('3')}`,
  runtime: `registry.example/runtime@${digest('4')}`,
  postgres: `registry.example/postgres@${digest('5')}`,
  seaweedfs: `registry.example/seaweedfs@${digest('6')}`,
};
const secrets: EnvSecrets = {
  adminPassword: 'admin-password',
  postgresPassword: 'postgres-password',
  objectStoreSecretKey: 'object-store-secret',
  masterEncryptionKey: 'a'.repeat(64),
  gatewayTokenSecret: 'b'.repeat(64),
  runnerManagerToken: 'c'.repeat(64),
  sessionSecret: 'd'.repeat(64),
  cronSecret: 'e'.repeat(64),
};

const renderedEnv = (localObjectStore: 'local-filesystem' | 'seaweedfs') =>
  parseEnvironment(
    renderEnv({
      profile: defaultProfile({ cloud: 'local', projectName: 'example', localObjectStore }),
      secrets,
      images,
      dockerGroupId: 0,
      projectName: 'acme-ai',
    }),
  );

/** Where the host's browser reaches a loopback `host:published:container` binding. */
function bindingOrigin(binding: string): string {
  const [, published] = binding.split(':');
  return `http://localhost:${published}`;
}

// @story US-STO-02
describe('compose signed uploads', () => {
  it('[US-STO-02][unit][cli] root compose publishes SeaweedFS on loopback and signs links for it', async () => {
    const root = await readCompose(new URL('../../../../compose.yaml', import.meta.url));

    expect(root.services['seaweedfs']?.ports).toEqual([ROOT_BINDING]);
    // The old name is only forwarded, so a leftover value is warned about and never signs.
    expect(root.services['web']?.environment?.[PUBLIC_ENDPOINT]).toBe(`\${${PUBLIC_ENDPOINT}:-}`);
    const example = parseEnvironment(
      await readFile(new URL('../../../../.env.example', import.meta.url), 'utf8'),
    );
    expect(signedFor(example['AW_STORAGE_URL'])).toBe(bindingOrigin(ROOT_BINDING));
  });

  it('[US-STO-02][unit][cli] the template publishes SeaweedFS on the SEAWEEDFS_PORT loopback port', async () => {
    const template = await readCompose(new URL('../../templates/compose.yaml', import.meta.url));

    expect(template.services['seaweedfs']?.ports).toEqual([TEMPLATE_BINDING]);
    expect(template.services['web']?.environment?.[PUBLIC_ENDPOINT]).toBe(
      `\${${PUBLIC_ENDPOINT}:-}`,
    );
  });

  it.each([
    { name: 'a SeaweedFS project signs for its SEAWEEDFS_PORT', store: 'seaweedfs', signs: true },
    { name: 'a local-filesystem project signs nothing', store: 'local-filesystem', signs: false },
  ] as const)('[US-STO-02][unit][cli] $name', ({ store, signs }) => {
    const env = renderedEnv(store);
    expect(env['SEAWEEDFS_PORT']).toBe('8333');
    expect(signedFor(env['AW_STORAGE_URL'])).toBe(
      signs ? `http://localhost:${env['SEAWEEDFS_PORT'] ?? ''}` : undefined,
    );
  });

  it('[US-STO-02][unit][cli] the template gives the published SeaweedFS port a non-internal network', async () => {
    const { services, networks } = await readCompose(
      new URL('../../templates/compose.yaml', import.meta.url),
    );
    const external = (services['seaweedfs']?.networks ?? []).filter(
      (network) => networks[network]?.internal !== true,
    );
    expect(external).not.toEqual([]);
  });
});
