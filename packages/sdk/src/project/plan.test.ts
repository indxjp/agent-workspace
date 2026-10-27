import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ProjectDocumentSchema,
  type ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import {
  defineAgent,
  openapiTool,
  postgresTool,
  secret,
  toolDefinitionsOf,
  type OpenApiToolInput,
  type PostgresToolInput,
} from '../define/index.js';
import { fixtures } from '../testing.js';
import {
  planProjectResources,
  planProjectSkills,
  type PlanProjectResourcesInput,
  type PlanSecret,
  type PlannedTool,
  type ProjectResourceUpdate,
} from './plan.js';

const EMPTY = { creates: [], updates: [], refusals: [], notices: [], skills: [] };
/** The C6 `default` connection, there so a case about something else plans nothing for models. */
const DEFAULT = fixtures.modelConnection();
const NOTHING = { modelConnections: [], connectors: [] };
const SAVED_DIGEST = fixtures.openApiConnector().openapi?.spec.digest ?? '';
const NEW_DIGEST = `sha256:${'1'.repeat(64)}`;
const DOCUMENT = '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{}}';

/** A secret sent with the value it has now. */
const SENT: PlanSecret = { fingerprint: 'fp-same', sentFingerprint: 'fp-same' };
/** A secret whose value changed since it was last sent. */
const CHANGED: PlanSecret = { fingerprint: 'fp-new', sentFingerprint: 'fp-old' };
/** A secret set now, with no fingerprint recorded at any send. */
const UNRECORDED: PlanSecret = { fingerprint: 'fp-new' };

function project(extra: Record<string, unknown> = {}): ProjectDocument {
  return ProjectDocumentSchema.parse({
    apiVersion: 'agentworkspace.dev/v2',
    kind: 'Project',
    name: 'support-desk',
    environments: {
      local: { cloud: 'local', identity: { bootstrapAdmin: 'admin@localhost.test' } },
    },
    ...extra,
  });
}

function plan(input: Partial<PlanProjectResourcesInput>): ReturnType<typeof planProjectResources> {
  return planProjectResources({
    project: project(),
    tools: [],
    existing: { modelConnections: [DEFAULT], connectors: [] },
    secrets: new Map(),
    ...input,
  });
}

const secrets = (entries: Record<string, PlanSecret>): ReadonlyMap<string, PlanSecret> =>
  new Map(Object.entries(entries));

const ORDERS: OpenApiToolInput = {
  name: 'orders-api',
  spec: './openapi/orders.json',
  allow: ['GET /**'],
  auth: secret('ORDERS_TOKEN'),
};

const WAREHOUSE: PostgresToolInput = {
  name: 'orders-db',
  url: secret('DB_URL'),
  readOnly: true,
  tables: ['public.orders'],
};

/** The planned form of one `openapiTool()`, as the caller hands it over with its document. */
function openApi(input: OpenApiToolInput, digest = SAVED_DIGEST): PlannedTool {
  const [definition] = toolDefinitionsOf(
    defineAgent({ name: 'assistant', instructions: 'x', tools: [openapiTool(input)] }),
  );
  if (definition?.kind !== 'openapi') throw new Error('expected an openapi definition');
  return { definition, document: DOCUMENT, digest };
}

function postgres(input: PostgresToolInput): PlannedTool {
  const [definition] = toolDefinitionsOf(
    defineAgent({ name: 'assistant', instructions: 'x', tools: [postgresTool(input)] }),
  );
  if (definition?.kind !== 'postgres') throw new Error('expected a postgres definition');
  return { definition };
}

const OPENAI = { provider: 'openai', credential: { secret: 'OPENAI_API_KEY' } };
const ANTHROPIC = { provider: 'anthropic', credential: { secret: 'ANTHROPIC_API_KEY' } };
const GITHUB = {
  url: 'https://mcp.example.com/mcp',
  auth: { scheme: 'bearer', credential: { secret: 'GITHUB_TOKEN' } },
};

