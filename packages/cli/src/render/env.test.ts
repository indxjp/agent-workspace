import { readFile } from 'node:fs/promises';

import { parseStorageUrl } from '@indx-workspace/contracts/storage-url';
import { describe, expect, it } from 'vitest';

import { parseEnvironment, type DeploymentImages } from '../deployment.js';
import { defaultProfile } from '../profile-defaults.js';
import { PLATFORM_IMAGE_VERSION } from '../release-images.js';
import { composeProjectName, ENV_VERSION_KEY, renderEnv, type EnvSecrets } from './env.js';

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

const render = (profile: ReturnType<typeof defaultProfile>) =>
  parseEnvironment(
    renderEnv({ profile, secrets, images, dockerGroupId: 0, projectName: 'acme-ai' }),
  );

const localProfile = (localObjectStore: 'local-filesystem' | 'seaweedfs') =>
  defaultProfile({
    cloud: 'local',
    projectName: 'example',
    localObjectStore,
  });

/**
 * The unbroken run of comment lines immediately above one variable, which is where the renderer
 * names whatever supplies a value it deliberately leaves empty.
 */
function commentAbove(variable: string, cloud: 'aws' | 'gcp' | 'azure' | 'local'): string {
  const lines = renderEnv({
    profile:
      cloud === 'local'
        ? localProfile('seaweedfs')
        : defaultProfile({ cloud, projectName: 'acme-ai' }),
    secrets,
    images,
    dockerGroupId: 0,
    projectName: 'acme-ai',
  }).split('\n');
  const declaredAt = lines.findIndex((line) => line.startsWith(`${variable}=`));
  expect(declaredAt, `${cloud} renders no ${variable}`).toBeGreaterThan(-1);
  const above: string[] = [];
  for (let index = declaredAt - 1; lines[index]?.startsWith('#') === true; index -= 1) {
    above.unshift(lines[index] ?? '');
  }
  return above.join('\n');
}

/**
 * `.env.example` is the documented inventory of what a deployment is configured with, and
 * `docs/sdk/site/concepts/data-plane.mdx` prints the same list with each variable's reader. This
 * is the mechanical form of the unit's first acceptance criterion: whatever an operator would
 * have assembled by hand from the deploy guide, the renderer produces.
 */
