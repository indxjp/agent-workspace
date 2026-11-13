/**
 * SDK conformance, problems / models: see `sdk-conformance.test-support.ts` for what this suite pins.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiProblemDetailSchema,
  ApiProblemSchema,
  COMMON_PROBLEM_CODES,
} from '@indx-workspace/contracts';
import {
  DeleteModelConnectionResponseSchema,
  DISCOVERED_MODEL_CAPABILITY_KEYS,
  DiscoveredModelCapabilitiesSchema,
  DiscoveredModelsResponseSchema,
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  isKeylessProvider,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
} from '@indx-workspace/contracts/models';
import { ENGINE_PROBLEM_CODES, EngineCapabilityKeySchema } from '@indx-workspace/contracts/engines';
import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';
import { problem } from './http/result';
import { clearEnginesRegisteredForTests, registerEngineForTests } from './engines/registry';
import { DomainError } from './errors';
import { errorResponse } from './http/error-response';
import {
  parseCreateModelConnection,
  requiredConfigFields,
  toModelConnectionResource,
} from './models/contract';
import { createModelDiscovery } from './models/discovery';
import {
  createModelConnection,
  deleteModelConnection,
  listDiscoveredModels,
  listModelConnections,
  rotateModelConnectionCredential,
  testModelConnection,
} from './models/handlers';
import { createInMemoryModelsStoreProvider } from './models/store';
import { probeModelConnection } from './models/probe';
import { problem as rbacProblem } from './rbac/http';
import { startRun } from './runs/api';
import { InMemoryRunStore } from './runs/memory-store';
import { engineCapabilityRefusal } from './agents/policy';
import { installTestRunApi, resetTestRunApi } from './application-context-fixtures';
import { WORKSPACE } from './sdk-conformance.test-support';

const ENGINE_AGENT = '33333333-3333-4333-8333-333333333333';

const ENGINE_SESSION = '44444444-4444-4444-8444-444444444444';

const MODELS_WORKSPACE = '88888888-8888-4888-8888-888888888888';

// TEST-NET-3 literals over https: the egress policy needs no DNS for them and does not block
// them, so the real parser, probe and discovery adapters run end to end against a fetch double.
const REACHABLE_BASE_URL = 'https://203.0.113.10/v1';

const FAILING_BASE_URL = 'https://203.0.113.11/v1';

const PROVIDER_KEY = 'Provider-Key-Must-Never-Escape';

const modelsStore = () =>
  createInMemoryModelsStoreProvider([MODELS_WORKSPACE]).forWorkspace(MODELS_WORKSPACE);

const providerFetch: typeof fetch = (input) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return Promise.resolve(
    url.startsWith(FAILING_BASE_URL)
      ? Response.json({ error: 'boom' }, { status: 500 })
      : Response.json({ data: [{ id: 'llama-3-70b', created: 0 }] }),
  );
};

const createdResource = async (
  store: ReturnType<typeof modelsStore>,
  name: string,
  baseUrl: string,
) => {
  const created = await createModelConnection(store, {
    name,
    provider: 'openai-compatible',
    apiKey: PROVIDER_KEY,
    config: { baseUrl },
  });
  expect(created.status).toBe(201);
  return ModelConnectionResourceSchema.parse(created.body);
};

describe('problems', () => {
  it('renders a handler problem and a domain error as the one published envelope', async () => {
    expect(
      ApiProblemSchema.safeParse(problem(400, 'invalid_field', 'Bad.', ['name']).body).success,
    ).toBe(true);
    expect(ApiProblemSchema.safeParse(problem(404, 'agent_not_found', 'Gone.').body).success).toBe(
      true,
    );

    const domain = errorResponse(
      new DomainError({ category: 'conflict', code: 'name_conflict', publicMessage: 'Taken.' }),
      { component: 'test', operation: 'conflict', log: () => undefined },
    );
    expect(domain.status).toBe(409);
    expect(ApiProblemSchema.parse(await domain.json()).error.code).toBe('name_conflict');
  });
});

describe('problems', () => {
  /**
   * ADR-0065's two enforcement refusals, from the real handlers, against the published envelope and
   * the published status table (ENG-02b, #318). The point of testing them here rather than only at
   * the routes is drift: `ENGINE_PROBLEM_CODES` is what an SDK consumer branches on, and a route
   * that answered the same code under a different status would still pass its own suite.
   */
  describe('engine refusals', () => {
    afterEach(() => {
      resetTestRunApi();
      clearEnginesRegisteredForTests();
    });

    it('renders session_engine_mismatch from the real run route as the published envelope', async () => {
      installTestRunApi({
        authenticate: () =>
          Promise.resolve({
            principalId: '77777777-7777-4777-8777-777777777777',
            ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
            userId: '66666666-6666-4666-8666-666666666666',
            workspaceId: WORKSPACE,
            role: 'owner' as const,
            scope: null,
          }),
        findAgent: (principal, agentId) =>
          Promise.resolve(
            agentId === ENGINE_AGENT
              ? // A test-only engine: the only way two engine ids can differ while `ENGINE_IDS`
                // publishes one member.
                { id: ENGINE_AGENT, workspaceId: principal.workspaceId, engine: 'test-only-engine' }
              : null,
          ),
        openSession: () =>
          Promise.resolve({
            id: ENGINE_SESSION,
            agentId: ENGINE_AGENT,
            engine: 'claude-agent-sdk',
          }),
        ownsRun: () => Promise.resolve(true),
        store: new InMemoryRunStore(),
        launch: () => undefined,
      });

      const response = await startRun(
        new Request(`http://web/api/agents/${ENGINE_AGENT}/runs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt: 'hi', sessionId: ENGINE_SESSION }),
        }),
        ENGINE_AGENT,
      );

      const envelope = ApiProblemSchema.parse(await response.json());
      expect(envelope.error.code).toBe('session_engine_mismatch');
      expect(response.status).toBe(ENGINE_PROBLEM_CODES.session_engine_mismatch);
    });
  });
});

describe('problems', () => {
  describe('engine refusals', () => {
    afterEach(() => {
      resetTestRunApi();
      clearEnginesRegisteredForTests();
    });

    it('renders engine_capability_unsupported as the published envelope, details being the capability', () => {
      registerEngineForTests({
        id: 'claude-agent-sdk',
        displayName: 'Claude Agent SDK (test: no MCP)',
        version: 'test',
        capabilities: {
          mcp: false,
          skills: true,
          subagents: false,
          resume: true,
          fork: false,
          interrupt: true,
          streamingText: false,
          reasoning: true,
          maxTurns: 'native',
          maxBudget: 'native',
          wireProtocols: ['anthropic-messages'],
        },
      });
      const refusal = engineCapabilityRefusal('claude-agent-sdk', {
        connectors: true,
        skills: false,
      });
      expect(refusal).not.toBeNull();
      if (refusal === null) return;
      const envelope = ApiProblemSchema.parse(refusal.body);
      expect(envelope.error.code).toBe('engine_capability_unsupported');
      expect(refusal.status).toBe(ENGINE_PROBLEM_CODES.engine_capability_unsupported);
      // Exactly one detail, and it is a capability the contract publishes — not prose a client
      // would have to parse.
      expect(envelope.error.details).toHaveLength(1);
      expect(EngineCapabilityKeySchema.parse(envelope.error.details?.[0])).toBe('mcp');
    });
  });
});

describe('problems', () => {
  it('renders the RBAC layer’s problems in the standard envelope, with detail as a deprecated duplicate', () => {
    const body = rbacProblem(409, 'last_owner', 'The last owner cannot leave.').body;
    const parsed = ApiProblemSchema.parse(body);
    expect(parsed.error.code).toBe('last_owner');
    expect(parsed.error.message).toBe('The last owner cannot leave.');
    expect(parsed.error.detail).toBe(parsed.error.message);
    // The detail-only schema now describes only what an older deployment answers.
    expect(ApiProblemDetailSchema.safeParse(body).success).toBe(false);
  });

  it('never lets an infrastructure cause cross, and uses a common code the contract knows', async () => {
    const response = errorResponse(new Error('relation "runs" does not exist'), {
      component: 'test',
      operation: 'boom',
      log: () => undefined,
    });
    const envelope = ApiProblemSchema.parse(await response.json());
    expect(envelope.error.message).not.toContain('relation');
    expect(COMMON_PROBLEM_CODES[envelope.error.code as keyof typeof COMMON_PROBLEM_CODES]).toBe(
      response.status,
    );
  });
});

describe('models', () => {
  it('renders the server resource into the published shape, without the credential', () => {
    const record = {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: MODELS_WORKSPACE,
      name: 'Anthropic',
      provider: 'anthropic' as const,
      config: {},
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
      updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    };
    const bare = ModelConnectionResourceSchema.parse(toModelConnectionResource(record, true));
    expect(bare.ready).toBe(true);
    const azure = ModelConnectionResourceSchema.parse(
      toModelConnectionResource(
        {
          ...record,
          provider: 'azure-openai',
          config: { baseUrl: 'https://example.openai.azure.com', apiVersion: '2024-10-21' },
        },
        true,
      ),
    );
    // A credential with an incomplete config is not ready — the contract's own definition.
    expect(azure.ready).toBe(false);
    expect(JSON.stringify(azure)).not.toContain(PROVIDER_KEY);
  });
});

describe('models', () => {
  it('restates the same providers and config rules as the contract', async () => {
    const sample = {
      baseUrl: 'https://provider.example',
      deployment: 'd',
      apiVersion: 'v',
      projectId: 'my-project-123',
      location: 'eu',
    };
    const acceptedConfig = async (provider: (typeof MODEL_PROVIDERS)[number], config: unknown) =>
      (
        await parseCreateModelConnection(
          {
            name: 'n',
            provider,
            ...(isKeylessProvider(provider) ? {} : { apiKey: 'k' }),
            config,
          },
          () => Promise.resolve({ ok: true }),
        )
      ).ok;
    for (const provider of MODEL_PROVIDERS) {
      const rule = MODEL_PROVIDER_CONFIG_RULES[provider];
      expect([...requiredConfigFields(provider)]).toEqual([...rule.required]);
      const required = Object.fromEntries(rule.required.map((field) => [field, sample[field]]));
      expect(await acceptedConfig(provider, required), `${provider}: required`).toBe(true);
      for (const field of MODEL_CONNECTION_CONFIG_FIELDS) {
        expect(
          await acceptedConfig(provider, { ...required, [field]: sample[field] }),
          `${provider}: ${field}`,
        ).toBe(rule.allowed.includes(field));
      }
      for (const field of rule.required) {
        const without = Object.fromEntries(
          Object.entries(required).filter(([key]) => key !== field),
        );
        expect(await acceptedConfig(provider, without), `${provider}: without ${field}`).toBe(
          false,
        );
      }
    }
  });

  it('renders the list, the delete outcome and the rotation through the real handlers', async () => {
    const store = modelsStore();
    const connection = await createdResource(store, 'Compatible', REACHABLE_BASE_URL);
    const listed = await listModelConnections(store);
    expect(listed.status).toBe(200);
    expect(ModelConnectionListResponseSchema.parse(listed.body).models).toEqual([connection]);

    const rotated = await rotateModelConnectionCredential(store, connection.id, {
      apiKey: 'Rotated-Key',
    });
    expect(rotated).toEqual({ status: 204, body: null });

    const deleted = await deleteModelConnection(store, connection.id);
    expect(deleted.status).toBe(200);
    expect(DeleteModelConnectionResponseSchema.safeParse(deleted.body).success).toBe(true);
  });
});

describe('models', () => {
  it('renders the probe outcome under 200 and 502 into the one published shape', async () => {
    const store = modelsStore();
    const reachable = await createdResource(store, 'Reachable', REACHABLE_BASE_URL);
    const failing = await createdResource(store, 'Failing', FAILING_BASE_URL);
    const probe = (resolved: Parameters<typeof probeModelConnection>[0]) =>
      probeModelConnection(resolved, providerFetch);

    const succeeded = await testModelConnection(store, reachable.id, probe);
    expect(succeeded.status).toBe(200);
    expect(ModelConnectionTestOutcomeSchema.parse(succeeded.body).ok).toBe(true);

    const failed = await testModelConnection(store, failing.id, probe);
    expect(failed.status).toBe(502);
    const outcome = ModelConnectionTestOutcomeSchema.parse(failed.body);
    expect(outcome).toMatchObject({ ok: false, status: 500 });
    expect(JSON.stringify(failed.body)).not.toContain(PROVIDER_KEY);
  });

  it('renders discovery rows and the unavailable list through the real adapter', async () => {
    const store = modelsStore();
    const reachable = await createdResource(store, 'Reachable', REACHABLE_BASE_URL);
    const failing = await createdResource(store, 'Failing', FAILING_BASE_URL);
    const discovered = await listDiscoveredModels(
      store,
      createModelDiscovery({ fetch: providerFetch }),
    );
    expect(discovered.status).toBe(200);
    const catalog = DiscoveredModelsResponseSchema.parse(discovered.body);
    expect(catalog.models).toEqual([
      expect.objectContaining({ connectionId: reachable.id, providerModelId: 'llama-3-70b' }),
    ]);
    expect(catalog.unavailable).toEqual([
      expect.objectContaining({ connectionId: failing.id, connectionName: 'Failing' }),
    ]);
    expect(JSON.stringify(discovered.body)).not.toContain(PROVIDER_KEY);
  });

  it('reports exactly the capability flags the gateway registry publishes', () => {
    for (const row of createProviderRegistry()) {
      expect(Object.keys(row.capabilities).sort(), row.id).toEqual(
        [...DISCOVERED_MODEL_CAPABILITY_KEYS].sort(),
      );
      expect(DiscoveredModelCapabilitiesSchema.safeParse(row.capabilities).success).toBe(true);
    }
  });
});
