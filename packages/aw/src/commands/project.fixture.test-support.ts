import {
  AgentVersionResourceSchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
  UploadToolBundleRequestSchema,
  type AgentVersionBody,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentResource } from '@indx-workspace/contracts/agents';
import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import { fixtures } from '@indx-workspace/sdk/testing';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterAll, vi } from 'vitest';
import {
  FIXTURES,
  IDS,
  json,
  runCli,
  tempDirectory,
  tempFile,
  type CliRun,
  type Route,
} from '../testing.js';

vi.setConfig({ testTimeout: 30_000 });

export type RecordedRequest = Parameters<Route>[0];

const AT = '2026-10-02T10:00:00.000Z';

export const DEFINE = `import { defineAgent, defineSurface, mcp } from '@indx-workspace/sdk/define';\n`;

export function agentFile(extra = '', name = 'assistant'): string {
  return `${DEFINE}
export default defineAgent({ name: '${name}', instructions: 'Help people.'${extra} });
`;
}

export function surfaceFile(name: string, agent = 'assistant'): string {
  return `${DEFINE}
export default defineSurface({ name: '${name}', agent: '${agent}', title: 'Ask us' });
`;
}

export const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  return root;
}

interface ServerState {
  agent: AgentResource | null;
  versions: AgentVersionResource[];
  local: number | null;
  /** The version the agent row was last written from; `null` after an edit outside versions. */
  materialised: number | null;
  /** The digests of the tool bundles uploaded so far (issue #790). */
  bundles: Set<string>;
  /** The workspace's connectors: the tool host's, which a push with code tools makes. */
  connectors: ConnectorResource[];
}

export function emptyServer(): ServerState {
  return {
    agent: null,
    versions: [],
    local: null,
    materialised: null,
    bundles: new Set(),
    connectors: [],
  };
}

function unknownBundles(state: ServerState, body: AgentVersionBody): Response | null {
  const missing = (body.toolBundles ?? [])
    .map(({ digest }) => digest)
    .filter((digest) => !state.bundles.has(digest));
  return missing.length === 0
    ? null
    : problem(
        422,
        'tool_bundle_unknown',
        missing.map((digest) => `tool_bundle:${digest}`),
      );
}

export function isDryRun(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'dryRun' in body && body.dryRun === true;
}

export function problem(status: number, code: string, details: readonly string[] = []): Response {
  return json(status, { error: { code, message: `refused: ${code}`, details } });
}

export function versionOf(
  state: ServerState,
  draft: { readonly body: unknown; readonly summary: string; readonly via: string },
): AgentVersionResource {
  const number = state.versions.length + 1;
  // The double stores what was sent; the SDK parses it back with the contract on every read.
  return AgentVersionResourceSchema.parse({
    id: `v-${String(number)}`,
    agentId: IDS.agent,
    workspaceId: IDS.workspace,
    number,
    summary: draft.summary,
    via: draft.via,
    body: draft.body,
    createdByPrincipalId: IDS.principal,
    createdAt: AT,
  });
}

function createAgent(state: ServerState, request: RecordedRequest): Response {
  const body = CreateAgentFromVersionRequestSchema.parse(request.json);
  const unknown = unknownBundles(state, body.version.body);
  if (unknown !== null) return unknown;
  if (body.dryRun === true) return json(200, { ok: true, number: 1 });
  const agent = {
    ...FIXTURES.agent,
    modelConnectionId: null,
    name: body.version.body.definition.agent.name,
  };
  const version = versionOf(state, body.version);
  state.agent = agent;
  state.versions.push(version);
  state.local = version.number;
  state.materialised = version.number;
  return json(201, { agent, version });
}

function createVersion(state: ServerState, request: RecordedRequest): Response {
  const body = CreateAgentVersionRequestSchema.parse(request.json);
  const unknown = unknownBundles(state, body.body);
  if (unknown !== null) return unknown;
  if (body.dryRun === true) {
    return json(200, { ok: true, number: state.versions.length + 1 });
  }
  const version = versionOf(state, body);
  state.versions.push(version);
  return json(201, version);
}

function movePointer(state: ServerState, request: RecordedRequest): Response {
  const body = SetAgentPointerRequestSchema.parse(request.json);
  state.local = body.version;
  state.materialised = body.version;
  return json(200, {
    agent: state.agent,
    pointer: { environment: 'local', number: body.version, updatedAt: AT },
  });
}

