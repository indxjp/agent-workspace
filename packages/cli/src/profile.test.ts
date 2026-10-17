import { readFile } from 'node:fs/promises';

import { withRecommendedAnswers } from '@indx-workspace/contracts/setup';
import { renderProjectFiles } from '@indx-workspace/sdk/project';
import { describe, expect, it, vi } from 'vitest';

import {
  MISSING_API_VERSION_WARNING,
  parseProfileDocument,
  PROJECT_KIND_REFUSAL,
  ProjectKindRefusedError,
  renderProfileDocument,
  validateProfile,
  ProfileError,
  type DeploymentProfile,
} from './profile.js';
import { defaultProfile } from './profile-defaults.js';

const local: DeploymentProfile = {
  cloud: 'local',
  storage: {
    relational: 'postgres://agent_workspace:pw@postgres:5432/agent_workspace',
    objects: 'local-filesystem',
    secrets: 'local-key',
  },
  runtime: { default: 'docker' },
  identity: { bootstrapAdmin: 'admin@localhost.test' },
};

/** The dotted path a refusal must name, per acceptance criterion 2. */
function refusalPath(build: () => unknown): string {
  try {
    build();
  } catch (thrown) {
    if (thrown instanceof ProfileError) return thrown.path;
    throw thrown;
  }
  throw new Error('expected a ProfileError');
}

