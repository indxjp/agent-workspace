import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import {
  AgentVersionResourceSchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
  UploadToolBundleRequestSchema,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentResource } from '@indx-workspace/contracts/agents';
import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import { TOOL_SANDBOX_CONNECTOR_URL } from '@indx-workspace/contracts/tool-connectors';
import { createClient } from '@indx-workspace/sdk';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliIo } from '../io.js';
import { FIXTURES, IDS, json, tempDirectory, tempFile } from '../testing.js';
import { formatProblem } from './problems.js';
import { pushProject, type PushOptions, type PushReport } from './push.js';

// These tests run the real project loader, a forked Node process that evaluates the definition
// files: a second or more each on a shared CI runner, past vitest's 5 s default when several run.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Issue #546 (S2-07b, SD11/C21): `onEdited: 'refuse'` — what `aw dev` passes — refuses an agent
 * edited outside `aw` before any write, while the default (`aw push`) still overwrites it. A real
 * project goes through the real loader, against a stateful double of the control plane reached
 * through the SDK client.
 */

const ORIGIN = 'http://127.0.0.1:3000';
const DEFINE = `import { defineAgent } from '@indx-workspace/sdk/define';\n`;
const HINT = 'run `aw push --yes` to overwrite it with this file';

function agentFile(name: string, instructions: string): string {
  return `${DEFINE}export default defineAgent({ name: '${name}', instructions: '${instructions}' });\n`;
}

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly json: unknown;
}

/** One agent the double holds: the row, its versions, its `local` pointer and its source. */
interface StoredAgent {
  agent: AgentResource;
  readonly versions: AgentVersionResource[];
  local: { number: number; updatedAt: string } | null;
  /** The version the row was last written from; `null` after an edit outside versions. */
  materialised: number | null;
}

interface Server {
  readonly agents: StoredAgent[];
  /** The workspace's connectors: the catalog tools a push creates. */
  readonly connectors: ConnectorResource[];
  /** The digests of the tool bundles uploaded so far (issue #790). */
  readonly bundles: Set<string>;
  /** Whether the deployment has a tool sandbox (ADR-0118 TS8); without one it refuses code tools. */
  toolSandbox: boolean;
  readonly calls: Recorded[];
  /** The server's clock: every call answers a later time. */
  readonly now: () => string;
}

function clock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 9, 2, 10, 0, tick)).toISOString();
  };
}

