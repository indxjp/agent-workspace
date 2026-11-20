import { rm } from 'node:fs/promises';
import path from 'node:path';

import {
  AgentVersionBodySchema,
  AgentVersionResourceSchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
  type AgentVersionBody,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import { defineAgent, files, mcp, toAgentVersionBody } from '@indx-workspace/sdk/define';
import { fixtures } from '@indx-workspace/sdk/testing';
import { afterAll, expect } from 'vitest';

import { FIXTURES, IDS, json, runCli, tempDirectory, tempFile, type Route } from '../testing.js';

type RecordedRequest = Parameters<Route>[0];

const AT = '2026-10-25T10:00:00.000Z';
export const PROJECT_SOURCE =
  'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: exported\n' +
  'connectors:\n  wiki:\n    url: https://wiki.example.test/mcp\n' +
  'environments:\n  local:\n    cloud: local\n    identity:\n      bootstrapAdmin: admin@localhost.test\n';

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

export async function project(tree: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await tempDirectory();
  directories.push(root);
  for (const [file, contents] of Object.entries(tree)) await tempFile(root, file, contents);
  return root;
}

/** What the control plane double holds: one agent, its versions and its `local` pointer. */
interface ServerState {
  versions: AgentVersionResource[];
  local: number | null;
}

export const emptyServer = (): ServerState => ({ versions: [], local: null });

function problem(status: number, code: string): Response {
  return json(status, { error: { code, message: `refused: ${code}`, details: [] } });
}

export function versionOf(
  state: ServerState,
  draft: { readonly body: unknown; readonly summary: string; readonly via: string },
): AgentVersionResource {
  const number = state.versions.length + 1;
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

function listAgents(state: ServerState): Response {
  return json(200, {
    agents:
      state.versions.length === 0
        ? []
        : [{ ...FIXTURES.agent, modelConnectionId: null, name: 'summariser' }],
  });
}

function createConnector(request: RecordedRequest): Response {
  const body = request.json as { name: string; url: string };
  return json(
    201,
    fixtures.connector({ id: IDS.connection, name: body.name, url: body.url, authType: 'none' }),
  );
}

function createAgent(state: ServerState, request: RecordedRequest, dryRun: boolean): Response {
  const body = CreateAgentFromVersionRequestSchema.parse(request.json);
  if (dryRun) return json(200, { ok: true, number: 1 });
  const version = versionOf(state, body.version);
  state.versions.push(version);
  state.local = version.number;
  return json(201, { agent: FIXTURES.agent, version });
}

function createVersion(state: ServerState, request: RecordedRequest, dryRun: boolean): Response {
  const body = CreateAgentVersionRequestSchema.parse(request.json);
  if (dryRun) return json(200, { ok: true, number: state.versions.length + 1 });
  const version = versionOf(state, body);
  state.versions.push(version);
  return json(201, version);
}

function listVersions(state: ServerState): Response {
  return json(200, {
    items: state.versions,
    pointers:
      state.local === null ? [] : [{ environment: 'local', number: state.local, updatedAt: AT }],
    materialised: state.local,
  });
}

function setPointer(state: ServerState, request: RecordedRequest): Response {
  const body = SetAgentPointerRequestSchema.parse(request.json);
  state.local = body.version;
  return json(200, {
    agent: FIXTURES.agent,
    pointer: { environment: 'local', number: body.version, updatedAt: AT },
  });
}

/** `/api/agents` lists and creates from a version; `/api/agents/:id/{versions,pointers}` as `aw push` uses them. */
export function server(state: ServerState): Route {
  const agentPath = `/api/agents/${IDS.agent}`;
  return (request: RecordedRequest) => {
    const route = `${request.method} ${request.url.pathname}`;
    const dryRun = (request.json as { dryRun?: boolean } | undefined)?.dryRun === true;
    if (route === 'GET /api/agents') return listAgents(state);
    if (route === 'GET /api/connectors') return json(200, { connectors: [] });
    if (route === 'POST /api/connectors') return createConnector(request);
    if (route === 'POST /api/agents') return createAgent(state, request, dryRun);
    if (route === `POST ${agentPath}/versions`) return createVersion(state, request, dryRun);
    if (route === `GET ${agentPath}/versions`) return listVersions(state);
    if (route === `PUT ${agentPath}/pointers`) return setPointer(state, request);
    return problem(404, 'not_found');
  };
}

/** An agent created the way a chat or the console creates one: instructions that need escaping. */
export const ORIGINAL: AgentVersionBody = AgentVersionBodySchema.parse(
  toAgentVersionBody(
    defineAgent({
      name: 'summariser',
      description: 'Summarises the wiki.',
      instructions: 'Say "hi" and it\'s `fine`: ${not interpolated}\nSecond line.',
      model: { connection: 'default', id: 'claude-x' },
      engine: { id: 'claude-agent-sdk', handoff: true },
      limits: { maxTurns: 12 },
      tools: [mcp('wiki')],
      files: [files('reports/', 'read-write'), files('inbox/', 'read')],
    }),
  ),
);

/** Creates `body` through the API double, as `aw push` would, and answers the server that holds it. */
export async function created(body: AgentVersionBody = ORIGINAL): Promise<ServerState> {
  const state = emptyServer();
  const response = await server(state)({
    url: new URL('https://aw.example.com/api/agents'),
    method: 'POST',
    headers: new Headers(),
    json: { version: { body, summary: 'created', via: 'api' } },
    body: null,
    signal: null,
  });
  expect(response.status).toBe(201);
  return state;
}

export const bodyWith = (instructions: string, name = 'summariser'): AgentVersionBody =>
  AgentVersionBodySchema.parse(toAgentVersionBody(defineAgent({ name, instructions })));

/** A server holding `instructions` as versions 1, 2, …, with `local` on `local` (none: no pointer). */
export function versioned(instructions: readonly string[], local: number | null): ServerState {
  const state = emptyServer();
  for (const text of instructions) {
    state.versions.push(versionOf(state, { body: bodyWith(text), summary: 's', via: 'api' }));
  }
  state.local = local;
  return state;
}

export const exportTs = (out: string, state: ServerState, ...flags: string[]) =>
  runCli(['agents', 'export', IDS.agent, '--format', 'ts', '--out', out, ...flags], {
    route: server(state),
  });

export const markdown = (out: string) => path.join(out, 'agents', 'summariser.md');