describe('planProjectResources: C6, a project with no models', () => {
  it('creates only the default connection from ANTHROPIC_API_KEY', () => {
    expect(
      plan({ existing: NOTHING, secrets: secrets({ ANTHROPIC_API_KEY: UNRECORDED }) }),
    ).toStrictEqual({
      ...EMPTY,
      creates: [
        {
          kind: 'model',
          path: 'models.default',
          input: { name: 'default', provider: 'anthropic' },
          secret: 'ANTHROPIC_API_KEY',
        },
      ],
    });
    const withBaseUrl = plan({
      existing: NOTHING,
      secrets: secrets({ ANTHROPIC_API_KEY: UNRECORDED }),
      anthropicBaseUrl: 'https://proxy.example.com',
    });
    expect(withBaseUrl.creates[0]?.input).toStrictEqual({
      name: 'default',
      provider: 'anthropic',
      config: { baseUrl: 'https://proxy.example.com' },
    });
  });

  // Issue #732: a restart with another key or base URL must reach the existing `default`.
  it('rotates an existing default when ANTHROPIC_API_KEY changed', () => {
    expect(plan({ secrets: secrets({ ANTHROPIC_API_KEY: CHANGED }) })).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'model-credential',
          path: 'models.default',
          id: DEFAULT.id,
          secret: 'ANTHROPIC_API_KEY',
        },
      ],
      notices: [
        { path: 'models.default', message: 'ANTHROPIC_API_KEY changed: rotating the credential' },
      ],
    });
    expect(plan({ secrets: secrets({ ANTHROPIC_API_KEY: SENT }) })).toStrictEqual(EMPTY);
  });

  it('patches an existing default only when ANTHROPIC_BASE_URL changed since it was recorded', () => {
    const update = (config: object): ProjectResourceUpdate => ({
      kind: 'model',
      path: 'models.default',
      id: DEFAULT.id,
      patch: { config },
      secret: 'ANTHROPIC_API_KEY',
    });
    const notice = (to: string) => ({
      path: 'models.default',
      message: `ANTHROPIC_BASE_URL changed: base URL ${to}`,
    });
    const key = secrets({ ANTHROPIC_API_KEY: SENT });
    const proxied = fixtures.modelConnection({ config: { baseUrl: 'https://ui.example/v1' } });
    const existing = { modelConnections: [proxied], connectors: [] };

    // A new value since the last start: applied, and the notice names the host only.
    expect(
      plan({
        existing,
        secrets: key,
        anthropicBaseUrl: 'https://user:pw@new.example:8443/v1',
        sentAnthropicBaseUrl: 'https://old.example',
      }),
    ).toStrictEqual({
      ...EMPTY,
      updates: [update({ baseUrl: 'https://user:pw@new.example:8443/v1' })],
      notices: [notice('updated to new.example:8443')],
    });
    // Removed since the last start: cleared.
    expect(
      plan({ existing, secrets: key, sentAnthropicBaseUrl: 'https://old.example' }),
    ).toStrictEqual({
      ...EMPTY,
      updates: [update({})],
      notices: [notice('cleared to the provider default')],
    });
    // Unchanged since the last start: a base URL set elsewhere (the UI) is kept, set or unset.
    expect(plan({ existing, secrets: key, sentAnthropicBaseUrl: null })).toStrictEqual(EMPTY);
    expect(
      plan({
        existing,
        secrets: key,
        anthropicBaseUrl: 'https://old.example',
        sentAnthropicBaseUrl: 'https://old.example',
      }),
    ).toStrictEqual(EMPTY);
    // Nothing recorded: a set value that differs is applied; an unset one never clears.
    expect(
      plan({ existing, secrets: key, anthropicBaseUrl: 'https://new.example' }).updates,
    ).toStrictEqual([update({ baseUrl: 'https://new.example' })]);
    expect(plan({ existing, secrets: key })).toStrictEqual(EMPTY);
  });

  it('leaves an existing default alone when ANTHROPIC_API_KEY is unset or it is not Anthropic', () => {
    expect(plan({ anthropicBaseUrl: 'https://new.example' })).toStrictEqual(EMPTY);
    const openai = fixtures.modelConnection({ provider: 'openai' });
    const existing = { modelConnections: [openai], connectors: [] };
    expect(plan({ existing, secrets: secrets({ ANTHROPIC_API_KEY: CHANGED }) })).toStrictEqual(
      EMPTY,
    );
  });

  it('only reports when ANTHROPIC_API_KEY is not set', () => {
    expect(plan({ existing: NOTHING })).toStrictEqual({
      ...EMPTY,
      notices: [
        {
          path: 'models.default',
          message:
            'no "default" model connection yet; set ANTHROPIC_API_KEY and restart aw dev to create one',
        },
      ],
    });
  });
});