function agentId(index: number): string {
  return index === 0 ? IDS.agent : `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
}

function isDryRun(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'dryRun' in body && body.dryRun === true;
}

function versionOf(
  id: string,
  versions: readonly AgentVersionResource[],
  draft: { readonly body: unknown; readonly summary: string; readonly via: string },
  at: string,
): AgentVersionResource {
  const number = versions.length + 1;
  return AgentVersionResourceSchema.parse({
    id: `v-${id}-${String(number)}`,
    agentId: id,
    workspaceId: IDS.workspace,
    number,
    summary: draft.summary,
    via: draft.via,
    body: draft.body,
    createdByPrincipalId: IDS.principal,
    createdAt: at,
  });
}

/** The server's refusal of a version naming a connector the workspace lacks, or `null`. */
function missingConnectors(server: Server, version: { readonly body: unknown }): Response | null {
  const body = version.body as {
    toolBundles?: { tool: string }[];
    definition: { resources: { connectors: string[] } };
  };
  if (!server.toolSandbox && (body.toolBundles ?? []).length > 0) {
    return json(422, {
      error: {
        code: 'code_tool_needs_host',
        message: 'The version uses code tools, so this deployment cannot run it.',
        details: [
          'connector:aw-dev-tools',
          ...(body.toolBundles ?? []).map((bundle) => `tool:${bundle.tool}`),
        ],
      },
    });
  }
  const missing = body.definition.resources.connectors.filter(
    (name) => !server.connectors.some((connector) => connector.name === name),
  );
  return missing.length === 0
    ? null
    : json(422, {
        error: {
          code: 'agent_definition_references_missing',
          message: 'The definition names resources this workspace does not have.',
          details: missing.map((name) => `connector:${name}`),
        },
      });
}

/**
 * The server's refusal of a version naming a subagent the workspace lacks or whose agent has
 * subagents of its own (ADR-0133 D14), or `null`.
 */
function unusableSubagents(server: Server, version: { readonly body: unknown }): Response | null {
  const names = (version.body as { subagents?: { name: string }[] }).subagents ?? [];
  const unusable = names.filter(({ name }) => {
    const held = server.agents.find((candidate) => candidate.agent.name === name);
    const body = held?.versions[held.versions.length - 1]?.body as
      { subagents?: unknown[] } | undefined;
    return held === undefined || (body?.subagents?.length ?? 0) > 0;
  });
  return unusable.length === 0
    ? null
    : json(422, {
        error: {
          code: 'agent_subagent_unusable',
          message: 'The version names subagents that this workspace cannot use.',
          details: unusable.map(({ name }) => `subagent:${name}`),
        },
      });
}

/** The resource the server keeps for a tool body: its document only as a digest. */
function toolResource(id: string, body: Record<string, unknown>): ConnectorResource {
  const document = String(body['document']);
  return fixtures.openApiConnector({
    id,
    name: String(body['name']),
    hasCredential: false,
    openapi: {
      spec: {
        digest: `sha256:${createHash('sha256').update(document, 'utf8').digest('hex')}`,
        bytes: Buffer.byteLength(document, 'utf8'),
      },
      baseUrl: 'https://api.example.com',
      auth: 'none',
      allow: body['allow'] as string[],
      operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{id}' }],
    },
  });
}

/** `GET`/`POST /api/connectors` and `PATCH /api/connectors/:id`, with their dry runs. */
function connectorsAnswer(server: Server, request: Recorded): Response {
  const body = (request.json ?? {}) as Record<string, unknown>;
  if (request.method === 'GET') return json(200, { connectors: server.connectors });
  if (isDryRun(body)) {
    return json(200, {
      ok: true,
      kind: 'ok',
      message: 'ok',
      serverName: null,
      serverVersion: null,
      toolCount: 0,
    });
  }
  if (request.method === 'POST') {
    const id = `99999999-9999-4999-8999-${String(server.connectors.length).padStart(12, '0')}`;
    const created =
      body['transport'] === 'http'
        ? fixtures.connector({
            id,
            name: String(body['name']),
            url: String(body['url']),
            authType: 'none',
            hasCredential: false,
          })
        : toolResource(id, body);
    server.connectors.push(created);
    return json(201, created);
  }
  const index = server.connectors.findIndex((c) => request.path === `/api/connectors/${c.id}`);
  const current = server.connectors[index];
  if (request.method !== 'PATCH' || current === undefined) {
    return json(404, { error: { code: 'connector_not_found', message: 'no connector' } });
  }
  const updated = toolResource(current.id, body);
  server.connectors[index] = updated;
  return json(200, updated);
}

/**
 * The routes a push reads and writes. Setting a pointer writes the row and the pointer with one
 * time, as the server's transaction does; saving a version moves neither.
 */
function answer(server: Server, request: Recorded): Response {
  const route = `${request.method} ${request.path}`;
  if (request.path.startsWith('/api/connectors')) return connectorsAnswer(server, request);
  if (route === 'POST /api/tool-bundles') {
    const { contentBase64 } = UploadToolBundleRequestSchema.parse(request.json);
    const bytes = Buffer.from(contentBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const created = !server.bundles.has(digest);
    server.bundles.add(digest);
    return json(created ? 201 : 200, { bundle: { digest, sizeBytes: bytes.length }, created });
  }
  if (request.method === 'GET' && request.path.startsWith('/api/tool-bundles/')) {
    const digest = request.path.slice('/api/tool-bundles/'.length);
    return server.bundles.has(digest)
      ? json(200, { bundle: { digest, sizeBytes: 1 } })
      : json(404, { error: { code: 'tool_bundle_not_found', message: 'no bundle' } });
  }
  if (route === 'GET /api/agents') {
    return json(200, { agents: server.agents.map((stored) => stored.agent) });
  }
  if (route === 'POST /api/agents') {
    const body = CreateAgentFromVersionRequestSchema.parse(request.json);
    const refused =
      missingConnectors(server, body.version) ?? unusableSubagents(server, body.version);
    if (refused !== null) return refused;
    if (body.dryRun === true) return json(200, { ok: true, number: 1 });
    const id = agentId(server.agents.length);
    const at = server.now();
    const agent = {
      ...FIXTURES.agent,
      id,
      modelConnectionId: null,
      name: body.version.body.definition.agent.name,
      updatedAt: at,
    };
    const version = versionOf(id, [], body.version, at);
    server.agents.push({
      agent,
      versions: [version],
      local: { number: 1, updatedAt: at },
      materialised: 1,
    });
    return json(201, { agent, version });
  }
  const stored = server.agents.find(
    (candidate) =>
      request.path === `/api/agents/${candidate.agent.id}` ||
      request.path.startsWith(`/api/agents/${candidate.agent.id}/`),
  );
  if (stored === undefined) return json(404, { error: { code: 'not_found', message: 'no' } });
  const agentPath = `/api/agents/${stored.agent.id}`;
  if (route === `POST ${agentPath}/versions`) {
    const body = CreateAgentVersionRequestSchema.parse(request.json);
    const refused = missingConnectors(server, body) ?? unusableSubagents(server, body);
    if (refused !== null) return refused;
    if (body.dryRun === true) return json(200, { ok: true, number: stored.versions.length + 1 });
    const version = versionOf(stored.agent.id, stored.versions, body, server.now());
    stored.versions.push(version);
    return json(201, version);
  }
  if (route === `GET ${agentPath}/versions`) {
    return json(200, {
      items: stored.versions,
      pointers: stored.local === null ? [] : [{ environment: 'local', ...stored.local }],
      materialised: stored.materialised,
    });
  }
  if (route === `PUT ${agentPath}/pointers`) {
    const body = SetAgentPointerRequestSchema.parse(request.json);
    const at = server.now();
    stored.agent = { ...stored.agent, updatedAt: at };
    stored.local = { number: body.version, updatedAt: at };
    stored.materialised = body.version;
    return json(200, {
      agent: stored.agent,
      pointer: { environment: 'local', number: body.version, updatedAt: at },
    });
  }
  if (route === `GET ${agentPath}`) return json(200, stored.agent);
  if (route === `GET ${agentPath}/policy`) return json(200, { policy: FIXTURES.policy });
  if (route === `GET ${agentPath}/resources`) {
    return json(200, { assignments: { files: [], skillIds: [], connectorIds: [] } });
  }
  return json(404, { error: { code: 'not_found', message: 'no route' } });
}

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Harness {
  readonly root: string;
  readonly server: Server;
  readonly push: (options: Partial<Pick<PushOptions, 'yes' | 'onEdited'>>) => Promise<PushReport>;
}

async function project(files: Readonly<Record<string, string>>): Promise<Harness> {
  const root = await tempDirectory();
  directories.push(root);
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  const server: Server = {
    agents: [],
    connectors: [],
    bundles: new Set(),
    toolSandbox: true,
    calls: [],
    now: clock(),
  };
  const fetchDouble = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    const body = init?.body;
    const recorded: Recorded = {
      method: init?.method ?? 'GET',
      path: new URL(href).pathname,
      json: typeof body === 'string' ? (JSON.parse(body) as unknown) : undefined,
    };
    server.calls.push(recorded);
    return Promise.resolve(answer(server, recorded));
  };
  const io: CliIo = {
    stdin: () => Promise.resolve(''),
    stdout: () => undefined,
    stderr: () => undefined,
    env: {},
    homeDir: root,
    fetch: fetchDouble,
    isTty: false,
  };
  const client = createClient({
    baseUrl: ORIGIN,
    auth: { kind: 'api-key', apiKey: `ak_live_${'A'.repeat(22)}_${'S'.repeat(43)}` },
    fetch: fetchDouble,
  });
  const push: Harness['push'] = (options) =>
    pushProject({
      client,
      root,
      io,
      signal: new AbortController().signal,
      yes: options.yes ?? true,
      ...(options.onEdited === undefined ? {} : { onEdited: options.onEdited }),
    });
  return { root, server, push };
}

function stored(harness: Harness, name: string): StoredAgent {
  const found = harness.server.agents.find((candidate) => candidate.agent.name === name);
  if (found === undefined) throw new Error(`no agent ${name}`);
  return found;
}

/** An edit in the UI: the row moves on and is no longer its version; the pointer does not move. */
function editInUi(harness: Harness, name: string): StoredAgent {
  const agent = stored(harness, name);
  agent.agent = { ...agent.agent, updatedAt: harness.server.now() };
  agent.materialised = null;
  return agent;
}

/** Forget every call so far: what a case asserts is what its own push sent. */
function resetCalls(harness: Harness): void {
  harness.server.calls.splice(0);
}

/** The requests that wrote something: neither a read nor a dry run. */
function writes(harness: Harness): readonly string[] {
  return harness.server.calls
    .filter((call) => !(call.method === 'GET' || isDryRun(call.json)))
    .map((call) => `${call.method} ${call.path}`);
}

function editedLine(file: string, name: string, agent: StoredAgent): string {
  const local = agent.local;
  if (local === null) throw new Error('the agent has no local pointer');
  return (
    `${file}: local edited_in_ui ["${name}" edited ${agent.agent.updatedAt}, ` +
    `local ${String(local.number)} set ${local.updatedAt}]; ${HINT}`
  );
}

const ASSISTANT = 'agents/assistant.ts';

const CODE_TOOL_PROJECT = {
  [ASSISTANT]: `${DEFINE}import getOrder from '../tools/get-order';
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [getOrder] });
`,
  'tools/get-order.ts': `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({ name: 'get_order', description: 'Look up an order', input: z.object({ id: z.string() }), run: './tools/get-order.run.ts' });
