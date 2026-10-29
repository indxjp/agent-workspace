import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { LocalRuntimeStartMessageSchema } from './local-runtime.js';
import { PLATFORM_IDS } from './platform-ids.js';
import {
  BOOTSTRAP_ADMIN_MAX_LENGTH,
  BootstrapAdminSchema,
  DEFAULT_BOOTSTRAP_ADMIN,
  DEFAULT_LOCAL_PORT,
  DEPLOYMENT_V1_API_VERSION,
  DeploymentDocumentV1Schema,
  IMPLEMENTED_RUNTIME_DRIVERS,
  LOCAL_RUNTIME_GATEWAY_PORT,
  LOCAL_RUNTIME_RESERVED_PORTS,
  LOCAL_RUNTIME_RUNNER_PORT,
  LocalEnvironmentSchema,
  LocalPortSchema,
  NAME_KEY_PATTERN,
  PROJECT_API_VERSION,
  PROJECT_CLOUDS,
  PROJECT_DEPLOY_TARGETS,
  ProjectDocumentSchema,
  ProjectEnvironmentSchema,
  readProjectDocument,
} from './project-file.js';
import { SKILL_NAME_PATTERN } from './skills.js';

const identity = { bootstrapAdmin: DEFAULT_BOOTSTRAP_ADMIN };
const storage = {
  relational: 'compose-postgres',
  objects: 'local-filesystem',
  secrets: 'local-key',
};

const minimal = {
  apiVersion: PROJECT_API_VERSION,
  kind: 'Project',
  name: 'demo',
  environments: { local: { cloud: 'local', identity } },
};

function v1(cloud: (typeof PROJECT_CLOUDS)[number]): Record<string, unknown> {
  return {
    apiVersion: DEPLOYMENT_V1_API_VERSION,
    kind: 'Deployment',
    cloud,
    storage,
    runtime: { default: 'docker' },
    identity: { bootstrapAdmin: 'owner@example.com', oidc: 'https://issuer.example.com' },
  };
}