describe('planProjectResources: models (C11)', () => {
  const existing = { modelConnections: [fixtures.modelConnection()], connectors: [] };

  it('creates a missing connection with its declared config only', () => {
    const result = plan({
      project: project({
        models: { openai: { ...OPENAI, baseUrl: 'https://openai.example.com/v1' } },
      }),
      existing,
      secrets: secrets({ OPENAI_API_KEY: UNRECORDED }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      creates: [
        {
          kind: 'model',
          path: 'models.openai',
          input: {
            name: 'openai',
            provider: 'openai',
            config: { baseUrl: 'https://openai.example.com/v1' },
          },
          secret: 'OPENAI_API_KEY',
        },
      ],
    });
  });

  it('refuses a provider change and does nothing else for that connection', () => {
    const result = plan({
      project: project({ models: { default: { ...OPENAI, baseUrl: 'https://x.example.com' } } }),
      existing,
      secrets: secrets({ OPENAI_API_KEY: CHANGED }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      refusals: [
        {
          path: 'models.default.provider',
          message:
            'the connection is anthropic on the server and openai here; a provider cannot change: rename the connection',
        },
      ],
    });
  });

  it('updates a config that differs with every declared field, a removed one absent', () => {
    const proxied = {
      modelConnections: [fixtures.modelConnection({ config: { baseUrl: 'https://old.example' } })],
      connectors: [],
    };
    const changed = plan({
      project: project({ models: { default: { ...ANTHROPIC, baseUrl: 'https://new.example' } } }),
      existing: proxied,
      secrets: secrets({ ANTHROPIC_API_KEY: SENT }),
    });
    expect(changed).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'model',
          path: 'models.default',
          id: fixtures.modelConnection().id,
          patch: { config: { baseUrl: 'https://new.example' } },
          secret: 'ANTHROPIC_API_KEY',
        },
      ],
    });
    const removed = plan({
      project: project({ models: { default: ANTHROPIC } }),
      existing: proxied,
      secrets: secrets({ ANTHROPIC_API_KEY: SENT }),
    });
    expect(removed.updates).toStrictEqual([
      {
        kind: 'model',
        path: 'models.default',
        id: fixtures.modelConnection().id,
        patch: { config: {} },
        secret: 'ANTHROPIC_API_KEY',
      },
    ]);
  });

  it('rotates the credential of a connection the server holds none for', () => {
    const result = plan({
      project: project({ models: { default: ANTHROPIC } }),
      existing: {
        modelConnections: [fixtures.modelConnection({ hasCredential: false })],
        connectors: [],
      },
      secrets: secrets({ ANTHROPIC_API_KEY: SENT }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'model-credential',
          path: 'models.default',
          id: fixtures.modelConnection().id,
          secret: 'ANTHROPIC_API_KEY',
        },
      ],
    });
  });
});