describe('the rendered environment against the documented inventory', () => {
  it('renders every variable `.env.example` declares', async () => {
    const documented = Object.keys(
      parseEnvironment(
        await readFile(new URL('../../../../.env.example', import.meta.url), 'utf8'),
      ),
    );
    expect(documented.length).toBeGreaterThan(10);
    const aws = defaultProfile({ cloud: 'aws', projectName: 'acme-ai' });
    const kms = render({ ...aws, storage: { ...aws.storage, secrets: 'kms' } });
    const rendered = [
      ...new Set([...Object.keys(render(localProfile('seaweedfs'))), ...Object.keys(kms)]),
    ];
    expect(rendered).toEqual(expect.arrayContaining(documented));
  });

  it('renders one key set for every cloud, so a profile change cannot silently drop a variable', () => {
    const keysFor = (cloud: 'aws' | 'gcp' | 'azure' | 'local') =>
      Object.keys(render(defaultProfile({ cloud, projectName: 'acme-ai' }))).sort();
    const local = keysFor('local');
    expect(local).toEqual([
      'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK',
      'AWS_REGION',
      'AW_SESSION_MIRROR_URL',
      'AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES',
      'AW_STORAGE_URL',
      'AW_TRUSTED_PROXY_HOPS',
      'AZURE_KEY_VAULT_URL',
      'AZURE_MASTER_KEY_SECRET_NAME',
      'BOOTSTRAP_ADMIN',
      'BOOTSTRAP_ADMIN_PASSWORD',
      'COMPOSE_PROFILES',
      'COMPOSE_PROJECT_NAME',
      'DATABASE_URL',
      'DOCKER_GID',
      'GATEWAY_IMAGE',
      'GATEWAY_PRICING_JSON',
      'GATEWAY_TOKEN_SECRET',
      'GCP_MASTER_KEY_SECRET',
      'MASTER_ENCRYPTION_KEY',
      'MASTER_KEY_PROVIDER',
      'MODEL_GATEWAY_URL',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
      'PORT',
      'POSTGRES_DB',
      'POSTGRES_IMAGE',
      'POSTGRES_PASSWORD',
      'POSTGRES_USER',
      'RUNNER_IMAGE',
      'RUNNER_MANAGER_TOKEN',
      'RUNNER_MANAGER_URL',
      'RUNNER_URL',
      'RUNTIME_DRIVER',
      'SEAWEEDFS_ACCESS_KEY_ID',
      'SEAWEEDFS_ALLOWED_ORIGINS',
      'SEAWEEDFS_IMAGE',
      'SEAWEEDFS_PORT',
      'SEAWEEDFS_SECRET_ACCESS_KEY',
      'SESSION_SECRET',
      'WEB_IMAGE',
      'WORKSPACE_NAME',
      'WORKSPACE_SLUG',
    ]);
    // The four exceptions are Compose's own: two images pin services no cloud deployment runs,
    // PORT is the host port the Compose project publishes the web service on, and
    // COMPOSE_PROJECT_NAME names that project and its networks. Everything else
    // must be identical, so a variable cannot be dropped for one cloud and kept for another.
    const composeOnlyKeys = ['COMPOSE_PROJECT_NAME', 'PORT', 'POSTGRES_IMAGE', 'SEAWEEDFS_IMAGE'];
    const cloudKeys = local.filter((key) => !composeOnlyKeys.includes(key));
    for (const cloud of ['aws', 'gcp', 'azure'] as const) expect(keysFor(cloud)).toEqual(cloudKeys);
  });

  /**
   * A cluster takes each listener from the chart, which sets `PORT` per container from the port
   * that container publishes (`infra/helm/agent-workspace/templates/deployments.yaml`). A `PORT`
   * in the Secret built from this file would be a value nothing reads at best, and one that moves
   * a listener away from its Service at worst.
   */
  it('renders PORT for the Compose project alone', () => {
    expect(render(localProfile('seaweedfs'))['PORT']).toBe('127.0.0.1:3000');
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      expect(
        Object.keys(render(defaultProfile({ cloud, projectName: 'acme-ai' }))),
        `the ${cloud} .env renders PORT`,
      ).not.toContain('PORT');
    }
  });

  it('adds the four OIDC names together, and only when the profile names an issuer', () => {
    const base = localProfile('seaweedfs');
    expect(Object.keys(render(base))).not.toContain('OIDC_ISSUER_URL');
    const rendered = render({
      ...base,
      identity: { ...base.identity, oidc: 'https://accounts.google.com' },
    });
    expect(rendered['OIDC_ISSUER_URL']).toBe('https://accounts.google.com');
    // The client registration's secret never enters a generated file; the names exist so the
    // deployment fails on an incomplete set rather than silently running without OIDC.
    expect(rendered['OIDC_CLIENT_ID']).toBe('');
    expect(rendered['OIDC_CLIENT_SECRET']).toBe('');
    expect(rendered['OIDC_REDIRECT_URI']).toBe('');
  });
});