describe('the deployment profile schema', () => {
  it('accepts the profile the generator derives for every cloud', () => {
    for (const cloud of ['aws', 'gcp', 'azure', 'local', 'vercel', 'cloudflare'] as const) {
      const profile = defaultProfile({ cloud, projectName: 'acme-ai' });
      expect(profile.cloud).toBe(cloud);
      expect(validateProfile(profile)).toEqual(profile);
    }
  });

  it('round-trips every derived profile through the document it writes', () => {
    for (const cloud of ['aws', 'gcp', 'azure', 'local', 'vercel', 'cloudflare'] as const) {
      const profile = defaultProfile({ cloud, projectName: 'acme-ai' });
      expect(parseProfileDocument(renderProfileDocument(profile))).toEqual(profile);
    }
  });

  it('round-trips an OIDC issuer', () => {
    const profile = { ...local, identity: { ...local.identity, oidc: 'https://id.example' } };
    expect(parseProfileDocument(renderProfileDocument(profile))).toEqual(profile);
  });

  it('round-trips the external runtime provider and leaves an omitted one omitted', () => {
    const vercel = defaultProfile({ cloud: 'vercel', projectName: 'acme-ai' });
    for (const runtime of [
      { default: 'external', provider: 'e2b' },
      { default: 'external' },
    ] as const) {
      const profile = { ...vercel, runtime };
      expect(parseProfileDocument(renderProfileDocument(profile))).toEqual(profile);
    }
    expect(renderProfileDocument({ ...vercel, runtime: { default: 'external' } })).not.toContain(
      'provider',
    );
  });

  it('refuses an unknown key, naming its dotted path', () => {
    expect(refusalPath(() => validateProfile({ ...local, region: 'eu-west-1' }))).toBe('region');
    expect(
      refusalPath(() => validateProfile({ ...local, storage: { ...local.storage, kms: 'x' } })),
    ).toBe('storage.kms');
    expect(
      refusalPath(() =>
        validateProfile({ ...local, identity: { ...local.identity, admin: 'a@b.c' } }),
      ),
    ).toBe('identity.admin');
  });

  it('refuses a missing field, naming its dotted path', () => {
    expect(refusalPath(() => validateProfile({ ...local, identity: {} }))).toBe(
      'identity.bootstrapAdmin',
    );
    expect(
      refusalPath(() =>
        validateProfile({
          ...local,
          storage: { relational: local.storage.relational, secrets: local.storage.secrets },
        }),
      ),
    ).toBe('storage.objects');
    expect(
      refusalPath(() =>
        validateProfile({
          storage: local.storage,
          runtime: local.runtime,
          identity: local.identity,
        }),
      ),
    ).toBe('cloud');
  });

  it('refuses a relational store the platform cannot speak to', () => {
    const relational = (value: string, cloud: DeploymentProfile['cloud'] = 'local') =>
      refusalPath(() =>
        validateProfile({ ...local, cloud, storage: { ...local.storage, relational: value } }),
      );
    // `packages/core/src/db/client.ts` accepts postgres: and postgresql: and nothing else.
    expect(relational('mysql://host/db')).toBe('storage.relational');
    expect(relational('sqlite:///tmp/db')).toBe('storage.relational');
    // A store named rather than spelled out belongs to exactly one cloud, and the Compose
    // project's own service is one of those names — it is how a local profile avoids carrying
    // the generated password that its connection string would contain.
    expect(relational('cloud-sql', 'aws')).toBe('storage.relational');
    expect(relational('rds', 'local')).toBe('storage.relational');
    expect(relational('compose-postgres', 'gcp')).toBe('storage.relational');
    expect(() =>
      validateProfile({ ...local, storage: { ...local.storage, relational: 'compose-postgres' } }),
    ).not.toThrow();
    expect(() =>
      validateProfile({
        ...local,
        cloud: 'gcp',
        storage: { ...local.storage, relational: 'cloud-sql', objects: 's3://acme-files' },
      }),
    ).not.toThrow();
  });

  it('accepts native GCS only for GCP', () => {
    expect(() =>
      validateProfile({
        ...local,
        cloud: 'gcp',
        storage: {
          relational: 'cloud-sql',
          objects: 'gcs://acme-files',
          secrets: 'secret-manager',
        },
      }),
    ).not.toThrow();
    expect(
      refusalPath(() =>
        validateProfile({
          ...local,
          storage: { ...local.storage, objects: 'gcs://acme-files' },
        }),
      ),
    ).toBe('storage.objects');
  });

  it('accepts Azure Blob only on Azure and validates the container name', () => {
    const azure = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });
    expect(azure.storage.objects).toBe('azblob://acme-ai-files');
    expect(() => validateProfile(azure)).not.toThrow();

    const outsideAzure = { ...local.storage, objects: 'azblob://acme-files' };
    expect(() => validateProfile({ ...local, storage: outsideAzure })).toThrow(
      /outside cloud "azure"/u,
    );
    expect(refusalPath(() => validateProfile({ ...local, storage: outsideAzure }))).toBe(
      'storage.objects',
    );

    expect(() =>
      validateProfile({
        ...azure,
        storage: { ...azure.storage, objects: 'azblob://Invalid--Container' },
      }),
    ).toThrow(/3-63 character Azure container/u);
  });

  it('refuses a local-filesystem object store on a cloud that has a native object backend', () => {
    for (const cloud of ['aws', 'gcp'] as const) {
      expect(
        refusalPath(() =>
          validateProfile({
            ...local,
            cloud,
            storage: { ...local.storage, relational: cloud === 'aws' ? 'rds' : 'cloud-sql' },
          }),
        ),
      ).toBe('storage.objects');
    }
    // Azure keeps this explicit compatibility option for the mounted Files share, even though
    // generated Azure profiles now select native Blob storage.
    expect(() =>
      validateProfile({
        ...local,
        cloud: 'azure',
        storage: { ...local.storage, relational: 'azure-postgres' },
        runtime: { default: 'aca-sessions' },
      }),
    ).not.toThrow();
  });

  it('accepts Secret Manager only for GCP and refuses cross-cloud backends', () => {
    expect(() =>
      validateProfile({
        ...local,
        cloud: 'gcp',
        storage: {
          relational: 'cloud-sql',
          objects: 'gcs://acme-files',
          secrets: 'secret-manager',
        },
      }),
    ).not.toThrow();
    expect(
      refusalPath(() =>
        validateProfile({ ...local, storage: { ...local.storage, secrets: 'secret-manager' } }),
      ),
    ).toBe('storage.secrets');
    const kmsStorage = { ...local.storage, secrets: 'kms' };
    expect(() => validateProfile({ ...local, storage: kmsStorage })).toThrow(/AWS KMS/u);
    expect(refusalPath(() => validateProfile({ ...local, storage: kmsStorage }))).toBe(
      'storage.secrets',
    );
  });

  it('accepts Azure Key Vault only on Azure', () => {
    const azure = defaultProfile({ cloud: 'azure', projectName: 'acme-ai' });
    expect(azure.storage.secrets).toBe('key-vault');
    expect(() => validateProfile(azure)).not.toThrow();

    const storage = { ...local.storage, secrets: 'key-vault' };
    expect(() => validateProfile({ ...local, storage })).toThrow(/outside cloud "azure"/u);
    expect(refusalPath(() => validateProfile({ ...local, storage }))).toBe('storage.secrets');
  });

  it('separates a runtime driver that is named-but-unbuilt from one that does not exist', () => {
    expect(() => validateProfile({ ...local, runtime: { default: 'aws-ecs' } })).toThrow(
      /lists but packages\/runtime does not implement/u,
    );
    expect(() => validateProfile({ ...local, runtime: { default: 'kubernets' } })).toThrow(
      /must be one of/u,
    );
    expect(refusalPath(() => validateProfile({ ...local, runtime: { default: 'aws-ecs' } }))).toBe(
      'runtime.default',
    );
  });

  it('refuses an unknown external runtime provider at runtime.provider', () => {
    expect(
      refusalPath(() =>
        validateProfile({ ...local, runtime: { default: 'external', provider: 'nope' } }),
      ),
    ).toBe('runtime.provider');
  });

  it('refuses a bootstrap administrator that is not an address, and a non-https issuer', () => {
    expect(
      refusalPath(() => validateProfile({ ...local, identity: { bootstrapAdmin: 'admin' } })),
    ).toBe('identity.bootstrapAdmin');
    expect(
      refusalPath(() =>
        validateProfile({ ...local, identity: { ...local.identity, oidc: 'http://id.example' } }),
      ),
    ).toBe('identity.oidc');
    expect(
      refusalPath(() =>
        validateProfile({ ...local, identity: { ...local.identity, oidc: 'not a url' } }),
      ),
    ).toBe('identity.oidc');
  });

  it('refuses an unknown cloud and a block that is not a block', () => {
    expect(refusalPath(() => validateProfile({ ...local, cloud: 'digitalocean' }))).toBe('cloud');
    expect(refusalPath(() => validateProfile({ ...local, storage: 'postgres' }))).toBe('storage');
    expect(refusalPath(() => validateProfile('cloud: local'))).toBe('the profile');
  });

  it('refuses a project directory that cannot name a bucket, before anything is written', () => {
    expect(refusalPath(() => defaultProfile({ cloud: 'aws', projectName: '///' }))).toBe(
      'storage.objects',
    );
    expect(refusalPath(() => defaultProfile({ cloud: 'aws', projectName: 'a'.repeat(60) }))).toBe(
      'storage.objects',
    );
  });
});