function without(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

/** Every refused path, with an `unrecognized_keys` issue's keys appended to its parent's path. */
function refusedPaths(result: {
  readonly success: boolean;
  readonly error?: z.ZodError;
}): (string | number | symbol)[][] {
  expect(result.success).toBe(false);
  return (result.error?.issues ?? []).flatMap((issue) =>
    issue.code === 'unrecognized_keys'
      ? issue.keys.map((key) => [...issue.path, key])
      : [[...issue.path]],
  );
}

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

describe('readProjectDocument', () => {
  it('reads a v2 document as written, lifted: false', () => {
    const result = readProjectDocument(minimal);
    expect(result).toEqual({ success: true, data: { lifted: false, project: minimal } });
  });

  it('lifts a v1 local profile to environments.local, keeping its storage', () => {
    const result = readProjectDocument(v1('local'));
    expect(result).toEqual({
      success: true,
      data: {
        lifted: true,
        project: {
          apiVersion: PROJECT_API_VERSION,
          kind: 'Project',
          environments: {
            local: {
              cloud: 'local',
              storage,
              runtime: { default: 'docker' },
              identity: { bootstrapAdmin: 'owner@example.com', oidc: 'https://issuer.example.com' },
            },
          },
        },
      },
    });
  });

  it.each(['aws', 'gcp', 'azure'] as const)(
    'lifts a v1 %s profile to environments.production',
    (cloud) => {
      const result = readProjectDocument(v1(cloud));
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.lifted).toBe(true);
      expect(result.data.project.environments).toEqual({
        production: {
          cloud,
          storage,
          runtime: { default: 'docker' },
          identity: { bootstrapAdmin: 'owner@example.com', oidc: 'https://issuer.example.com' },
        },
      });
      expect('name' in result.data.project).toBe(false);
    },
  );

  it('lifts a v1 profile with no envelope and writes no absent oidc key', () => {
    const bare = without(v1('local'), 'apiVersion', 'kind');
    const result = readProjectDocument({ ...bare, identity: { bootstrapAdmin: 'o@example.com' } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.lifted).toBe(true);
    const environment =
      'local' in result.data.project.environments
        ? result.data.project.environments.local
        : undefined;
    expect(environment?.identity).toEqual({ bootstrapAdmin: 'o@example.com' });
    expect(Object.keys(environment?.identity ?? {})).toEqual(['bootstrapAdmin']);
  });

  it('refuses an unknown apiVersion at apiVersion, naming both versions', () => {
    const result = readProjectDocument({ ...minimal, apiVersion: 'agentworkspace.dev/v3' });
    expect(refusedPaths(result)).toEqual([['apiVersion']]);
    const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
    expect(message).toContain(PROJECT_API_VERSION);
    expect(message).toContain(DEPLOYMENT_V1_API_VERSION);
  });

  it('refuses a kind that contradicts its apiVersion at kind', () => {
    expect(refusedPaths(readProjectDocument({ ...v1('aws'), kind: 'Project' }))).toEqual([
      ['kind'],
    ]);
    expect(refusedPaths(readProjectDocument({ ...minimal, kind: 'Deployment' }))).toEqual([
      ['kind'],
    ]);
  });

  it('reads kind Project without an apiVersion as v2 and refuses it there', () => {
    expect(refusedPaths(readProjectDocument(without(minimal, 'apiVersion')))).toEqual([
      ['apiVersion'],
    ]);
  });

  it('refuses the v2 document refusals through the reader too', () => {
    const document = { ...minimal, environments: { local: { cloud: 'local', identity, storage } } };
    expect(refusedPaths(readProjectDocument(document))).toEqual([
      ['environments', 'local', 'storage'],
    ]);
  });

  it.each([null, 'text', 42, []])('refuses %j without throwing', (value) => {
    expect(readProjectDocument(value).success).toBe(false);
  });
});

describe('project-file review regressions (#439)', () => {
  function withAdmin(bootstrapAdmin: string): Record<string, unknown> {
    return {
      ...minimal,
      environments: { local: { cloud: 'local', identity: { bootstrapAdmin } } },
    };
  }

  function startWith(bootstrapAdmin: string): Record<string, unknown> {
    return {
      type: 'start',
      projectDir: '/home/dev/demo',
      environment: { port: DEFAULT_LOCAL_PORT, bootstrapAdmin },
    };
  }

  it('accepts a bootstrap admin at the length bound in both the project file and start', () => {
    const atBound = `${'a'.repeat(BOOTSTRAP_ADMIN_MAX_LENGTH - '@example.com'.length)}@example.com`;
    expect(atBound).toHaveLength(BOOTSTRAP_ADMIN_MAX_LENGTH);
    expect(ProjectDocumentSchema.safeParse(withAdmin(atBound)).success).toBe(true);
    expect(LocalRuntimeStartMessageSchema.safeParse(startWith(atBound)).success).toBe(true);
  });

  it('refuses a bootstrap admin over the bound, as start does', () => {
    const over = `${'a'.repeat(BOOTSTRAP_ADMIN_MAX_LENGTH - '@example.com'.length + 1)}@example.com`;
    expect(refusedPaths(ProjectDocumentSchema.safeParse(withAdmin(over)))).toEqual([
      ['environments', 'local', 'identity', 'bootstrapAdmin'],
    ]);
    expect(LocalRuntimeStartMessageSchema.safeParse(startWith(over)).success).toBe(false);
  });

  it('refuses a very long bootstrap admin without running the pattern over it', () => {
    const hostile = `a@${'.'.repeat(160_000)}@`;
    const started = performance.now();
    const result = readProjectDocument(withAdmin(hostile));
    expect(performance.now() - started).toBeLessThan(250);
    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues.map((issue) => issue.code)).toEqual([
      'too_big',
    ]);
  });

  const CONTROL_CHARACTERS = [
    ['NUL', '\u0000'],
    ['ESC', '\u001b'],
    ['US', '\u001f'],
    ['DEL', '\u007f'],
    ['PAD', '\u0080'],
    ['NEL', '\u0085'],
    ['APC', '\u009f'],
  ] as const;

  function issueMessages(result: {
    readonly success: boolean;
    readonly error?: z.ZodError;
  }): string[] {
    return result.error?.issues.map((issue) => issue.message) ?? [];
  }

  it.each(CONTROL_CHARACTERS)(
    'refuses a bootstrap admin holding %s in the schema, the project file and start',
    (_name, control) => {
      const value = `ow${control}ner@example.com`;
      const message = ['must not contain a control character'];
      expect(issueMessages(BootstrapAdminSchema.safeParse(value))).toEqual(message);
      const project = ProjectDocumentSchema.safeParse(withAdmin(value));
      expect(refusedPaths(project)).toEqual([
        ['environments', 'local', 'identity', 'bootstrapAdmin'],
      ]);
      expect(issueMessages(project)).toEqual(message);
      expect(issueMessages(LocalRuntimeStartMessageSchema.safeParse(startWith(value)))).toEqual(
        message,
      );
    },
  );

  it('accepts a bootstrap admin holding a printable non-ASCII character, which is not Cc', () => {
    const value = 'ren\u00e9@example.com';
    expect(BootstrapAdminSchema.safeParse(value).success).toBe(true);
    expect(ProjectDocumentSchema.safeParse(withAdmin(value)).success).toBe(true);
    expect(LocalRuntimeStartMessageSchema.safeParse(startWith(value)).success).toBe(true);
  });

  it('lets U+00A0 past the control check, leaving it to the email pattern', () => {
    const result = BootstrapAdminSchema.safeParse('ow\u00a0ner@example.com');
    expect(issueMessages(result)).not.toContain('must not contain a control character');
  });

  it('still accepts a plain bootstrap admin address', () => {
    expect(BootstrapAdminSchema.safeParse('owner@example.com').success).toBe(true);
  });

  it('refuses a v1 profile with apiVersion and no kind, as the CLI does', () => {
    expect(refusedPaths(readProjectDocument(without(v1('local'), 'kind')))).toEqual([['kind']]);
  });

  it('still lifts a v1 profile with no envelope at all', () => {
    const result = readProjectDocument(without(v1('local'), 'apiVersion', 'kind'));
    expect(result.success && result.data.lifted).toBe(true);
  });

  it('refuses a padded v1 text value the CLI would trim (documented difference)', () => {
    const padded = { ...v1('local'), identity: { bootstrapAdmin: ' admin@localhost.test ' } };
    expect(refusedPaths(readProjectDocument(padded))).toEqual([['identity', 'bootstrapAdmin']]);
  });

  it.each([
    'aws-ecs',
    'external',
    'vercel-sandbox',
    'cloudflare-sandbox',
    'gke-agent-sandbox',
    'aws-agentcore',
    'cloud-run-sandbox',
  ])('refuses the unimplemented runtime driver %s in v2 and in a v1 lift', (driver) => {
    const v2 = {
      ...minimal,
      environments: { local: { cloud: 'local', runtime: { default: driver }, identity } },
    };
    expect(refusedPaths(ProjectDocumentSchema.safeParse(v2))).toEqual([
      ['environments', 'local', 'runtime', 'default'],
    ]);
    const lifted = { ...v1('aws'), runtime: { default: driver } };
    expect(refusedPaths(readProjectDocument(lifted))).toEqual([['runtime', 'default']]);
  });

  it('accepts every implemented runtime driver', () => {
    for (const driver of IMPLEMENTED_RUNTIME_DRIVERS) {
      const v2 = {
        ...minimal,
        environments: { local: { cloud: 'local', runtime: { default: driver }, identity } },
      };
      expect(ProjectDocumentSchema.safeParse(v2).success).toBe(true);
    }
  });

  it('freezes a lifted v1 document throughout, as a parsed v2 document is', () => {
    const result = readProjectDocument(v1('local'));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { project } = result.data;
    expect(Object.isFrozen(project)).toBe(true);
    expect(Object.isFrozen(project.environments)).toBe(true);
    expect(Object.isFrozen(project.environments.local)).toBe(true);
  });
});