describe('the object store each profile selects', () => {
  // @story US-STO-10
  it('[US-STO-10][api][cli] create renders one AW_STORAGE_URL and no legacy storage variables', () => {
    const legacy = [
      'OBJECT_STORAGE_BACKEND',
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_FORCE_PATH_STYLE',
      'AW_FILE_STORAGE_ROOT',
      'AW_SKILL_STORAGE_ROOT',
      'AW_SESSION_TRANSCRIPT_ROOT',
    ];
    const cases = [
      ['local', localProfile('local-filesystem'), 'file:///var/lib/agent-workspace'],
      // The bucket, endpoint and path style the old names gave the bundled SeaweedFS.
      [
        'local SeaweedFS',
        localProfile('seaweedfs'),
        's3://agent-workspace?endpoint=http://seaweedfs:8333&publicEndpoint=http://localhost:8333&pathStyle=true',
      ],
      ['aws', defaultProfile({ cloud: 'aws', projectName: 'acme-ai' }), 's3://acme-ai-files'],
      ['gcp', defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' }), 'gcs://acme-ai-files'],
      ['vercel', defaultProfile({ cloud: 'vercel', projectName: 'acme-ai' }), 's3://acme-ai-files'],
      // `deploy` adds the account's R2 endpoint.
      [
        'cloudflare',
        defaultProfile({ cloud: 'cloudflare', projectName: 'acme-ai' }),
        's3://acme-ai-files?region=auto',
      ],
      // The account is a Terraform output, so the module supplies the URL.
      ['azure', defaultProfile({ cloud: 'azure', projectName: 'acme-ai' }), ''],
    ] as const;
    for (const [name, profile, url] of cases) {
      const text = renderEnv({
        profile,
        secrets,
        images,
        dockerGroupId: 0,
        projectName: 'acme-ai',
      });
      expect(text.match(/^AW_STORAGE_URL=/gmu), `${name} renders one AW_STORAGE_URL`).toHaveLength(
        1,
      );
      const rendered = parseEnvironment(text);
      expect(rendered['AW_STORAGE_URL'], name).toBe(url);
      expect(rendered['AW_STORAGE_SIGNED_UPLOAD_MAX_BYTES'], name).toBe('');
      for (const key of legacy)
        expect(Object.keys(rendered), `${name} renders ${key}`).not.toContain(key);
      if (url !== '') {
        expect(parseStorageUrl(url).ok, name).toBe(true);
        expect(url, name).not.toContain('@');
      }
    }
  });

  it('wires the Compose SeaweedFS service, under its Compose profile', () => {
    expect(render(localProfile('seaweedfs'))).toMatchObject({
      COMPOSE_PROFILES: 'object-storage',
      AW_STORAGE_CREATE_BUCKET: 'true',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: secrets.objectStoreSecretKey,
    });
    // Only the bundled SeaweedFS asks the server to create its bucket.
    expect(render(localProfile('local-filesystem'))['AW_STORAGE_CREATE_BUCKET']).toBeUndefined();
  });

  it('leaves the object store unset for the local-filesystem provider', () => {
    expect(render(localProfile('local-filesystem'))).toMatchObject({
      COMPOSE_PROFILES: '',
      AW_STORAGE_URL: 'file:///var/lib/agent-workspace',
      OBJECT_STORAGE_ACCESS_KEY_ID: '',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    });
  });

  it('names the bucket but no credential on a cloud, because IAM or the key service holds it', () => {
    const aws = render(defaultProfile({ cloud: 'aws', projectName: 'acme-ai' }));
    expect(aws).toMatchObject({
      AW_STORAGE_URL: 's3://acme-ai-files',
      OBJECT_STORAGE_ACCESS_KEY_ID: '',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    });
    // A blank with nothing above it saying who fills it is the failure the comment prevents.
    expect(commentAbove('OBJECT_STORAGE_ACCESS_KEY_ID', 'aws')).toMatch(
      /IAM role or workload identity, or a[\s\S]*key service/u,
    );
    // Compose's SeaweedFS credential is one the generator invents, so there is nothing to name.
    expect(commentAbove('OBJECT_STORAGE_ACCESS_KEY_ID', 'local')).toBe('');
    // Azure's native provider uses managed identity rather than the S3 credential fields.
    const azure = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });
    expect(azure.storage.objects).toBe('azblob://acme-ai-files');
    expect(commentAbove('OBJECT_STORAGE_ACCESS_KEY_ID', 'azure')).toMatch(
      /managed identity[\s\S]*No account key/u,
    );
    expect(commentAbove('AW_STORAGE_URL', 'azure')).toMatch(
      /Container Apps Terraform module supplies the Blob store/u,
    );
    expect(render(azure)).toMatchObject({
      AW_STORAGE_URL: '',
      OBJECT_STORAGE_ACCESS_KEY_ID: '',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    });
    // GCS uses the native API and the workload identity; it never needs an HMAC pair.
    expect(render(defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' }))).toMatchObject({
      AW_STORAGE_URL: 'gcs://acme-ai-files',
      OBJECT_STORAGE_ACCESS_KEY_ID: '',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    });
    expect(commentAbove('OBJECT_STORAGE_ACCESS_KEY_ID', 'gcp')).toMatch(
      /Application Default Credentials/u,
    );
  });
});

