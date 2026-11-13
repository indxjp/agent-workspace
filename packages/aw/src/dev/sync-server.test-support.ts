import { createHash } from 'node:crypto';
import {
  AgentVersionResourceSchema,
  CreateAgentFromVersionRequestSchema,
  CreateAgentVersionRequestSchema,
  SetAgentPointerRequestSchema,
  type AgentVersionResource,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentResource } from '@indx-workspace/contracts/agents';
import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import { SKILL_IMPORT_MULTIPART, type SkillFile } from '@indx-workspace/contracts/skills';
import { fixtures } from '@indx-workspace/sdk/testing';
import { FIXTURES, IDS, json } from '../testing.js';

const AT = '2026-10-02T10:00:00.000Z';

export interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly json: unknown;
}

/** One agent the double holds: the row, its versions, its `local` pointer and its source. */
export interface StoredAgent {
  agent: AgentResource;
  readonly versions: AgentVersionResource[];
  local: { number: number; updatedAt: string } | null;
  /** The version the row was last written from; `null` after an edit outside versions. */
  materialised: number | null;
}

export interface ServerState {
  readonly agents: StoredAgent[];
  /** The workspace's connectors: the catalog tools a sync creates, and any seeded. */
  readonly connectors: ConnectorResource[];
  /** The workspace's skills by name, each with its files. */
  readonly skills: Map<string, SkillFile[]>;
  /** The file folders that hold a file: a grant on any other is refused as missing (#899). */
  readonly folders: Set<string>;
  /** The server's clock: every call answers a later time. */
  readonly now: () => string;
}

export function clock(): () => string {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.parse(AT) + tick * 1000).toISOString();
  };
}

/** The first agent keeps the shared fixture id; the ones after it get their own. */
function agentId(index: number): string {
  return index === 0 ? IDS.agent : `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`;
}

export function isDryRun(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'dryRun' in body && body.dryRun === true;
}

function versionOf(
  stored: { readonly id: string; readonly versions: readonly AgentVersionResource[] },
  draft: { readonly body: unknown; readonly summary: string; readonly via: string },
): AgentVersionResource {
  const number = stored.versions.length + 1;
  return AgentVersionResourceSchema.parse({
    id: `v-${stored.id}-${String(number)}`,
    agentId: stored.id,
    workspaceId: IDS.workspace,
    number,
    summary: draft.summary,
    via: draft.via,
    body: draft.body,
    createdByPrincipalId: IDS.principal,
    createdAt: AT,
  });
}

/**
 * The agents, each with its versions and `local` pointer, behind the routes `aw push` uses.
 * Setting a pointer writes the row and the pointer with one time, as the server's transaction
 * does; saving a version moves neither.
 */
/**
 * The server's dry run and save answer 422 for a version naming a skill the workspace does not
 * have (`agent_definition_references_missing`), so `skills/` must be uploaded before any dry run.
 */
function missingSkills(state: ServerState, version: { body: unknown }): Response | null {
  const body = version.body as {
    definition: { resources: { skills: string[]; files: { path: string }[] } };
  };
  const { skills, files } = body.definition.resources;
  const missing = [
    ...skills.filter((name) => !state.skills.has(name)).map((name) => `skill:${name}`),
    ...files.filter((file) => !state.folders.has(file.path)).map((file) => `file:${file.path}`),
  ];
  return missing.length === 0
    ? null
    : json(422, {
        error: {
          code: 'agent_definition_references_missing',
          message: 'The definition names resources this workspace does not have.',
          details: missing,
        },
      });
}

export function server(state: ServerState, request: Recorded): Response {
  const route = `${request.method} ${request.path}`;
  if (request.path.startsWith('/api/connectors')) return connectorsServer(state, request);
  if (request.path.startsWith('/api/skills')) return skillsServer(state, request);
  if (route === 'GET /api/agents') {
    return json(200, { agents: state.agents.map((stored) => stored.agent) });
  }
  if (route === 'POST /api/agents') return createAgent(state, request);
  const stored = state.agents.find(
    (candidate) =>
      request.path === `/api/agents/${candidate.agent.id}` ||
      request.path.startsWith(`/api/agents/${candidate.agent.id}/`),
  );
  if (stored === undefined) {
    return json(404, { error: { code: 'not_found', message: 'no route' } });
  }
  const agentPath = `/api/agents/${stored.agent.id}`;
  if (route === `POST ${agentPath}/versions`) return createVersion(state, stored, request);
  if (route === `GET ${agentPath}/versions`) {
    return json(200, {
      items: stored.versions,
      pointers: stored.local === null ? [] : [{ environment: 'local', ...stored.local }],
      materialised: stored.materialised,
    });
  }
  if (route === `PUT ${agentPath}/pointers`) {
    const body = SetAgentPointerRequestSchema.parse(request.json);
    const at = state.now();
    stored.agent = { ...stored.agent, updatedAt: at };
    stored.local = { number: body.version, updatedAt: at };
    stored.materialised = body.version;
    return json(200, {
      agent: stored.agent,
      pointer: { environment: 'local', number: body.version, updatedAt: at },
    });
  }
  // The reads of `agents.export`, which only `aw push --yes` makes for an agent with no version;
  // the refused save in `aw dev` must never send them.
  if (route === `GET ${agentPath}`) return json(200, stored.agent);
  if (route === `GET ${agentPath}/policy`) return json(200, { policy: FIXTURES.policy });
  if (route === `GET ${agentPath}/resources`) {
    return json(200, { assignments: { files: [], skillIds: [], connectorIds: [] } });
  }
  return json(404, { error: { code: 'not_found', message: 'no route' } });
}