describe('project-file engine, models, connectors and policy (S2-01a, #524)', () => {
  const PASTED_KEY = 'sk-live-abcdef0123456789PASTEDVALUE';

  function project(extra: Record<string, unknown>): Record<string, unknown> {
    return { ...minimal, ...extra };
  }

  const goldens: readonly Record<string, unknown>[] = [
    minimal,
    project({
      environments: {
        local: { cloud: 'local', runtime: { default: 'sandbox-runtime' }, identity },
      },
    }),
    project({
      environments: { local: { cloud: 'local', runtime: { default: 'local' }, identity } },
    }),
    project({
      environments: {
        local: {
          cloud: 'local',
          runtime: { default: 'docker' },
          identity: { ...identity, oidc: 'https://issuer.example.com' },
          port: 4100,
        },
      },
    }),
  ];

  it.each(goldens)('parses every slice-1 golden shape unchanged (%#)', (golden) => {
    expect(ProjectDocumentSchema.parse(golden)).toEqual(golden);
    expect(readProjectDocument(golden)).toEqual({
      success: true,
      data: { lifted: false, project: golden },
    });
  });

  const full = project({
    engine: 'openai-agents',
    models: {
      anthropic: { provider: 'anthropic', credential: { secret: 'ANTHROPIC_API_KEY' } },
      azure: {
        provider: 'azure-openai',
        credential: { secret: 'AZURE_OPENAI_KEY' },
        baseUrl: 'https://example.openai.azure.com',
        deployment: 'gpt-5',
        apiVersion: '2025-01-01',
      },
      local: {
        provider: 'openai-compatible',
        credential: { secret: 'LOCAL_KEY' },
        baseUrl: 'http://127.0.0.1:11434/v1',
      },
    },
    connectors: {
      orders: {
        url: 'https://orders.example.com/mcp',
        auth: { scheme: 'bearer', credential: { secret: 'ORDERS_TOKEN' } },
      },
      events: { url: 'http://localhost:8080/sse', transport: 'sse' },
    },
    policy: {
      permissions: { runCommands: false },
      limits: { maxTurns: 30 },
      engines: ['openai-agents'],
      models: ['gpt-5'],
      tools: ['orders'],
    },
  });

  it('accepts a connector identity secret reference and refuses anything else there', () => {
    const connector = { url: 'https://x.example.com/mcp' };
    const parsed = ProjectDocumentSchema.parse(
      project({ connectors: { x: { ...connector, identity: { secret: 'X_IDENTITY_KEY' } } } }),
    );
    expect(parsed.connectors?.['x']?.identity).toStrictEqual({ secret: 'X_IDENTITY_KEY' });
    for (const identity of [
      { secret: 'literal value with spaces' },
      'X_IDENTITY_KEY',
      { secret: 'X_IDENTITY_KEY', value: 'x' },
    ]) {
      expect(
        ProjectDocumentSchema.safeParse(project({ connectors: { x: { ...connector, identity } } }))
          .success,
      ).toBe(false);
    }
  });

  it('accepts engine, models, connectors and policy together, frozen', () => {
    const parsed = ProjectDocumentSchema.parse(full);
    expect(parsed).toEqual(full);
    expect(Object.isFrozen(parsed.models)).toBe(true);
    expect(Object.isFrozen(parsed.models?.['azure'])).toBe(true);
    expect(Object.isFrozen(parsed.policy)).toBe(true);
  });

  it.each<[string, Record<string, unknown>, (string | number)[]]>([
    ['an unknown engine', { engine: 'nope' }, ['engine']],
    [
      'a model id on a connection',
      {
        models: {
          x: { provider: 'anthropic', credential: { secret: 'K' }, model: 'claude-sonnet-4-5' },
        },
      },
      ['models', 'x', 'model'],
    ],
    [
      'a stdio connector',
      { connectors: { x: { url: 'https://x.example.com', transport: 'stdio' } } },
      ['connectors', 'x', 'transport'],
    ],
    [
      'a non-http connector url',
      { connectors: { x: { url: 'ftp://x.example.com' } } },
      ['connectors', 'x', 'url'],
    ],
    [
      'an unknown auth scheme',
      {
        connectors: {
          x: {
            url: 'https://x.example.com',
            auth: { scheme: 'basic', credential: { secret: 'K' } },
          },
        },
      },
      ['connectors', 'x', 'auth', 'scheme'],
    ],
    ['policy.network', { policy: { network: 'open' } }, ['policy', 'network']],
    ['policy.approval', { policy: { approval: 'always' } }, ['policy', 'approval']],
    ['policy.connections', { policy: { connections: ['anthropic'] } }, ['policy', 'connections']],
    [
      'a per-environment policy',
      { environments: { local: { cloud: 'local', identity, policy: {} } } },
      ['environments', 'local', 'policy'],
    ],
  ])('refuses %s at its exact path', (_name, extra, path) => {
    expect(refusedPaths(ProjectDocumentSchema.safeParse(project(extra)))).toEqual([path]);
  });

  it('refuses policy.connections as unrecognized_keys at policy', () => {
    const result = ProjectDocumentSchema.safeParse(project({ policy: { connections: [] } }));
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
    expect(result.error?.issues[0]?.path).toEqual(['policy']);
  });

  it('names what is not built in each refusal', () => {
    const environment = ProjectDocumentSchema.safeParse(
      project({ environments: { local: { cloud: 'local', identity, policy: {} } } }),
    );
    expect(environment.error?.issues[0]?.message).toBe(
      'a per-environment policy is not built yet; use the top-level policy (ADR-0102 SD6)',
    );
    const model = ProjectDocumentSchema.safeParse(
      project({ models: { x: { provider: 'openai', credential: { secret: 'K' }, model: 'm' } } }),
    );
    expect(model.error?.issues[0]?.message).toBe(
      'a model connection carries no model id (C11); name the model in an agent',
    );
    const stdio = ProjectDocumentSchema.safeParse(
      project({ connectors: { x: { url: 'https://x.example.com', transport: 'stdio' } } }),
    );
    expect(stdio.error?.issues[0]?.message).toContain('stdio');
  });

  it('requires each setting the provider requires, at its own path', () => {
    const azure = ProjectDocumentSchema.safeParse(
      project({
        models: {
          az: {
            provider: 'azure-openai',
            credential: { secret: 'K' },
            baseUrl: 'https://example.openai.azure.com',
            apiVersion: '2025-01-01',
          },
        },
      }),
    );
    expect(refusedPaths(azure)).toEqual([['models', 'az', 'deployment']]);
    const compatible = ProjectDocumentSchema.safeParse(
      project({ models: { oc: { provider: 'openai-compatible', credential: { secret: 'K' } } } }),
    );
    expect(refusedPaths(compatible)).toEqual([['models', 'oc', 'baseUrl']]);
  });

  it('refuses a setting the provider does not accept, at its own path', () => {
    const result = ProjectDocumentSchema.safeParse(
      project({
        models: { a: { provider: 'anthropic', credential: { secret: 'K' }, deployment: 'd' } },
      }),
    );
    expect(refusedPaths(result)).toEqual([['models', 'a', 'deployment']]);
    expect(result.error?.issues[0]?.message).toBe('is not accepted for provider anthropic');
  });

  it('refuses a model name key outside the name grammar', () => {
    const result = ProjectDocumentSchema.safeParse(
      project({ models: { Bad_Name: { provider: 'openai', credential: { secret: 'K' } } } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['models', 'Bad_Name']);
  });

  it('bounds models and connectors to 64 entries each', () => {
    const connectors = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`c${String(i)}`, { url: 'https://x.example.com' }]),
    );
    expect(refusedPaths(ProjectDocumentSchema.safeParse(project({ connectors })))).toEqual([
      ['connectors'],
    ]);
    const sixtyFour = Object.fromEntries(Object.entries(connectors).slice(0, 64));
    expect(ProjectDocumentSchema.safeParse(project({ connectors: sixtyFour })).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>, (string | number)[]]>([
    [
      'a model credential',
      { models: { x: { provider: 'openai', credential: PASTED_KEY } } },
      ['models', 'x', 'credential'],
    ],
    [
      'a connector credential',
      {
        connectors: {
          x: { url: 'https://x.example.com', auth: { scheme: 'api-key', credential: PASTED_KEY } },
        },
      },
      ['connectors', 'x', 'auth', 'credential'],
    ],
  ])('refuses a string as %s at its path without echoing it', (_name, extra, path) => {
    const result = ProjectDocumentSchema.safeParse(project(extra));
    expect(refusedPaths(result)).toEqual([path]);
    expect(result.error?.message).not.toContain(PASTED_KEY);
    for (const issue of result.error?.issues ?? []) {
      expect(issue.message).not.toContain(PASTED_KEY);
    }
  });

  it.each<[string, Record<string, unknown>, (string | number)[]]>([
    [
      'a model credential',
      { models: { x: { provider: 'openai', credential: { secret: 'path' } } } },
      ['models', 'x', 'credential', 'secret'],
    ],
    [
      'a connector credential',
      {
        connectors: {
          x: {
            url: 'https://x.example.com',
            auth: { scheme: 'bearer', credential: { secret: 'path' } },
          },
        },
      },
      ['connectors', 'x', 'auth', 'credential', 'secret'],
    ],
  ])('refuses a reserved name in %s at its full path (issue #564)', (_name, extra, path) => {
    const result = ProjectDocumentSchema.safeParse(project(extra));
    expect(refusedPaths(result)).toEqual([path]);
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'PATH is a variable the local runtime uses; name the secret something else',
    ]);
  });

  it('emits a JSON Schema with the new keys', () => {
    const schema = z.toJSONSchema(ProjectDocumentSchema);
    expect(JSON.stringify(schema)).toContain('connectors');
    const platforms = schema.properties?.['platforms'];
    expect(platforms).toMatchObject({ type: 'object', additionalProperties: false });
    expect(typeof platforms === 'object' ? Object.keys(platforms.properties ?? {}) : []).toEqual([
      ...PLATFORM_IDS,
    ]);
  });

  it('lets a parsed project policy fit a start message', () => {
    const parsed = ProjectDocumentSchema.parse(full);
    const start = {
      type: 'start',
      projectDir: '/home/dev/demo',
      environment: {
        port: DEFAULT_LOCAL_PORT,
        bootstrapAdmin: DEFAULT_BOOTSTRAP_ADMIN,
        policy: parsed.policy,
      },
    };
    expect(LocalRuntimeStartMessageSchema.safeParse(start).success).toBe(true);
  });
});