`,
  'tools/get-order.run.ts': 'export default () => 1;\n',
};

async function created(files: Readonly<Record<string, string>>): Promise<Harness> {
  const harness = await project(files);
  const first = await harness.push({});
  expect(first.problems).toEqual([]);
  resetCalls(harness);
  return harness;
}

describe("pushProject's onEdited (issue #546)", () => {
  it('(a) refuses an agent edited in the UI whose body did not change, and writes nothing', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const agent = editInUi(harness, 'assistant');

    const pushed = await harness.push({ onEdited: 'refuse' });
    expect(pushed.problems.map(formatProblem)).toEqual([editedLine(ASSISTANT, 'assistant', agent)]);
    expect(pushed.saved).toBe(false);
    expect(pushed.agents).toEqual([]);
    expect(writes(harness)).toEqual([]);
    expect(agent.local?.number).toBe(1);
  });

  it('(b) refuses an edited agent whose body changed, saving no version', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const agent = editInUi(harness, 'assistant');
    await tempFile(harness.root, ASSISTANT, agentFile('assistant', 'Help people kindly.'));

    const pushed = await harness.push({ onEdited: 'refuse' });
    expect(pushed.problems.map(formatProblem)).toEqual([editedLine(ASSISTANT, 'assistant', agent)]);
    expect(pushed.saved).toBe(false);
    expect(pushed.agents).toEqual([]);
    expect(writes(harness)).toEqual([]);
    expect(agent.versions).toHaveLength(1);
  });

  it('(c) refuses an agent with no local pointer, with versions and with none', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    stored(harness, 'assistant').local = null;
    const noPointer = `${ASSISTANT}: local edited_in_ui ["assistant" has no local pointer]; ${HINT}`;

    const withVersions = await harness.push({ onEdited: 'refuse' });
    expect(withVersions.problems.map(formatProblem)).toEqual([noPointer]);
    expect(withVersions.agents).toEqual([]);
    expect(writes(harness)).toEqual([]);

    // An agent made in the UI: no version and no pointer.
    stored(harness, 'assistant').versions.splice(0);
    const withNone = await harness.push({ onEdited: 'refuse' });
    expect(withNone.problems.map(formatProblem)).toEqual([noPointer]);
    expect(withNone.agents).toEqual([]);
    expect(writes(harness)).toEqual([]);
    // Refused before `agents.export`: no read of the agent, its policy or its resources.
    expect(
      harness.server.calls
        .map((call) => call.path)
        .filter((path) => /^\/api\/agents\/[^/]+(\/policy|\/resources)?$/.test(path)),
    ).toEqual([]);
  });

  it('(d) still writes the other agents of the project', async () => {
    const harness = await created({
      'agents/a.ts': agentFile('a', 'A.'),
      'agents/b.ts': agentFile('b', 'B.'),
    });
    const a = editInUi(harness, 'a');
    await tempFile(harness.root, 'agents/a.ts', agentFile('a', 'A again.'));
    await tempFile(harness.root, 'agents/b.ts', agentFile('b', 'B again.'));
    const b = stored(harness, 'b');

    const pushed = await harness.push({ onEdited: 'refuse' });
    expect(pushed.problems.map(formatProblem)).toEqual([editedLine('agents/a.ts', 'a', a)]);
    expect(pushed.saved).toBe(false);
    expect(pushed.agents.map((agent) => [agent.name, agent.action, agent.saved])).toEqual([
      ['b', 'version', true],
    ]);
    expect(writes(harness)).toEqual([
      `POST /api/agents/${b.agent.id}/versions`,
      `PUT /api/agents/${b.agent.id}/pointers`,
    ]);
  });

  it('(e) overwrites the edit by default, as aw push does', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const agent = editInUi(harness, 'assistant');

    const point = await harness.push({});
    expect(point.problems).toEqual([]);
    expect(point.saved).toBe(true);
    expect(point.agents.map((pushed) => [pushed.action, pushed.local])).toEqual([
      ['point', { from: 1, to: 1 }],
    ]);
    expect(writes(harness)).toEqual([`PUT /api/agents/${agent.agent.id}/pointers`]);

    resetCalls(harness);
    editInUi(harness, 'assistant');
    await tempFile(harness.root, ASSISTANT, agentFile('assistant', 'Help people kindly.'));
    const version = await harness.push({ onEdited: 'overwrite' });
    expect(version.problems).toEqual([]);
    expect(version.agents.map((pushed) => [pushed.action, pushed.local])).toEqual([
      ['version', { from: 1, to: 2 }],
    ]);
    expect(writes(harness)).toEqual([
      `POST /api/agents/${agent.agent.id}/versions`,
      `PUT /api/agents/${agent.agent.id}/pointers`,
    ]);

    // Without --yes the default still only plans, and reports no problem.
    resetCalls(harness);
    editInUi(harness, 'assistant');
    const dry = await harness.push({ yes: false });
    expect(dry.problems).toEqual([]);
    expect(dry.agents.map((pushed) => pushed.action)).toEqual(['point']);
    expect(writes(harness)).toEqual([]);
  });

  it('(f) syncs normally when the row and the pointer were set together', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const agent = stored(harness, 'assistant');
    expect(agent.agent.updatedAt).toBe(agent.local?.updatedAt);

    const unchanged = await harness.push({ onEdited: 'refuse' });
    expect(unchanged.problems).toEqual([]);
    expect(unchanged.agents.map((pushed) => pushed.action)).toEqual(['none']);

    await tempFile(harness.root, ASSISTANT, agentFile('assistant', 'Help people kindly.'));
    const changed = await harness.push({ onEdited: 'refuse' });
    expect(changed.problems).toEqual([]);
    expect(changed.saved).toBe(true);
    expect(changed.agents.map((pushed) => pushed.action)).toEqual(['version']);
    expect(writes(harness)).toEqual([
      `POST /api/agents/${agent.agent.id}/versions`,
      `PUT /api/agents/${agent.agent.id}/pointers`,
    ]);
  });

  // Issue #613: the row's source, not its timestamp, says whether it was edited.
  it('(g) syncs an agent whose row moved without an edit, such as an owner move', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const agent = stored(harness, 'assistant');
    agent.agent = { ...agent.agent, updatedAt: harness.server.now() };

    const pushed = await harness.push({ onEdited: 'refuse' });
    expect(pushed.problems).toEqual([]);
    expect(pushed.agents.map((planned) => planned.action)).toEqual(['none']);
    expect(writes(harness)).toEqual([]);
  });

  it('(h) refuses an agent edited outside versions in the same instant its pointer moved', async () => {
    const harness = await created({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const agent = stored(harness, 'assistant');
    agent.materialised = null;
    expect(agent.agent.updatedAt).toBe(agent.local?.updatedAt);

    const pushed = await harness.push({ onEdited: 'refuse' });
    expect(pushed.problems.map(formatProblem)).toEqual([editedLine(ASSISTANT, 'assistant', agent)]);
    expect(writes(harness)).toEqual([]);
  });

  it('never refuses an agent it creates', async () => {
    const harness = await project({ [ASSISTANT]: agentFile('assistant', 'Help people.') });
    const pushed = await harness.push({ onEdited: 'refuse' });
    expect(pushed.problems).toEqual([]);
    expect(pushed.agents.map((agent) => agent.action)).toEqual(['create']);
  });
});

const ORDERS_TOOL = `import { openapiTool } from '@indx-workspace/sdk/define';
export const orders = openapiTool({ name: 'orders', spec: 'apis/orders.openapi.json', allow: ['GET /orders/*'] });
`;
const ORDERS_AGENT = `${DEFINE}import { orders } from '../tools/orders';
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [orders] });
`;

function ordersDocument(version: string): string {
  return JSON.stringify({ openapi: '3.1.0', info: { title: 'Orders', version }, paths: {} });
}

const TOOL_PROJECT = {
  [ASSISTANT]: ORDERS_AGENT,
  'tools/orders.ts': ORDERS_TOOL,
  'apis/orders.openapi.json': ordersDocument('1'),
};
const ORDERS = { file: 'tools/orders.ts', name: 'orders' };

describe("pushProject's catalog tools (issue #789)", () => {
  it('(a) creates the connector, then the agent version, in an empty workspace', async () => {
    const harness = await project(TOOL_PROJECT);

    const pushed = await harness.push({});
    expect(pushed.problems).toEqual([]);
    expect(pushed.saved).toBe(true);
    expect(pushed.tools).toEqual([{ ...ORDERS, action: 'create' }]);
    expect(pushed.agents.map((agent) => agent.action)).toEqual(['create']);
    expect(writes(harness)).toEqual(['POST /api/connectors', 'POST /api/agents']);
    expect(harness.server.connectors.map((connector) => connector.name)).toEqual(['orders']);
  });

  it('(b) is a no-op the second time', async () => {
    const harness = await created(TOOL_PROJECT);

    const again = await harness.push({});
    expect(again.problems).toEqual([]);
    expect(again.tools).toEqual([{ ...ORDERS, action: 'unchanged' }]);
    expect(again.agents.map((agent) => agent.action)).toEqual(['none']);
    expect(writes(harness)).toEqual([]);
  });

  it('(c) updates the connector when its document changed', async () => {
    const harness = await created(TOOL_PROJECT);
    await tempFile(harness.root, 'apis/orders.openapi.json', ordersDocument('2'));

    const pushed = await harness.push({});
    expect(pushed.problems).toEqual([]);
    expect(pushed.tools).toEqual([{ ...ORDERS, action: 'update' }]);
    expect(writes(harness)).toEqual([expect.stringMatching(/^PATCH \/api\/connectors\//u)]);
  });

  it('(d) without --yes sends no write, lists the tool and plans the agent', async () => {
    const harness = await project(TOOL_PROJECT);

    const planned = await harness.push({ yes: false });
    expect(planned.problems).toEqual([]);
    expect(planned.saved).toBe(false);
    expect(planned.tools).toEqual([{ ...ORDERS, action: 'create' }]);
    expect(planned.agents.map((agent) => [agent.action, agent.saved])).toEqual([['create', false]]);
    expect(writes(harness)).toEqual([]);
  });

  it('(e) creates no connector when another file of the project has a problem', async () => {
    const harness = await project({ ...TOOL_PROJECT, 'agents/broken.ts': 'export default 1;\n' });

    const pushed = await harness.push({});
    expect(pushed.problems).not.toEqual([]);
    expect(pushed.tools).toEqual([]);
    expect(writes(harness)).toEqual([]);
  });

  it('(f) with a tool sandbox, uploads the bundle, makes the host connector, then saves the version', async () => {
    const harness = await project(CODE_TOOL_PROJECT);

    const pushed = await harness.push({});
    expect(pushed.problems).toEqual([]);
    expect(pushed.saved).toBe(true);
    expect(pushed.tools).toEqual([
      { file: 'tools/get-order.ts', name: 'aw-dev-tools', action: 'create' },
    ]);
    expect(pushed.bundles).toMatchObject([{ tool: 'get_order', action: 'upload', saved: true }]);
    expect(harness.server.connectors).toMatchObject([
      { name: 'aw-dev-tools', transport: 'http', url: TOOL_SANDBOX_CONNECTOR_URL },
    ]);
    expect(writes(harness)).toEqual([
      'POST /api/tool-bundles',
      'POST /api/connectors',
      'POST /api/agents',
    ]);
    expect(stored(harness, 'assistant').versions[0]?.body.toolBundles).toMatchObject([
      { tool: 'get_order', description: 'Look up an order' },
    ]);

    // The connector exists now: a second push makes none.
    resetCalls(harness);
    const again = await harness.push({});
    expect(again.problems).toEqual([]);
    expect(again.tools).toEqual([]);
    expect(writes(harness)).toEqual([]);
  });

  it('(g) without --yes, plans the host connector and writes nothing', async () => {
    const harness = await project(CODE_TOOL_PROJECT);

    const planned = await harness.push({ yes: false });
    expect(planned.problems).toEqual([]);
    expect(planned.tools).toEqual([
      { file: 'tools/get-order.ts', name: 'aw-dev-tools', action: 'create' },
    ]);
    expect(planned.agents.map((agent) => agent.action)).toEqual(['create']);
    expect(writes(harness)).toEqual([]);
  });

  it('(h) without a tool sandbox, refuses the code tool by name and makes no connector', async () => {
    const harness = await project(CODE_TOOL_PROJECT);
    harness.server.toolSandbox = false;

    const pushed = await harness.push({});
    expect(pushed.saved).toBe(false);
    expect(pushed.problems.map(formatProblem)).toEqual([
      expect.stringContaining('code_tool_needs_host [connector:aw-dev-tools, tool:get_order]'),
    ]);
    expect(harness.server.connectors).toEqual([]);
    expect(harness.server.agents).toEqual([]);
    expect(writes(harness)).toEqual(['POST /api/tool-bundles']);
  });

  it('(i) refuses a connector named aw-dev-tools that a push did not make, and re-points nothing', async () => {
    const harness = await project(CODE_TOOL_PROJECT);
    harness.server.connectors.push(
      fixtures.connector({ name: 'aw-dev-tools', url: 'https://mine.example/mcp' }),
    );

    const pushed = await harness.push({});
    expect(pushed.problems.map(formatProblem)).toEqual([
      expect.stringContaining('tool_host_connector_conflict [connector:aw-dev-tools]'),
    ]);
    expect(pushed.tools).toEqual([]);
    expect(writes(harness)).toEqual([]);
  });

  it("(j) against aw dev's runtime, treats its aw-dev-tools as the tool host and pins no bundle (BH061-001)", async () => {
    const harness = await project(CODE_TOOL_PROJECT);
    harness.server.toolSandbox = false;
    harness.server.connectors.push(
      fixtures.connector({
        name: 'aw-dev-tools',
        url: 'http://127.0.0.1:41234/mcp/token',
        authType: 'none',
        hasCredential: false,
      }),
    );

    const pushed = await harness.push({});
    expect(pushed.problems.map(formatProblem)).toEqual([]);
    expect(pushed.saved).toBe(true);
    expect(pushed.bundles).toEqual([]);
    expect(writes(harness)).toEqual(['POST /api/agents']);
    expect(stored(harness, 'assistant').versions[0]?.body.toolBundles).toBeUndefined();
  });

  it("(k) against aw dev's runtime, still reports a missing run file (BH061-048)", async () => {
    const harness = await project({
      [ASSISTANT]: CODE_TOOL_PROJECT[ASSISTANT],
      'tools/get-order.ts': CODE_TOOL_PROJECT['tools/get-order.ts'],
    });
    harness.server.connectors.push(
      fixtures.connector({
        name: 'aw-dev-tools',
        url: 'http://127.0.0.1:41234/mcp/token',
        authType: 'none',
        hasCredential: false,
      }),
    );

    const pushed = await harness.push({});
    expect(pushed.saved).toBe(false);
    expect(pushed.problems.map(formatProblem)).toEqual([
      expect.stringContaining('tool_run_file_missing'),
    ]);
    expect(writes(harness)).toEqual([]);
  });
});

describe('pushProject and subagents (ADR-0133 D14)', () => {
  const delegating = (name: string, ...subagents: string[]): string =>
    `${DEFINE}export default defineAgent({ name: '${name}', instructions: 'Help.', subagents: [${subagents
      .map((subagent) => `'${subagent}'`)
      .join(', ')}] });\n`;
  const PARENT_FIRST = {
    'agents/alpha.ts': delegating('alpha', 'beta'),
    'agents/beta.ts': agentFile('beta', 'Research.'),
  };

  it('saves a subagent before the agent naming it, whatever the file order', async () => {
    const harness = await project(PARENT_FIRST);

    const pushed = await harness.push({});

    expect(pushed.problems.map(formatProblem)).toEqual([]);
    expect(pushed.saved).toBe(true);
    expect(harness.server.agents.map((held) => held.agent.name)).toEqual(['beta', 'alpha']);
  });

  it('accepts the parent in a dry run while its project subagent is still to be created', async () => {
    const harness = await project(PARENT_FIRST);

    const pushed = await harness.push({ yes: false });

    expect(pushed.problems).toEqual([]);
    expect(writes(harness)).toEqual([]);
  });

  it('saves an existing agent as a leaf before an agent that starts naming it', async () => {
    const harness = await project({
      'agents/beta.ts': delegating('beta', 'gamma'),
      'agents/gamma.ts': agentFile('gamma', 'Dig.'),
    });
    expect((await harness.push({})).saved).toBe(true);
    await tempFile(harness.root, 'agents/alpha.ts', delegating('alpha', 'beta'));
    await tempFile(harness.root, 'agents/beta.ts', agentFile('beta', 'Research.'));

    const pushed = await harness.push({});

    expect(pushed.problems.map(formatProblem)).toEqual([]);
    expect(pushed.saved).toBe(true);
    expect(harness.server.agents.map((held) => held.agent.name)).toEqual([
      'gamma',
      'beta',
      'alpha',
    ]);
  });

  it('refuses a subagent cycle locally, before any request', async () => {
    const harness = await project({
      'agents/alpha.ts': delegating('alpha', 'beta'),
      'agents/beta.ts': delegating('beta', 'alpha'),
    });

    const pushed = await harness.push({});

    expect(pushed.problems.map(formatProblem)).toEqual([
      'agents/alpha.ts: local subagent_cycle [alpha → beta → alpha]',
    ]);
    expect(pushed.saved).toBe(false);
    expect(harness.server.calls).toEqual([]);
  });

  it('leaves a subagent the project does not define to the server', async () => {
    const harness = await project({ 'agents/alpha.ts': delegating('alpha', 'ghost') });

    const pushed = await harness.push({});

    expect(pushed.problems.map(formatProblem)).toEqual([
      'agents/alpha.ts: 422 agent_subagent_unusable [subagent:ghost]',
    ]);
    expect(harness.server.agents).toEqual([]);
  });
});