describe('the master-key provider each profile selects', () => {
  it('writes a local key only for the local-key provider', () => {
    expect(render(localProfile('seaweedfs'))).toMatchObject({
      MASTER_KEY_PROVIDER: 'local-key',
      MASTER_ENCRYPTION_KEY: secrets.masterEncryptionKey,
      GCP_MASTER_KEY_SECRET: '',
    });
  });

  it('selects Secret Manager on GCP without writing the key into the rendered file', () => {
    const gcp = render(defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' }));
    expect(gcp).toMatchObject({
      MASTER_KEY_PROVIDER: 'secret-manager',
      MASTER_ENCRYPTION_KEY: '',
      GCP_MASTER_KEY_SECRET: '',
    });
    expect(commentAbove('GCP_MASTER_KEY_SECRET', 'gcp')).toMatch(/Terraform supplies/u);
  });
});

describe('the secret backend each profile selects', () => {
  it('selects Key Vault without writing the generated master key into Azure output', () => {
    const azure = render(defaultProfile({ cloud: 'azure', projectName: 'acme-ai' }));
    expect(azure).toMatchObject({
      MASTER_KEY_PROVIDER: 'key-vault',
      AZURE_KEY_VAULT_URL: '',
      AZURE_MASTER_KEY_SECRET_NAME: 'master-encryption-key',
      MASTER_ENCRYPTION_KEY: '',
    });
    expect(Object.values(azure)).not.toContain(secrets.masterEncryptionKey);
    expect(render(localProfile('seaweedfs'))).toMatchObject({
      MASTER_KEY_PROVIDER: 'local-key',
      MASTER_ENCRYPTION_KEY: secrets.masterEncryptionKey,
      AZURE_MASTER_KEY_SECRET_NAME: '',
    });
  });
});

describe('the Compose project name', () => {
  it('renders COMPOSE_PROJECT_NAME for the Compose project alone, from the directory name', () => {
    expect(render(localProfile('seaweedfs'))['COMPOSE_PROJECT_NAME']).toBe('acme-ai');
    for (const cloud of ['aws', 'gcp', 'azure'] as const) {
      expect(Object.keys(render(defaultProfile({ cloud, projectName: 'acme-ai' })))).not.toContain(
        'COMPOSE_PROJECT_NAME',
      );
    }
  });

  it.each([
    ['my-agent-platform', 'my-agent-platform'],
    ['Acme AI.Platform', 'acme-ai-platform'],
    ['__demo__', 'demo'],
    ['team_one--two', 'team_one-two'],
    ['9lives', '9lives'],
    [`${'a'.repeat(60)}-b`, 'a'.repeat(48)],
  ])('sanitises %j to the Compose name %j', (directory, expected) => {
    expect(composeProjectName(directory)).toBe(expected);
  });

  it('gives a directory with no usable character a stable name of its own', () => {
    const name = composeProjectName('デモ');
    expect(name).toMatch(/^agent-workspace-[0-9a-f]{12}$/u);
    expect(composeProjectName('デモ')).toBe(name);
    expect(composeProjectName('テスト')).not.toBe(name);
  });

  it("never takes the repository dev stack's project name, agent-workspace", () => {
    expect(composeProjectName('agent-workspace')).toMatch(/^agent-workspace-[0-9a-f]{12}$/u);
    expect(composeProjectName('Agent Workspace')).toMatch(/^agent-workspace-[0-9a-f]{12}$/u);
    expect(composeProjectName('agent-workspace-2')).toBe('agent-workspace-2');
  });

  it('only ever returns a name Compose accepts', () => {
    for (const directory of ['-', '.', 'A', 'x'.repeat(200), ' spaced out ', 'dots.and_under']) {
      expect(composeProjectName(directory)).toMatch(/^[a-z0-9][a-z0-9_-]*$/u);
    }
  });
});

describe('the rest of the placement', () => {
  it('renders AWS KMS selection without rendering a plaintext master key', () => {
    const awsDefault = defaultProfile({ cloud: 'aws', projectName: 'acme-ai' });
    expect(awsDefault.storage.secrets).toBe('local-key');
    const aws = render({
      ...awsDefault,
      storage: { ...awsDefault.storage, secrets: 'kms' },
    });
    expect(aws).toMatchObject({
      MASTER_KEY_PROVIDER: 'kms',
      MASTER_ENCRYPTION_KEY: '',
      AWS_KMS_KEY_ID: '',
      AWS_KMS_ENCRYPTED_MASTER_KEY: '',
    });
    expect(JSON.stringify(aws)).not.toContain(secrets.masterEncryptionKey);

    const local = render(localProfile('seaweedfs'));
    expect(local).toMatchObject({
      MASTER_KEY_PROVIDER: 'local-key',
      MASTER_ENCRYPTION_KEY: secrets.masterEncryptionKey,
    });
    expect(Object.keys(local)).not.toContain('AWS_KMS_KEY_ID');
    expect(Object.keys(local)).not.toContain('AWS_KMS_ENCRYPTED_MASTER_KEY');
  });

  // The profile names `compose-postgres`; the connection string carrying the generated password
  // is assembled here, so `.env` is the only artefact that holds it.
  it('assembles the Compose connection string and leaves a managed one to its cloud', () => {
    const local = localProfile('seaweedfs');
    expect(local.storage.relational).toBe('compose-postgres');
    expect(render(local)['DATABASE_URL']).toBe(
      `postgres://agent_workspace:${secrets.postgresPassword}@postgres:5432/agent_workspace`,
    );
    const gcp = render(defaultProfile({ cloud: 'gcp', projectName: 'a' }));
    expect(gcp['DATABASE_URL']).toBe('');
    expect(gcp['POSTGRES_PASSWORD']).toBe('');
  });

  /**
   * There is no `infra/terraform` module for AWS — an EKS cluster the operator already runs is
   * installed with the chart alone — so naming one would point an operator at something that does
   * not exist and leave `DATABASE_URL` with no stated source at all.
   */
  it('names the operator, not a module, as what provisions the AWS relational store', () => {
    const aws = renderEnv({
      profile: defaultProfile({ cloud: 'aws', projectName: 'acme-ai' }),
      secrets,
      images,
      dockerGroupId: 0,
      projectName: 'acme-ai',
    });
    expect(aws).not.toMatch(/module provisions it/u);
    expect(aws).toContain(
      '# You provision it and put its URL in the Secret the chart names in ' +
        'external.databaseUrlSecret.',
    );
    // The two clouds that do have a module still say so.
    for (const cloud of ['gcp', 'azure'] as const) {
      expect(
        renderEnv({
          profile: defaultProfile({ cloud, projectName: 'acme-ai' }),
          secrets,
          images,
          dockerGroupId: 0,
          projectName: 'acme-ai',
        }),
      ).toContain(`# The ${cloud} module provisions it and supplies DATABASE_URL as a secret.`);
    }
  });

  it('renders a connection string the profile states as it stands', () => {
    const stated = 'postgres://ops:pw@db.acme.example:5432/agent_workspace';
    const profile = {
      ...localProfile('seaweedfs'),
      storage: { ...localProfile('seaweedfs').storage, relational: stated },
    };
    expect(render(profile)['DATABASE_URL']).toBe(stated);
  });

  it('points a cloud deployment at the Services the chart publishes, except the runner', () => {
    const rendered = renderEnv({
      profile: defaultProfile({ cloud: 'aws', projectName: 'acme-ai' }),
      secrets,
      images,
      dockerGroupId: 0,
      projectName: 'acme-ai',
    });
    expect(parseEnvironment(rendered)).toMatchObject({
      MODEL_GATEWAY_URL: 'http://agent-workspace-gateway:4000',
      AW_SESSION_MIRROR_URL: 'http://agent-workspace-web:3000',
      RUNNER_MANAGER_URL: 'http://agent-workspace-runner-manager:8080',
      RUNNER_URL: '',
    });
    // The one blank left is blank on purpose, and the file says what fills it.
    expect(rendered).toContain('# RUNNER_URL has no fixed address in either');
    expect(render(localProfile('seaweedfs'))).toMatchObject({
      MODEL_GATEWAY_URL: 'http://gateway:4000',
      AW_SESSION_MIRROR_URL: 'http://web:3000',
      RUNNER_MANAGER_URL: 'http://runner:8090',
      RUNNER_URL: 'http://runner:8080',
    });
  });

  // The Compose project is the only deployment that runs PostgreSQL and SeaweedFS itself, so a cloud
  // reference set carries neither and the rendered file pins neither.
  it('pins the Compose images for the Compose project alone', () => {
    const cloudImages: DeploymentImages = {
      web: images.web,
      gateway: images.gateway,
      runner: images.runner,
      runtime: images.runtime,
    };
    const rendered = parseEnvironment(
      renderEnv({
        profile: defaultProfile({ cloud: 'gcp', projectName: 'acme-ai' }),
        secrets,
        images: cloudImages,
        dockerGroupId: 0,
        projectName: 'acme-ai',
      }),
    );
    expect(Object.keys(rendered)).not.toContain('POSTGRES_IMAGE');
    expect(Object.keys(rendered)).not.toContain('SEAWEEDFS_IMAGE');
    expect(render(localProfile('seaweedfs'))).toMatchObject({
      POSTGRES_IMAGE: images.postgres,
      SEAWEEDFS_IMAGE: images.seaweedfs,
    });
  });

  it('refuses to render the Compose project without the two images it runs', () => {
    expect(() =>
      renderEnv({
        profile: localProfile('seaweedfs'),
        secrets,
        images: {
          web: images.web,
          gateway: images.gateway,
          runner: images.runner,
          runtime: images.runtime,
        },
        dockerGroupId: 0,
        projectName: 'acme-ai',
      }),
    ).toThrow(/POSTGRES_IMAGE and SEAWEEDFS_IMAGE/u);
  });

  it('states the proxy hop count rather than leaving public shares to fail closed', () => {
    expect(render(localProfile('seaweedfs'))['AW_TRUSTED_PROXY_HOPS']).toBe('0');
    expect(
      render(defaultProfile({ cloud: 'azure', projectName: 'a' }))['AW_TRUSTED_PROXY_HOPS'],
    ).toBe('1');
  });

  it('carries the profile runtime into the driver the deployment starts', () => {
    expect(render(localProfile('seaweedfs'))['RUNTIME_DRIVER']).toBe('docker');
    expect(render(defaultProfile({ cloud: 'gcp', projectName: 'a' }))['RUNTIME_DRIVER']).toBe(
      'cloud-run-service',
    );
  });

  it('renders the Vercel placement: CRON_SECRET, no Compose or Service addresses', () => {
    const vercel = defaultProfile({ cloud: 'vercel', projectName: 'a' });
    const env = render(vercel);
    expect(env['CRON_SECRET']).toBe(secrets.cronSecret);
    expect(env['RUNTIME_DRIVER']).toBe('vercel-sandbox');
    expect(env['MASTER_KEY_PROVIDER']).toBe('local-key');
    expect(env['AW_STORAGE_URL']).toBe('s3://a-files');
    expect(env['EXTERNAL_PROVIDER']).toBeUndefined();
    for (const name of ['RUNNER_URL', 'RUNNER_MANAGER_URL', 'MODEL_GATEWAY_URL']) {
      expect(env[name], name).toBe('');
    }
    expect(env['COMPOSE_PROJECT_NAME']).toBeUndefined();

    const external = render({ ...vercel, runtime: { default: 'external' } });
    expect(external['RUNTIME_DRIVER']).toBe('external');
    expect(external['EXTERNAL_PROVIDER']).toBe('e2b');
    expect(
      render({ ...vercel, runtime: { default: 'external', provider: 'e2b' } })['EXTERNAL_PROVIDER'],
    ).toBe('e2b');
  });

  it('renders the Cloudflare placement: R2 region, CRON_SECRET, no Compose or Service addresses', () => {
    const cloudflare = defaultProfile({ cloud: 'cloudflare', projectName: 'a' });
    const env = render(cloudflare);
    expect(env['CRON_SECRET']).toBe(secrets.cronSecret);
    // E2B by default: the native cloudflare-sandbox driver runs no session yet (BH061-029).
    expect(env['RUNTIME_DRIVER']).toBe('external');
    expect(env['EXTERNAL_PROVIDER']).toBe('e2b');
    expect(env['MASTER_KEY_PROVIDER']).toBe('local-key');
    expect(env['AW_STORAGE_URL']).toBe('s3://a-files?region=auto');
    expect(env['AWS_REGION']).toBe('auto');
    for (const name of ['RUNNER_URL', 'RUNNER_MANAGER_URL', 'MODEL_GATEWAY_URL']) {
      expect(env[name], name).toBe('');
    }
    expect(env['COMPOSE_PROJECT_NAME']).toBeUndefined();
    expect(render({ ...cloudflare, runtime: { default: 'external' } })['EXTERNAL_PROVIDER']).toBe(
      'e2b',
    );
  });

  it('renders CRON_SECRET on Vercel and Cloudflare alone, so no other cloud runs a retention route', () => {
    for (const cloud of ['aws', 'gcp', 'azure', 'local'] as const) {
      const profile =
        cloud === 'local' ? localProfile('seaweedfs') : defaultProfile({ cloud, projectName: 'a' });
      expect(render(profile)['CRON_SECRET'], cloud).toBeUndefined();
    }
  });

  it('records the release the images were resolved for on Vercel alone', () => {
    expect(render(defaultProfile({ cloud: 'vercel', projectName: 'a' }))[ENV_VERSION_KEY]).toBe(
      PLATFORM_IMAGE_VERSION,
    );
    for (const cloud of ['aws', 'gcp', 'azure', 'cloudflare', 'local'] as const) {
      const profile =
        cloud === 'local' ? localProfile('seaweedfs') : defaultProfile({ cloud, projectName: 'a' });
      expect(render(profile)[ENV_VERSION_KEY], cloud).toBeUndefined();
    }
  });

  it('is a pure function of its input', () => {
    const profile = localProfile('seaweedfs');
    const once = renderEnv({ profile, secrets, images, dockerGroupId: 0, projectName: 'acme-ai' });
    expect(renderEnv({ profile, secrets, images, dockerGroupId: 0, projectName: 'acme-ai' })).toBe(
      once,
    );
  });
});