describe('planProjectResources: secret fingerprints (SD16)', () => {
  const declared = project({ models: { default: ANTHROPIC } });
  const existing = { modelConnections: [fixtures.modelConnection()], connectors: [] };
  const rotate = {
    kind: 'model-credential',
    path: 'models.default',
    id: fixtures.modelConnection().id,
    secret: 'ANTHROPIC_API_KEY',
  };

  it('rotates a changed secret with a notice that names it', () => {
    expect(
      plan({ project: declared, existing, secrets: secrets({ ANTHROPIC_API_KEY: CHANGED }) }),
    ).toStrictEqual({
      ...EMPTY,
      updates: [rotate],
      notices: [
        { path: 'models.default', message: 'ANTHROPIC_API_KEY changed: rotating the credential' },
      ],
    });
  });

  it('does nothing for an unchanged secret', () => {
    expect(
      plan({ project: declared, existing, secrets: secrets({ ANTHROPIC_API_KEY: SENT }) }),
    ).toStrictEqual(EMPTY);
  });

  it('rotates once, with no notice, when no fingerprint was recorded', () => {
    expect(
      plan({ project: declared, existing, secrets: secrets({ ANTHROPIC_API_KEY: UNRECORDED }) }),
    ).toStrictEqual({ ...EMPTY, updates: [rotate] });
  });
});

