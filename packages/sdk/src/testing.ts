/**
 * `@indx-workspace/sdk/testing`: test a consumer of the SDK without a network (P-2, issue #246).
 *
 * `createClient` takes a `fetch`; {@link fetchDouble} is one that records every request and answers
 * with whatever `Response` the test builds. The response helpers build the body shapes the SDK
 * reads (JSON, a complete event stream, a stream that drops, a stream that stays open), and
 * {@link fixtures} builds resources the contracts schemas accept — an agent, a run, a session, and
 * an agent version and its pointer (S1-09, issue #447). The SDK's own suites use the same module,
 * so a test written against it reads like theirs. Nothing here depends on a test runner.
 */

import {
  AgentVersionPointerSchema,
  AgentVersionResourceSchema,
  type AgentVersionPointer,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import { AgentResourceSchema, type AgentResource } from '@indx-workspace/contracts/agents';
import {
  ConnectorResourceSchema,
  type ConnectorResource,
} from '@indx-workspace/contracts/connectors';
import {
  ModelConnectionResourceSchema,
  type ModelConnectionResource,
} from '@indx-workspace/contracts/models';
import {
  RunResourceSchema,
  isTerminalRunStatus,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import { SessionResourceSchema, type SessionResource } from '@indx-workspace/contracts/sessions';

/** One request the double saw, with the body already decoded when it was JSON text. */
export interface RecordedRequest {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly init: RequestInit;
  readonly json: unknown;
}

export interface FetchDouble {
  readonly fetch: typeof fetch;
  readonly calls: RecordedRequest[];
}

/** A `fetch` that records every call and answers with whatever `route` returns. */
export function fetchDouble(
  route: (request: RecordedRequest) => Response | Promise<Response>,
): FetchDouble {
  const calls: RecordedRequest[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const body = init?.body;
    const recorded: RecordedRequest = {
      url: new URL(href),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      init: init ?? {},
      json: typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined,
    };
    calls.push(recorded);
    return Promise.resolve(route(recorded));
  };
  return { fetch: impl, calls };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });
}

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8' } as const;

/** A complete stream: `text`, then a clean end of body. */
export function eventStreamResponse(text: string): Response {
  return new Response(text, { status: 200, headers: SSE_HEADERS });
}

/**
 * A stream that delivers `text` and then fails the way a dropped connection does — the body
 * errors, so `reader.read()` rejects with `cause` — rather than ending cleanly.
 */
export function droppedEventStreamResponse(
  text: string,
  cause: Error = new TypeError('terminated'),
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    // Called once the chunk has been read: erroring earlier would discard it from the queue.
    pull(controller) {
      controller.error(cause);
    },
  });
  return new Response(body, { status: 200, headers: SSE_HEADERS });
}

/**
 * A stream that delivers `text` and then stays open until the consumer cancels it, recording
 * that it did. `cancelled()` is the fact a leak test asserts.
 */
export function openEventStreamResponse(text: string): {
  readonly response: Response;
  readonly cancelled: () => boolean;
} {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: SSE_HEADERS }),
    cancelled: () => cancelled,
  };
}

/** Consume an async iterable to its end, keeping nothing. */
export async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const item of iterable) void item;
}