const envelope = 'apiVersion: agentworkspace.dev/v1\nkind: Deployment\n';
const localBody = `cloud: local
storage:
  relational: compose-postgres
  objects: local-filesystem
  secrets: local-key
runtime:
  default: docker
identity:
  bootstrapAdmin: admin@localhost.test
`;

/** The refusal `parseProfileDocument` throws for `text`, with the position it names. */
function documentRefusal(text: string): ProfileError {
  try {
    parseProfileDocument(text);
  } catch (thrown) {
    if (thrown instanceof ProfileError) return thrown;
    throw thrown;
  }
  throw new Error('expected a ProfileError');
}

describe('the deployment profile document, read from text', () => {
  it('parses every committed golden profile to the profile the generator derives', async () => {
    for (const cloud of ['aws', 'gcp', 'azure', 'local', 'vercel', 'cloudflare'] as const) {
      const text = await readFile(
        new URL(`./fixtures/${cloud}/agent-workspace.yaml`, import.meta.url),
        'utf8',
      );
      const onWarning = vi.fn();
      // The same profile `render/artefacts.test.ts` renders these goldens from.
      expect(parseProfileDocument(text, { onWarning })).toEqual(
        defaultProfile({
          cloud,
          projectName: 'acme-ai',
          ...(cloud === 'local' ? { localObjectStore: 'seaweedfs' as const } : {}),
        }),
      );
      expect(onWarning).not.toHaveBeenCalled();
    }
  });

  it('writes apiVersion and kind first, after the header', () => {
    const lines = renderProfileDocument(local).split('\n');
    const firstField = lines.findIndex((line) => !line.startsWith('#'));
    expect(lines.slice(firstField, firstField + 3)).toEqual([
      'apiVersion: agentworkspace.dev/v1',
      'kind: Deployment',
      'cloud: local',
    ]);
  });

  it('reads a profile without apiVersion as v1, and warns once with the two lines to add', () => {
    const onWarning = vi.fn();
    expect(parseProfileDocument(localBody, { onWarning })).toEqual({
      ...local,
      storage: { ...local.storage, relational: 'compose-postgres' },
    });
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning).toHaveBeenCalledWith(MISSING_API_VERSION_WARNING);
    expect(MISSING_API_VERSION_WARNING).toContain('  apiVersion: agentworkspace.dev/v1\n');
    expect(MISSING_API_VERSION_WARNING).toContain('  kind: Deployment');
  });

  it('does not warn for a profile that carries apiVersion', () => {
    const onWarning = vi.fn();
    parseProfileDocument(envelope + localBody, { onWarning });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('refuses an unknown apiVersion or kind, naming the line', () => {
    const version = documentRefusal(
      'apiVersion: agentworkspace.dev/v2\nkind: Deployment\n' + localBody,
    );
    expect(version.path).toBe('apiVersion');
    expect(version.position).toEqual({ line: 1, column: 1 });
    expect(version.message).toBe(
      'agent-workspace.yaml line 1, column 1: apiVersion must be agentworkspace.dev/v1; ' +
        'got "agentworkspace.dev/v2"',
    );

    const kind = documentRefusal(
      'apiVersion: agentworkspace.dev/v1\nkind: Workspace\n' + localBody,
    );
    expect(kind.path).toBe('kind');
    expect(kind.position).toEqual({ line: 2, column: 1 });
    expect(kind.message).toMatch(
      /^agent-workspace\.yaml line 2, column 1: kind must be Deployment/u,
    );
  });

  it('refuses an apiVersion with no kind, and a wrong kind without an apiVersion', () => {
    expect(documentRefusal('apiVersion: agentworkspace.dev/v1\n' + localBody).path).toBe('kind');
    expect(documentRefusal('kind: Workspace\n' + localBody).path).toBe('kind');
  });

  it('names the line of an unknown key, at the top level and nested', () => {
    const top = documentRefusal(`${envelope}${localBody}region: eu-west-1\n`);
    expect(top.path).toBe('region');
    expect(top.position).toEqual({ line: 12, column: 1 });
    expect(top.message).toMatch(/^agent-workspace\.yaml line 12, column 1: region is not a field/u);

    const nested = documentRefusal(
      envelope + localBody.replace('  secrets: local-key\n', '  secrets: local-key\n  kms: x\n'),
    );
    expect(nested.path).toBe('storage.kms');
    expect(nested.position).toEqual({ line: 8, column: 3 });
  });

  it('names the line of a value of the wrong shape or type', () => {
    const sequence = documentRefusal(
      envelope + localBody.replace('  default: docker\n', '  default:\n    - docker\n'),
    );
    expect(sequence.path).toBe('runtime.default');
    expect(sequence.message).toMatch(/line 9, column 3: runtime\.default must be text/u);

    const third = documentRefusal(
      envelope + localBody.replace('  default: docker\n', '  default:\n    driver: docker\n'),
    );
    expect(third.path).toBe('runtime.default');
    expect(third.position).toEqual({ line: 9, column: 3 });

    const flag = documentRefusal(envelope + localBody.replace('cloud: local', 'cloud: true'));
    expect(flag.path).toBe('cloud');
    expect(flag.message).toMatch(/line 3, column 1: cloud must be text/u);
  });

  it('names the parent block of a missing field', () => {
    const missing = documentRefusal(
      envelope + localBody.replace('  objects: local-filesystem\n', ''),
    );
    expect(missing.path).toBe('storage.objects');
    expect(missing.position).toEqual({ line: 4, column: 1 });
  });

  it('refuses a __proto__ key as an unknown field', () => {
    const error = documentRefusal(`${envelope}${localBody}__proto__:\n  cloud: aws\n`);
    expect(error.path).toBe('__proto__');
    expect(error.position).toEqual({ line: 12, column: 1 });
  });

  it('reads the YAML forms the old subset refused when the schema accepts the values', () => {
    const text =
      envelope +
      localBody
        .replace('cloud: local', 'cloud: "local"')
        .replace('runtime:\n  default: docker', 'runtime: { default: docker }');
    expect(parseProfileDocument(text)).toEqual(parseProfileDocument(envelope + localBody));
  });

  it('keeps the unpositioned message for a profile that never was a file', () => {
    let error: unknown = null;
    try {
      validateProfile({ ...local, region: 'eu-west-1' });
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(ProfileError);
    expect((error as ProfileError).position).toBeUndefined();
    expect((error as ProfileError).message).toMatch(/^agent-workspace\.yaml: region /u);
  });
});

/**
 * S1-16: `npm create @indx-workspace` and `aw init` write a v2 `kind: Project` file. The
 * deployment commands cannot render or deploy it before P-2, and say so by name — before the
 * missing-apiVersion warning and before any schema stage reports a field of the wrong document.
 */
describe('a v2 project file', () => {
  const projectText = (): string => {
    const [file] = renderProjectFiles(withRecommendedAnswers({}), { name: 'acme' });
    if (file?.path !== 'agent-workspace.yaml') throw new Error('expected agent-workspace.yaml');
    return file.contents;
  };

  function refusal(text: string, onWarning?: (message: string) => void): ProfileError {
    try {
      parseProfileDocument(text, onWarning === undefined ? {} : { onWarning });
    } catch (thrown) {
      if (thrown instanceof ProfileError) return thrown;
      throw thrown;
    }
    throw new Error('expected a ProfileError');
  }

  it('is refused with the P-2 sentence and the line and column of its kind key', () => {
    const text = projectText();
    const warnings: string[] = [];
    const error = refusal(text, (message) => warnings.push(message));

    expect(error).toBeInstanceOf(ProjectKindRefusedError);
    expect(error.message).toContain(PROJECT_KIND_REFUSAL);
    expect(PROJECT_KIND_REFUSAL).toBe(
      'kind: Project is read by aw dev; render and deploy arrive with P-2',
    );
    const line = text.split('\n').findIndex((entry) => entry.startsWith('kind:')) + 1;
    expect(error.position).toEqual({ line, column: 1 });
    expect(error.message).toBe(
      `agent-workspace.yaml line ${String(line)}, column 1: ${PROJECT_KIND_REFUSAL}`,
    );
    expect(warnings).toEqual([]);
  });

  it('is refused the same way by its v2 apiVersion when kind is missing', () => {
    const text = 'name: acme\napiVersion: agentworkspace.dev/v2\n';
    const warnings: string[] = [];
    const error = refusal(text, (message) => warnings.push(message));
    expect(error).toBeInstanceOf(ProjectKindRefusedError);
    expect(error.message).toContain(PROJECT_KIND_REFUSAL);
    expect(error.position).toEqual({ line: 2, column: 1 });
    expect(warnings).toEqual([]);
  });

  it('is refused by kind: Project alone, without an apiVersion and without its warning', () => {
    const warnings: string[] = [];
    const error = refusal('kind: Project\nname: acme\n', (message) => warnings.push(message));
    expect(error.message).toContain(PROJECT_KIND_REFUSAL);
    expect(error.position).toEqual({ line: 1, column: 1 });
    expect(warnings).toEqual([]);
  });

  it('leaves a v1 Deployment profile parsing as before', () => {
    const profile = defaultProfile({ cloud: 'local', projectName: 'acme-ai' });
    expect(parseProfileDocument(renderProfileDocument(profile))).toEqual(profile);
  });
});