describe('planProjectResources: an unset secret', () => {
  it('reports it and skips its resource while the others are still planned', () => {
    const result = plan({
      project: project({ models: { default: ANTHROPIC, openai: OPENAI } }),
      existing: NOTHING,
      secrets: secrets({ ANTHROPIC_API_KEY: UNRECORDED }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      creates: [
        {
          kind: 'model',
          path: 'models.default',
          input: { name: 'default', provider: 'anthropic' },
          secret: 'ANTHROPIC_API_KEY',
        },
      ],
      notices: [
        {
          path: 'models.openai',
          message:
            'OPENAI_API_KEY is not set: run export OPENAI_API_KEY=… in the shell aw dev started from, then restart aw dev',
        },
      ],
    });
  });
});

describe('planProjectResources: never deletes', () => {
  it('leaves every undeclared connection and connector alone', () => {
    const undeclared = {
      modelConnections: [
        fixtures.modelConnection(),
        fixtures.modelConnection({ id: 'm-2', name: 'legacy', provider: 'openai' }),
      ],
      connectors: [
        fixtures.connector({ name: 'jira' }),
        fixtures.openApiConnector(),
        fixtures.postgresConnector(),
      ],
    };
    const result = plan({
      project: project({ models: { openai: OPENAI }, connectors: { github: GITHUB } }),
      existing: undeclared,
      secrets: secrets({ OPENAI_API_KEY: UNRECORDED, GITHUB_TOKEN: UNRECORDED }),
    });
    expect(result.creates.map((action) => action.path)).toStrictEqual([
      'models.openai',
      'connectors.github',
    ]);
    expect(result.updates).toStrictEqual([]);
    const text = JSON.stringify(result);
    for (const resource of [...undeclared.modelConnections, ...undeclared.connectors]) {
      expect(text).not.toContain(resource.id);
    }
  });

  it('has no delete action at all', () => {
    expectTypeOf<ProjectResourceUpdate['kind']>().toEqualTypeOf<
      'model' | 'model-credential' | 'connector' | 'connector-credential'
    >();
  });
});

describe('planProjectResources: MCP connectors (C10)', () => {
  const github = fixtures.connector();

  it('creates a declared connector with its auth scheme and secret', () => {
    expect(
      plan({
        project: project({ connectors: { github: GITHUB } }),
        secrets: secrets({ GITHUB_TOKEN: UNRECORDED }),
      }),
    ).toStrictEqual({
      ...EMPTY,
      creates: [
        {
          kind: 'connector',
          path: 'connectors.github',
          input: {
            name: 'github',
            transport: 'http',
            url: 'https://mcp.example.com/mcp',
            authType: 'bearer',
          },
          secret: 'GITHUB_TOKEN',
        },
      ],
    });
  });

  describe('identity (ADR-0142 D1)', () => {
    const IDENTITY = { secret: 'GITHUB_IDENTITY_KEY' };
    const declared = (identity?: typeof IDENTITY): ProjectDocument =>
      project({
        connectors: {
          github: { ...GITHUB, ...(identity === undefined ? {} : { identity }) },
        },
      });
    const tokens = secrets({ GITHUB_TOKEN: SENT });

    it('creates a connector with the identity it declares', () => {
      const result = plan({ project: declared(IDENTITY), secrets: tokens });
      expect(result.refusals).toStrictEqual([]);
      expect(result.creates[0]?.input).toMatchObject({ name: 'github', identity: IDENTITY });
    });

    it('patches an identity that changed, and nothing for one that did not', () => {
      const existing = (identity?: typeof IDENTITY): PlanProjectResourcesInput['existing'] => ({
        modelConnections: [DEFAULT],
        connectors: [{ ...github, ...(identity === undefined ? {} : { identity }) }],
      });
      expect(
        plan({ project: declared(IDENTITY), existing: existing(), secrets: tokens }).updates,
      ).toStrictEqual([
        {
          kind: 'connector',
          path: 'connectors.github',
          id: github.id,
          patch: { identity: IDENTITY },
          secret: 'GITHUB_TOKEN',
        },
      ]);
      expect(
        plan({
          project: declared({ secret: 'OTHER_KEY' }),
          existing: existing(IDENTITY),
          secrets: tokens,
        }).updates[0],
      ).toMatchObject({ patch: { identity: { secret: 'OTHER_KEY' } } });
      expect(
        plan({ project: declared(IDENTITY), existing: existing(IDENTITY), secrets: tokens }),
      ).toStrictEqual(EMPTY);
    });

    it('removes the opt-in with null when the project stops declaring it', () => {
      const result = plan({
        project: declared(),
        existing: {
          modelConnections: [DEFAULT],
          connectors: [{ ...github, identity: IDENTITY }],
        },
        secrets: tokens,
      });
      expect(result.updates[0]).toMatchObject({ patch: { identity: null } });
    });
  });

  it('patches a changed url with the secret, which a retarget requires', () => {
    const result = plan({
      project: project({
        connectors: { github: { ...GITHUB, url: 'https://mcp.example.com/v2' } },
      }),
      existing: { modelConnections: [DEFAULT], connectors: [github] },
      secrets: secrets({ GITHUB_TOKEN: SENT }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'connector',
          path: 'connectors.github',
          id: github.id,
          patch: { url: 'https://mcp.example.com/v2' },
          secret: 'GITHUB_TOKEN',
        },
      ],
    });
  });

  it('drops the auth when none is declared, sending no secret', () => {
    const result = plan({
      project: project({ connectors: { github: { url: 'https://mcp.example.com/mcp' } } }),
      existing: { modelConnections: [DEFAULT], connectors: [github] },
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'connector',
          path: 'connectors.github',
          id: github.id,
          patch: { authType: 'none' },
        },
      ],
    });
  });

  it('rotates the credential alone when nothing else changed', () => {
    const result = plan({
      project: project({ connectors: { github: GITHUB } }),
      existing: { modelConnections: [DEFAULT], connectors: [github] },
      secrets: secrets({ GITHUB_TOKEN: UNRECORDED }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'connector-credential',
          path: 'connectors.github',
          id: github.id,
          secret: 'GITHUB_TOKEN',
        },
      ],
    });
  });

  it('notes the rotation when a recorded connector credential changed', () => {
    const result = plan({
      project: project({ connectors: { github: GITHUB } }),
      existing: { modelConnections: [DEFAULT], connectors: [github] },
      secrets: secrets({ GITHUB_TOKEN: CHANGED }),
    });
    expect(result.updates).toStrictEqual([
      {
        kind: 'connector-credential',
        path: 'connectors.github',
        id: github.id,
        secret: 'GITHUB_TOKEN',
      },
    ]);
    expect(result.notices).toStrictEqual([
      { path: 'connectors.github', message: 'GITHUB_TOKEN changed: rotating the credential' },
    ]);
  });

  it('refuses a connector of another transport or kind under the same name', () => {
    const sse = plan({
      project: project({ connectors: { github: GITHUB } }),
      existing: {
        modelConnections: [DEFAULT],
        connectors: [fixtures.connector({ transport: 'sse' })],
      },
      secrets: secrets({ GITHUB_TOKEN: SENT }),
    });
    expect(sse).toStrictEqual({
      ...EMPTY,
      refusals: [
        {
          path: 'connectors.github',
          message: 'a connector of this name exists as sse, not http; rename one',
        },
      ],
    });
    const tool = plan({
      project: project({ connectors: { 'orders-api': GITHUB } }),
      existing: { modelConnections: [DEFAULT], connectors: [fixtures.openApiConnector()] },
      secrets: secrets({ GITHUB_TOKEN: SENT }),
    });
    expect(tool.refusals).toStrictEqual([
      {
        path: 'connectors.orders-api',
        message: 'a connector of this name exists as openapi, not http; rename one',
      },
    ]);
    expect([tool.creates, tool.updates]).toStrictEqual([[], []]);
  });
});