/** The resource the server keeps for a tool body: its document only as a digest. */
function toolResource(id: string, body: Record<string, unknown>): ConnectorResource {
  const document = String(body['document']);
  return fixtures.openApiConnector({
    id,
    name: String(body['name']),
    openapi: {
      spec: {
        digest: `sha256:${createHash('sha256').update(document, 'utf8').digest('hex')}`,
        bytes: Buffer.byteLength(document, 'utf8'),
      },
      baseUrl: 'https://api.example.com',
      auth: 'bearer',
      allow: body['allow'] as string[],
      operations: [{ name: 'getOrder', method: 'GET', path: '/orders/{id}' }],
    },
  });
}

/** A multipart skill import read the way `POST /api/skills` reads it: the name, then one part per file. */
export async function multipartImport(
  form: FormData,
): Promise<{ name: string; files: SkillFile[] }> {
  const name = form.get(SKILL_IMPORT_MULTIPART.nameField);
  const files: SkillFile[] = [];
  for (const part of form.getAll(SKILL_IMPORT_MULTIPART.fileField)) {
    if (typeof part === 'string') continue;
    const bytes = Buffer.from(await part.arrayBuffer());
    files.push({ path: part.name, contentBase64: bytes.toString('base64') });
  }
  return { name: typeof name === 'string' ? name : '', files };
}

/** The skills routes `aw dev` uses for `skills/`: list, import, export and patch. */
function skillsServer(state: ServerState, request: Recorded): Response {
  const detail = (name: string) => ({ ...FIXTURES.skill, name });
  const body = (request.json ?? {}) as {
    name?: string;
    files?: SkillFile[];
    removeFiles?: string[];
  };
  if (request.path === '/api/skills' && request.method === 'GET') {
    return json(200, { skills: [...state.skills.keys()].map(detail) });
  }
  if (request.path === '/api/skills') {
    state.skills.set(body.name ?? '', body.files ?? []);
    return json(201, { skill: detail(body.name ?? '') });
  }
  const name = request.path.split('/').pop() ?? '';
  const files = state.skills.get(name) ?? [];
  if (request.method === 'GET') return json(200, { skill: { name, files } });
  const kept = files.filter(
    (file) =>
      !(body.removeFiles ?? []).includes(file.path) &&
      !(body.files ?? []).some((f) => f.path === file.path),
  );
  state.skills.set(name, [...kept, ...(body.files ?? [])]);
  return json(200, { skill: detail(name) });
}

/** `GET`/`POST /api/connectors` and `PATCH /api/connectors/:id`, for tool bodies. */
function connectorsServer(state: ServerState, request: Recorded): Response {
  const body = (request.json ?? {}) as Record<string, unknown>;
  if (request.method === 'GET') return json(200, { connectors: state.connectors });
  if (request.method === 'POST') {
    const id = `99999999-9999-4999-8999-${String(state.connectors.length).padStart(12, '0')}`;
    const created =
      body['transport'] === 'http'
        ? fixtures.connector({
            id,
            name: String(body['name']),
            url: String(body['url']),
            authType: 'none',
          })
        : toolResource(id, body);
    state.connectors.push(created);
    return json(201, created);
  }
  const index = state.connectors.findIndex((c) => request.path === `/api/connectors/${c.id}`);
  if (request.method !== 'PATCH' || index < 0) {
    return json(404, { error: { code: 'connector_not_found', message: 'no connector' } });
  }
  const current = state.connectors[index];
  const updated =
    current?.transport != null
      ? { ...current, ...body }
      : toolResource(state.connectors[index]?.id ?? '', body);
  state.connectors[index] = updated;
  return json(200, updated);
}

/** An agent made in the UI before `aw dev` started: no version and no `local` pointer. */
export function seedUiAgent(state: ServerState, name: string): void {
  state.agents.push({
    agent: {
      ...FIXTURES.agent,
      id: agentId(state.agents.length),
      modelConnectionId: null,
      name,
      updatedAt: state.now(),
    },
    versions: [],
    local: null,
    materialised: null,
  });
}

function createAgent(state: ServerState, request: Recorded): Response {
  const body = CreateAgentFromVersionRequestSchema.parse(request.json);
  const refused = missingSkills(state, body.version);
  if (refused !== null) return refused;
  if (body.dryRun === true) return json(200, { ok: true, number: 1 });
  const id = agentId(state.agents.length);
  const at = state.now();
  const agent = {
    ...FIXTURES.agent,
    id,
    modelConnectionId: null,
    name: body.version.body.definition.agent.name,
    updatedAt: at,
  };
  const version = versionOf({ id, versions: [] }, body.version);
  state.agents.push({
    agent,
    versions: [version],
    local: { number: version.number, updatedAt: at },
    materialised: version.number,
  });
  return json(201, { agent, version });
}

function createVersion(state: ServerState, stored: StoredAgent, request: Recorded): Response {
  const body = CreateAgentVersionRequestSchema.parse(request.json);
  const refused = missingSkills(state, body);
  if (refused !== null) return refused;
  if (body.dryRun === true) return json(200, { ok: true, number: stored.versions.length + 1 });
  const version = versionOf({ id: stored.agent.id, versions: stored.versions }, body);
  stored.versions.push(version);
  return json(201, version);
}