const FIXTURE_TIME = '2026-01-01T00:00:00.000Z';
const FIXTURE_END_TIME = '2026-01-01T00:00:01.000Z';
const WORKSPACE_ID = '44444444-4444-4444-8444-444444444444';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL_ID = '55555555-5555-4555-8555-555555555555';
const AGENT_VERSION_ID = '66666666-6666-4666-8666-666666666666';
const MODEL_CONNECTION_ID = '88888888-8888-4888-8888-888888888888';
const CONNECTOR_ID = '77777777-7777-4777-8777-777777777777';
const OPENAPI_CONNECTOR_ID = '99999999-9999-4999-8999-999999999999';
const POSTGRES_CONNECTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function agent(overrides: Partial<AgentResource> = {}): AgentResource {
  return AgentResourceSchema.parse({
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Support',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    },
    createdBy: null,
    ownerPrincipalId: PRINCIPAL_ID,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

/**
 * A run in `status` (default `queued`). A terminal status also gets `startedAt`, `endedAt` and
 * `durationMs` unless the overrides name them, so `run({ status: 'completed' })` reads like a run
 * the server really settled.
 */
function run(overrides: Partial<RunResource> = {}): RunResource {
  const status = overrides.status ?? 'queued';
  const ended = isTerminalRunStatus(status);
  return RunResourceSchema.parse({
    id: RUN_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    projectId: null,
    initiatingUserId: null,
    sessionId: SESSION_ID,
    status,
    createdAt: FIXTURE_TIME,
    startedAt: ended || status === 'running' ? FIXTURE_TIME : null,
    endedAt: ended ? FIXTURE_END_TIME : null,
    durationMs: ended ? 1000 : null,
    model: null,
    provider: null,
    modelConnectionId: null,
    engine: 'claude-agent-sdk',
    engineVersion: null,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
    },
    cost: { amount: '0.000000', currency: 'USD', priceTableVersion: null },
    error: status === 'failed' ? 'The run failed.' : null,
    accountingState: ended ? 'complete' : 'pending',
    accountingError: null,
    ...overrides,
  });
}

function session(overrides: Partial<SessionResource> = {}): SessionResource {
  return SessionResourceSchema.parse({
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    userId: null,
    ownerPrincipalId: PRINCIPAL_ID,
    projectId: null,
    engineSessionId: null,
    engine: null,
    title: null,
    status: 'active',
    resumable: false,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

/**
 * Version `1` of {@link agent} (S1-09, issue #447; ADR-0101): the smallest body the contracts
 * accept — a `claude-agent-sdk` policy, no named resources, no surfaces — saved `via: 'api'` by the
 * fixture principal.
 */
function agentVersion(overrides: Partial<AgentVersionResource> = {}): AgentVersionResource {
  return AgentVersionResourceSchema.parse({
    id: AGENT_VERSION_ID,
    agentId: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    number: 1,
    summary: 'First version',
    via: 'api',
    body: {
      definition: {
        apiVersion: 'agentworkspace.dev/v1',
        kind: 'AgentDefinition',
        agent: {
          name: 'Support',
          instructions: '',
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
          model: null,
          modelConnectionName: null,
          runtimeProfileName: null,
        },
        policy: {
          engine: 'claude-agent-sdk',
          tools: {
            base: 'claude_code_preset',
            autoApprove: [],
            deny: [],
            permissionMode: 'default',
            allowDangerouslySkipPermissions: false,
          },
          skills: { mode: 'all' },
          limits: { maxTurns: null, maxBudgetUsd: null },
        },
        policySource: 'stored',
        resources: { files: [], skills: [], connectors: [] },
      },
      surfaces: [],
    },
    createdByPrincipalId: PRINCIPAL_ID,
    createdAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** The `local` environment's pointer at version `1` (S1-09, issue #447; ADR-0101). */
function agentVersionPointer(overrides: Partial<AgentVersionPointer> = {}): AgentVersionPointer {
  return AgentVersionPointerSchema.parse({
    environment: 'local',
    number: 1,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** The workspace's `default` model connection: `anthropic`, with a credential on file. */
function modelConnection(
  overrides: Partial<ModelConnectionResource> = {},
): ModelConnectionResource {
  return ModelConnectionResourceSchema.parse({
    id: MODEL_CONNECTION_ID,
    name: 'default',
    provider: 'anthropic',
    config: {},
    hasCredential: true,
    ready: true,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** The fields every connector kind shares; a tool kind's MCP fields are `null`. */
function connectorBase(id: string, name: string) {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name,
    transport: null,
    command: null,
    args: null,
    url: null,
    authType: null,
    hasCredential: true,
    enabled: true,
    createdBy: null,
    ownerPrincipalId: PRINCIPAL_ID,
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
  };
}

/** An MCP connector over `http`, with a bearer credential on file. */
function connector(overrides: Partial<ConnectorResource> = {}): ConnectorResource {
  return ConnectorResourceSchema.parse({
    ...connectorBase(CONNECTOR_ID, 'github'),
    transport: 'http',
    url: 'https://mcp.example.com/mcp',
    authType: 'bearer',
    ...overrides,
  });
}

/**
 * An `openapi` connector (C15) with a bearer credential on file, its `GET /**` rule admitting one
 * `GET /orders` operation.
 */
function openApiConnector(overrides: Partial<ConnectorResource> = {}): ConnectorResource {
  return ConnectorResourceSchema.parse({
    ...connectorBase(OPENAPI_CONNECTOR_ID, 'orders-api'),
    kind: 'openapi',
    openapi: {
      spec: { digest: `sha256:${'0'.repeat(64)}`, bytes: 512, title: 'Orders' },
      baseUrl: 'https://api.example.com',
      auth: 'bearer',
      allow: ['GET /**'],
      operations: [{ name: 'listOrders', method: 'GET', path: '/orders' }],
    },
    ...overrides,
  });
}

/** A `postgres` connector (C15) reading `public.orders`, at most 100 rows a read. */
function postgresConnector(overrides: Partial<ConnectorResource> = {}): ConnectorResource {
  return ConnectorResourceSchema.parse({
    ...connectorBase(POSTGRES_CONNECTOR_ID, 'orders-db'),
    kind: 'postgres',
    postgres: { tables: ['public.orders'], readOnly: true, maxRows: 100 },
    ...overrides,
  });
}

/**
 * Contract-valid resources for a response body. Each builder fills every required field, applies
 * the overrides, and parses the result with the resource's contracts schema, so a typo or a value
 * the server could never send fails the test where the fixture is built. The ids are fixed and
 * shared, so `fixtures.run().agentId === fixtures.agent().id`, a run belongs to its session, and
 * `fixtures.agentVersion()` is version `1` of `fixtures.agent()`, defining an agent of the same
 * name, which `fixtures.agentVersionPointer()` points the `local` environment at (S1-09, #447).
 * `fixtures.modelConnection()` is the `default` connection, and `fixtures.connector()`,
 * `fixtures.openApiConnector()` and `fixtures.postgresConnector()` are one connector of each kind
 * (issue #533).
 */
export const fixtures = {
  agent,
  run,
  session,
  agentVersion,
  agentVersionPointer,
  modelConnection,
  connector,
  openApiConnector,
  postgresConnector,
} as const;