describe('planProjectResources: tools (C15)', () => {
  const ordersApi = fixtures.openApiConnector();
  const ordersDb = fixtures.postgresConnector();
  const withTools = { modelConnections: [DEFAULT], connectors: [ordersApi, ordersDb] };
  const tokens = secrets({ ORDERS_TOKEN: SENT, DB_URL: SENT });
  const ordersBody = {
    kind: 'openapi',
    name: 'orders-api',
    document: DOCUMENT,
    allow: ['GET /**'],
    auth: 'bearer',
  };

  it('creates a missing tool with its whole body and its secret', () => {
    const result = plan({
      tools: [openApi(ORDERS), postgres({ ...WAREHOUSE, maxRows: 50 })],
      secrets: secrets({ ORDERS_TOKEN: UNRECORDED, DB_URL: UNRECORDED }),
    });
    expect(result).toStrictEqual({
      ...EMPTY,
      creates: [
        { kind: 'connector', path: 'tools.orders-api', input: ordersBody, secret: 'ORDERS_TOKEN' },
        {
          kind: 'connector',
          path: 'tools.orders-db',
          input: {
            kind: 'postgres',
            name: 'orders-db',
            tables: ['public.orders'],
            readOnly: true,
            maxRows: 50,
          },
          secret: 'DB_URL',
        },
      ],
    });
  });

  it('registers a tool again with its whole body when its document digest changed', () => {
    expect(
      plan({ tools: [openApi(ORDERS, NEW_DIGEST)], existing: withTools, secrets: tokens }),
    ).toStrictEqual({
      ...EMPTY,
      updates: [
        {
          kind: 'connector',
          path: 'tools.orders-api',
          id: ordersApi.id,
          patch: ordersBody,
          secret: 'ORDERS_TOKEN',
        },
      ],
    });
  });

  it('sends the identity an openapiTool declares, and re-registers when it changed or went (ADR-0142)', () => {
    const identity = { secret: 'ORDERS_IDENTITY_KEY' };
    const declared = plan({
      tools: [openApi({ ...ORDERS, identity })],
      secrets: secrets({ ORDERS_TOKEN: UNRECORDED }),
    });
    expect(declared.creates[0]?.input).toMatchObject({ identity });
    const saved = { ...ordersApi, identity };
    const existing = { modelConnections: [DEFAULT], connectors: [saved, ordersDb] };
    expect(
      plan({ tools: [openApi({ ...ORDERS, identity })], existing, secrets: tokens }),
    ).toStrictEqual(EMPTY);
    const removed = plan({ tools: [openApi(ORDERS)], existing, secrets: tokens });
    expect(removed.updates[0]).not.toHaveProperty('patch.identity');
    const added = plan({
      tools: [openApi({ ...ORDERS, identity })],
      existing: withTools,
      secrets: tokens,
    });
    expect(added.updates[0]).toMatchObject({ patch: { identity } });
  });

  it('does nothing for the same digest, allow and auth, or postgres at the default maxRows', () => {
    expect(
      plan({ tools: [openApi(ORDERS), postgres(WAREHOUSE)], existing: withTools, secrets: tokens }),
    ).toStrictEqual(EMPTY);
  });

  it('updates a changed allow, auth or declared base URL', () => {
    for (const changed of [
      { ...ORDERS, allow: ['GET /orders'] },
      { ...ORDERS, auth: { header: 'X-Api-Key', credential: secret('ORDERS_TOKEN') } },
      { ...ORDERS, baseUrl: 'https://other.example.com' },
    ]) {
      const result = plan({ tools: [openApi(changed)], existing: withTools, secrets: tokens });
      expect(
        result.updates.map((action) => action.kind),
        JSON.stringify(changed),
      ).toStrictEqual(['connector']);
    }
    const sameBaseUrl = { ...ORDERS, baseUrl: 'https://api.example.com' };
    expect(
      plan({ tools: [openApi(sameBaseUrl)], existing: withTools, secrets: tokens }),
    ).toStrictEqual(EMPTY);
  });

  it('updates postgres tables given in another order, or a maxRows that differs', () => {
    const twoTables = fixtures.postgresConnector({
      postgres: { tables: ['public.orders', 'public.customers'], readOnly: true, maxRows: 100 },
    });
    const reordered = plan({
      tools: [postgres({ ...WAREHOUSE, tables: ['public.customers', 'public.orders'] })],
      existing: { modelConnections: [DEFAULT], connectors: [twoTables] },
      secrets: tokens,
    });
    expect(reordered.updates).toStrictEqual([
      {
        kind: 'connector',
        path: 'tools.orders-db',
        id: twoTables.id,
        patch: {
          kind: 'postgres',
          name: 'orders-db',
          tables: ['public.customers', 'public.orders'],
          readOnly: true,
        },
        secret: 'DB_URL',
      },
    ]);
    const fewerRows = plan({
      tools: [postgres({ ...WAREHOUSE, maxRows: 10 })],
      existing: withTools,
      secrets: tokens,
    });
    expect(fewerRows.updates).toHaveLength(1);
  });

  it('re-sends the whole body when only the secret changed', () => {
    const result = plan({
      tools: [postgres(WAREHOUSE)],
      existing: withTools,
      secrets: secrets({ DB_URL: CHANGED }),
    });
    expect(result.updates).toStrictEqual([
      {
        kind: 'connector',
        path: 'tools.orders-db',
        id: ordersDb.id,
        patch: { kind: 'postgres', name: 'orders-db', tables: ['public.orders'], readOnly: true },
        secret: 'DB_URL',
      },
    ]);
    expect(result.notices).toStrictEqual([
      { path: 'tools.orders-db', message: 'DB_URL changed: rotating the credential' },
    ]);
  });

  it('maps header auth to its header name and creates a tool with no auth without a secret', () => {
    const header = plan({
      tools: [openApi({ ...ORDERS, auth: { header: 'X-Api-Key', credential: secret('K') } })],
      secrets: secrets({ K: UNRECORDED }),
    });
    expect(header.creates).toStrictEqual([
      {
        kind: 'connector',
        path: 'tools.orders-api',
        input: { ...ordersBody, auth: { header: 'X-Api-Key' } },
        secret: 'K',
      },
    ]);
    const anonymous = { name: ORDERS.name, spec: ORDERS.spec, allow: ORDERS.allow };
    expect(plan({ tools: [openApi(anonymous)] }).creates).toStrictEqual([
      { kind: 'connector', path: 'tools.orders-api', input: { ...ordersBody, auth: 'none' } },
    ]);
  });

  it('refuses a tool named like a declared connector, or like a connector of another kind', () => {
    const declared = plan({
      project: project({ connectors: { 'orders-api': GITHUB } }),
      tools: [openApi(ORDERS)],
      secrets: secrets({ GITHUB_TOKEN: UNRECORDED, ORDERS_TOKEN: UNRECORDED }),
    });
    expect(declared.refusals).toStrictEqual([
      {
        path: 'tools.orders-api',
        message:
          'connectors.orders-api declares this name too; tools and connectors share one namespace: rename one',
      },
    ]);
    expect(declared.creates.map((action) => action.path)).toStrictEqual(['connectors.orders-api']);

    const otherKind = plan({
      tools: [postgres({ ...WAREHOUSE, name: 'orders-api' })],
      existing: withTools,
      secrets: tokens,
    });
    expect(otherKind).toStrictEqual({
      ...EMPTY,
      refusals: [
        {
          path: 'tools.orders-api',
          message: 'a connector of this name exists as openapi, not postgres; rename one',
        },
      ],
    });
  });

  it('reports an unset tool secret and skips the tool', () => {
    expect(plan({ tools: [postgres(WAREHOUSE)], existing: withTools })).toStrictEqual({
      ...EMPTY,
      notices: [
        {
          path: 'tools.orders-db',
          message:
            'DB_URL is not set: run export DB_URL=… in the shell aw dev started from, then restart aw dev',
        },
      ],
    });
  });
});