describe('project-file S2-01a review regressions (#524)', () => {
  const PASTED_KEY = 'sk-live-abcdef0123456789PASTEDVALUE';

  function project(extra: Record<string, unknown>): Record<string, unknown> {
    return { ...minimal, ...extra };
  }

  function issueMessages(result: { readonly error?: z.ZodError }): string[] {
    return (result.error?.issues ?? []).map((issue) => issue.message);
  }

  it.each<[string, string]>([
    ['models', `{"__proto__":{"provider":"openai","credential":"${PASTED_KEY}"}}`],
    ['connectors', '{"__proto__":{"url":"ftp://x.example.com","transport":"stdio"}}'],
  ])('refuses a %s entry keyed __proto__ at its path instead of dropping it', (map, json) => {
    const entries: unknown = JSON.parse(json);
    expect(Object.hasOwn(entries as object, '__proto__')).toBe(true);
    const result = ProjectDocumentSchema.safeParse(project({ [map]: entries }));
    expect(refusedPaths(result)).toEqual([[map, '__proto__']]);
    expect(result.error?.message).not.toContain(PASTED_KEY);
    expect(readProjectDocument(project({ [map]: entries })).success).toBe(false);
  });

  it('refuses a __proto__ key next to valid entries, and still parses a map without one', () => {
    const connectors: unknown = JSON.parse(
      '{"orders":{"url":"https://orders.example.com/mcp"},"__proto__":{"url":"https://x.example.com"}}',
    );
    expect(refusedPaths(ProjectDocumentSchema.safeParse(project({ connectors })))).toEqual([
      ['connectors', '__proto__'],
    ]);
    const parsed = ProjectDocumentSchema.parse(
      project({ connectors: { orders: { url: 'https://orders.example.com/mcp' } } }),
    );
    expect(parsed.connectors).toEqual({ orders: { url: 'https://orders.example.com/mcp' } });
    expect(Object.isFrozen(parsed.connectors)).toBe(true);
  });

  const credentialUrls = [
    'https://user:sk-live-SECRET@orders.example.com/mcp',
    'https://x-access-token@orders.example.com/mcp',
    'https://orders.example.com/mcp?api_key=sk-live-SECRET',
    'https://orders.example.com/mcp?region=eu&Access-Token=sk-live-SECRET',
    'http://orders.example.com/mcp?token=sk-live-SECRET',
  ];

  it.each(credentialUrls)('refuses a connector url carrying a credential: %s', (url) => {
    const result = ProjectDocumentSchema.safeParse(project({ connectors: { o: { url } } }));
    expect(refusedPaths(result)).toEqual([['connectors', 'o', 'url']]);
    for (const message of issueMessages(result)) {
      expect(message).not.toContain('sk-live-SECRET');
      expect(message).toContain('secret: NAME');
    }
  });

  it.each(credentialUrls)('refuses a model baseUrl carrying a credential: %s', (baseUrl) => {
    const result = ProjectDocumentSchema.safeParse(
      project({ models: { a: { provider: 'openai', credential: { secret: 'K' }, baseUrl } } }),
    );
    expect(refusedPaths(result)).toEqual([['models', 'a', 'baseUrl']]);
  });

  it('accepts a URL with an ordinary query string', () => {
    const url = 'https://orders.example.com/mcp?region=eu&workspace=demo';
    expect(ProjectDocumentSchema.safeParse(project({ connectors: { o: { url } } })).success).toBe(
      true,
    );
  });

  it('reports one issue for a URL that is not http(s), not a credential issue as well', () => {
    const result = ProjectDocumentSchema.safeParse(
      project({ connectors: { o: { url: 'ftp://u:p@x.example.com' } } }),
    );
    expect(issueMessages(result)).toEqual(['must be an http:// or https:// URL']);
  });
});

