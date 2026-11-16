import { expect, it } from 'vitest';
import { z } from 'zod';
import { LocalRuntimeStartMessageSchema } from './local-runtime.js';
import { PLATFORM_IDS } from './platform-ids.js';
import {
  DEFAULT_BOOTSTRAP_ADMIN,
  DEFAULT_LOCAL_PORT,
  ProjectDocumentSchema,
  readProjectDocument,
} from './project-file.js';

import { identity, minimal, refusedPaths } from './project-file.fixture.test-support.js';

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

it('refuses the keyless vertex provider at its own path', () => {
  const result = ProjectDocumentSchema.safeParse(
    project({ models: { v: { provider: 'vertex', credential: { secret: 'K' } } } }),
  );
  expect(refusedPaths(result)).toEqual([['models', 'v', 'provider']]);
  expect(result.error?.issues[0]?.message).toBe(
    'is set up by aw deploy for gcp-cloudrun, not in the project file',
  );
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