describe('planProjectResources: value safety', () => {
  it('names secrets and never carries a fingerprint or any other value', () => {
    const result = plan({
      project: project({
        models: { default: ANTHROPIC, openai: OPENAI },
        connectors: { github: GITHUB },
      }),
      tools: [openApi(ORDERS, NEW_DIGEST), postgres(WAREHOUSE)],
      existing: {
        modelConnections: [fixtures.modelConnection()],
        connectors: [
          fixtures.connector(),
          fixtures.openApiConnector(),
          fixtures.postgresConnector(),
        ],
      },
      secrets: secrets({
        ANTHROPIC_API_KEY: CHANGED,
        OPENAI_API_KEY: UNRECORDED,
        GITHUB_TOKEN: CHANGED,
        ORDERS_TOKEN: SENT,
        DB_URL: CHANGED,
      }),
    });
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/fp-/u);
    const named = [...result.creates, ...result.updates].flatMap((action) =>
      'secret' in action && action.secret !== undefined ? [action.secret] : [],
    );
    expect(new Set(named)).toStrictEqual(
      new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'ORDERS_TOKEN', 'DB_URL']),
    );
  });
});

describe('planProjectResources: skills', () => {
  const skill = (name: string, hash: string): { name: string; hash: string; files: [] } => ({
    name,
    hash,
    files: [],
  });

  it('creates a folder the workspace lacks, updates a changed one and leaves a same one', () => {
    const result = plan({
      skills: [skill('new', 'h1'), skill('changed', 'h2'), skill('same', 'h3')],
      existing: {
        ...NOTHING,
        modelConnections: [DEFAULT],
        skills: [
          { name: 'changed', hash: 'old' },
          { name: 'same', hash: 'h3' },
          { name: 'only-in-workspace', hash: 'h4' },
        ],
      },
    });
    expect(result.skills.map(({ action, name, path }) => [action, name, path])).toStrictEqual([
      ['create', 'new', 'skills.new'],
      ['update', 'changed', 'skills.changed'],
      ['unchanged', 'same', 'skills.same'],
    ]);
    expect(result.creates).toStrictEqual([]);
    expect(result.updates).toStrictEqual([]);
  });
  it('plans folders on their own, with no workspace skills', () => {
    expect(
      planProjectSkills({ skills: [skill('a', 'h')] }).map(({ action, name }) => [action, name]),
    ).toStrictEqual([['create', 'a']]);
  });
});