describe('environments.production (#621)', () => {
  const withProduction = (production: unknown): unknown => ({
    ...minimal,
    environments: { ...minimal.environments, production },
  });
  const demo = { target: 'single-vm', url: 'https://agents.example.com' };

  it('accepts the demo file, for each deploy target', () => {
    for (const target of PROJECT_DEPLOY_TARGETS) {
      const document = withProduction({ ...demo, target });
      expect(ProjectDocumentSchema.parse(document)).toEqual(document);
    }
  });

  it('refuses an unknown target at environments.production.target', () => {
    expect(
      refusedPaths(ProjectDocumentSchema.safeParse(withProduction({ ...demo, target: 'aws' }))),
    ).toEqual([['environments', 'production', 'target']]);
  });

  it.each([
    'http://agents.example.com',
    'https://owner:hunter2@agents.example.com',
    'https://agents.example.com/?token=hunter2',
    'https://agents.example.com/app',
    'https://agents.example.com/#top',
    'agents.example.com',
  ])('refuses the url %s at environments.production.url', (url) => {
    const result = ProjectDocumentSchema.safeParse(withProduction({ ...demo, url }));
    expect(refusedPaths(result)).toEqual([['environments', 'production', 'url']]);
    expect(result.error?.issues.map((issue) => issue.message).join('\n')).not.toContain('hunter2');
  });

  it('accepts a trailing slash, which names the same origin', () => {
    const document = withProduction({ ...demo, url: 'https://agents.example.com/' });
    expect(ProjectDocumentSchema.safeParse(document).success).toBe(true);
  });

  it.each(['cloud', 'storage', 'identity'])('refuses an extra %s key', (key) => {
    expect(
      refusedPaths(ProjectDocumentSchema.safeParse(withProduction({ ...demo, [key]: 'x' }))),
    ).toEqual([['environments', 'production', key]]);
  });

  it('refuses a production with no target or url', () => {
    expect(refusedPaths(ProjectDocumentSchema.safeParse(withProduction({})))).toEqual([
      ['environments', 'production', 'target'],
      ['environments', 'production', 'url'],
    ]);
  });

  it('still refuses preview beside production', () => {
    const document = {
      ...minimal,
      environments: { ...minimal.environments, production: demo, preview: demo },
    };
    expect(refusedPaths(ProjectDocumentSchema.safeParse(document))).toEqual([
      ['environments', 'preview'],
    ]);
  });

  it('reads a v2 file with production as written, not lifted', () => {
    const result = readProjectDocument(withProduction(demo));
    expect(result.success && result.data.lifted).toBe(false);
  });
});