export function server(state: ServerState): Route {
  const agentPath = `/api/agents/${IDS.agent}`;
  return (request: RecordedRequest) => {
    const route = `${request.method} ${request.url.pathname}`;
    if (route === 'GET /api/agents') {
      return json(200, { agents: state.agent === null ? [] : [state.agent] });
    }
    if (route === 'GET /api/connectors') return json(200, { connectors: state.connectors });
    if (route === 'POST /api/connectors') {
      const body = request.json as { name: string; url: string };
      const created = fixtures.connector({
        id: IDS.connection,
        name: body.name,
        url: body.url,
        authType: 'none',
        hasCredential: false,
      });
      state.connectors.push(created);
      return json(201, created);
    }
    if (route === 'POST /api/tool-bundles') {
      const { contentBase64 } = UploadToolBundleRequestSchema.parse(request.json);
      const bytes = Buffer.from(contentBase64, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const created = !state.bundles.has(digest);
      state.bundles.add(digest);
      return json(created ? 201 : 200, { bundle: { digest, sizeBytes: bytes.length }, created });
    }
    if (request.method === 'GET' && request.url.pathname.startsWith('/api/tool-bundles/')) {
      const digest = request.url.pathname.slice('/api/tool-bundles/'.length);
      return state.bundles.has(digest)
        ? json(200, { bundle: { digest, sizeBytes: 1 } })
        : problem(404, 'tool_bundle_not_found');
    }
    if (route === 'POST /api/agents') return createAgent(state, request);
    if (route === `POST ${agentPath}/versions`) return createVersion(state, request);
    if (route === `GET ${agentPath}/versions`) {
      return json(200, {
        items: state.versions,
        pointers:
          state.local === null
            ? []
            : [{ environment: 'local', number: state.local, updatedAt: AT }],
        materialised: state.materialised,
      });
    }
    if (route === `PUT ${agentPath}/pointers`) return movePointer(state, request);
    if (route === `GET ${agentPath}`) return json(200, state.agent);
    if (route === `GET ${agentPath}/policy`) return json(200, { policy: FIXTURES.policy });
    if (route === `GET ${agentPath}/resources`) {
      return json(200, { assignments: { files: [], skillIds: [], connectorIds: [] } });
    }
    return problem(404, 'not_found');
  };
}

export const CODE_TOOL_PROJECT = {
  'agents/assistant.ts': `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order.ts';
export default defineAgent({ name: 'assistant', instructions: 'Help.', tools: [getOrder] });
`,
  'tools/get-order.ts': `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  run: './tools/get-order.run.ts',
});
`,
  'tools/get-order.run.ts': `import { shout } from './shout.ts';
export default ({ id }: { id: string }) => shout(id);
`,
  'tools/shout.ts': 'export const shout = (text: string): string => text.toUpperCase();\n',
};

export function writes(run: CliRun): readonly string[] {
  return run.calls
    .filter((call) => call.method !== 'GET' && !(call.method === 'POST' && isDryRun(call.json)))
    .map((call) => `${call.method} ${call.url.pathname}`);
}

export function requests(run: CliRun): readonly string[] {
  return run.calls.map((call) => `${call.method} ${call.url.pathname}`);
}

export function aw(
  root: string,
  argv: readonly string[],
  route: Route = server(emptyServer()),
  extra: { readonly env?: Readonly<Record<string, string>>; readonly homeDir?: string } = {},
) {
  return runCli(argv, { cwd: root, route, ...extra });
}

export function sentInstructions(run: CliRun): string {
  return CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json).version.body.definition.agent
    .instructions;
}

export function projectYaml(extra = ''): string {
  return `apiVersion: agentworkspace.dev/v2
kind: Project
name: demo
environments:
  local:
    cloud: local
    identity:
      bootstrapAdmin: admin@localhost.test
${extra}`;
}

export function sentEngine(run: CliRun): string {
  return CreateAgentFromVersionRequestSchema.parse(run.calls[1]?.json).version.body.definition
    .policy.engine;
}

export function missingReferences(details: readonly string[]): Response {
  return json(422, {
    error: {
      code: 'agent_definition_references_missing',
      message: 'The definition names resources this workspace does not have.',
      details,
    },
  });
}

export const SKILL_AGENT = (name: string): string =>
  agentFile(`, skills: [skill('${name}')]`).replace('mcp }', 'mcp, skill }');
