import { storage } from './project-file.fixture.test-support.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_LOCAL_PORT,
  DeploymentDocumentV1Schema,
  LOCAL_RUNTIME_GATEWAY_PORT,
  LOCAL_RUNTIME_RESERVED_PORTS,
  LOCAL_RUNTIME_RUNNER_PORT,
  LocalEnvironmentSchema,
  LocalPortSchema,
  NAME_KEY_PATTERN,
  ProjectDocumentSchema,
  ProjectEnvironmentSchema,
} from './project-file.js';
import { SKILL_NAME_PATTERN } from './skills.js';
import {
  identity,
  minimal,
  v1,
  without,
  refusedPaths,
} from './project-file.fixture.test-support.js';

describe('ProjectDocumentSchema', () => {
  it('accepts a v2 document with only environments.local, port and runtime optional', () => {
    expect(ProjectDocumentSchema.safeParse(minimal).success).toBe(true);
    const full = {
      ...minimal,
      environments: {
        local: {
          cloud: 'local',
          runtime: { default: 'sandbox-runtime' },
          identity: { ...identity, oidc: 'https://issuer.example.com' },
          port: DEFAULT_LOCAL_PORT,
        },
      },
    };
    expect(ProjectDocumentSchema.parse(full)).toEqual(full);
  });

  it('refuses an unknown root key at the root', () => {
    expect(refusedPaths(ProjectDocumentSchema.safeParse({ ...minimal, extra: 1 }))).toEqual([
      ['extra'],
    ]);
  });

  it('treats features as optional: absent parses and a closed list round-trips', () => {
    expect(ProjectDocumentSchema.parse(minimal)).not.toHaveProperty('features');
    const document = { ...minimal, features: ['chat', 'files'] };
    expect(ProjectDocumentSchema.parse(document)).toEqual(document);
  });

  it.each([
    ['an empty list', []],
    ['a feature without its dependency', ['surfaces']],
    ['a repeated feature', ['chat', 'chat']],
    ['an unknown feature', ['nope']],
  ])('refuses features with %s at features', (_name, features) => {
    const paths = refusedPaths(ProjectDocumentSchema.safeParse({ ...minimal, features }));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path[0]).toBe('features');
  });

  it('refuses a preview environment at environments.preview', () => {
    const document = {
      ...minimal,
      environments: { ...minimal.environments, preview: { cloud: 'local', identity } },
    };
    expect(refusedPaths(ProjectDocumentSchema.safeParse(document))).toEqual([
      ['environments', 'preview'],
    ]);
  });

  it('refuses storage on local at environments.local.storage', () => {
    const document = {
      ...minimal,
      environments: { local: { cloud: 'local', identity, storage } },
    };
    expect(refusedPaths(ProjectDocumentSchema.safeParse(document))).toEqual([
      ['environments', 'local', 'storage'],
    ]);
  });

  it('refuses a non-local cloud at environments.local.cloud', () => {
    const document = { ...minimal, environments: { local: { cloud: 'aws', identity } } };
    expect(refusedPaths(ProjectDocumentSchema.safeParse(document))).toEqual([
      ['environments', 'local', 'cloud'],
    ]);
  });

  it('refuses a missing local environment at environments.local', () => {
    expect(refusedPaths(ProjectDocumentSchema.safeParse({ ...minimal, environments: {} }))).toEqual(
      [['environments', 'local']],
    );
  });

  it.each(['Demo', 'a_b', '-demo', 'demo-', '', 'a'.repeat(65)])(
    'refuses the name %j at name',
    (name) => {
      expect(refusedPaths(ProjectDocumentSchema.safeParse({ ...minimal, name }))).toEqual([
        ['name'],
      ]);
    },
  );

  it('refuses a port outside 1-65535 and a non-https oidc issuer', () => {
    const local = (extra: Record<string, unknown>): unknown => ({
      ...minimal,
      environments: { local: { cloud: 'local', identity, ...extra } },
    });
    expect(refusedPaths(ProjectDocumentSchema.safeParse(local({ port: 0 })))).toEqual([
      ['environments', 'local', 'port'],
    ]);
    expect(refusedPaths(ProjectDocumentSchema.safeParse(local({ port: 65536 })))).toEqual([
      ['environments', 'local', 'port'],
    ]);
    const httpIssuer = {
      ...minimal,
      environments: {
        local: { cloud: 'local', identity: { ...identity, oidc: 'http://issuer.example.com' } },
      },
    };
    expect(refusedPaths(ProjectDocumentSchema.safeParse(httpIssuer))).toEqual([
      ['environments', 'local', 'identity', 'oidc'],
    ]);
  });

  it('emits a JSON Schema', () => {
    expect(() => z.toJSONSchema(ProjectDocumentSchema)).not.toThrow();
  });
});

describe('environment schemas', () => {
  it('lets the general environment carry storage, and the local one not', () => {
    expect(ProjectEnvironmentSchema.safeParse({ cloud: 'gcp', storage, identity }).success).toBe(
      true,
    );
    expect(LocalEnvironmentSchema.safeParse({ cloud: 'local', storage, identity }).success).toBe(
      false,
    );
  });

  it.each([
    [
      LOCAL_RUNTIME_GATEWAY_PORT,
      "is reserved by the local runtime's gateway (4000); choose another port",
    ],
    [
      LOCAL_RUNTIME_RUNNER_PORT,
      "is reserved by the local runtime's runner (8080); choose another port",
    ],
  ])('refuses the reserved local port %i with one issue naming its service', (port, message) => {
    const result = ProjectDocumentSchema.safeParse({
      ...minimal,
      environments: { local: { cloud: 'local', identity, port } },
    });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    ).toEqual([{ path: ['environments', 'local', 'port'], message }]);
  });

  it.each([80, DEFAULT_LOCAL_PORT, 3001, 65535])('accepts the local port %i', (port) => {
    expect(LocalPortSchema.safeParse(port).success).toBe(true);
    expect(LocalEnvironmentSchema.safeParse({ cloud: 'local', identity, port }).success).toBe(true);
  });

  it('reserves exactly the gateway and runner ports, and keeps them off the general environment', () => {
    expect(LOCAL_RUNTIME_RESERVED_PORTS).toEqual([
      { port: 4000, service: 'gateway' },
      { port: 8080, service: 'runner' },
    ]);
    expect(
      ProjectEnvironmentSchema.safeParse({
        cloud: 'gcp',
        identity,
        port: LOCAL_RUNTIME_GATEWAY_PORT,
      }).success,
    ).toBe(true);
  });

  it('names the skills grammar as the name-key grammar', () => {
    expect(NAME_KEY_PATTERN).toBe(SKILL_NAME_PATTERN);
  });
});

describe('DeploymentDocumentV1Schema', () => {
  it('requires cloud, storage, runtime and identity', () => {
    for (const field of ['cloud', 'storage', 'runtime', 'identity']) {
      const rest = without(v1('aws'), field);
      expect(refusedPaths(DeploymentDocumentV1Schema.safeParse(rest))).toEqual([[field]]);
    }
  });
});
