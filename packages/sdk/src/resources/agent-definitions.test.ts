import { describe, expect, it } from 'vitest';

import {
  AGENT_DEFINITION_API_VERSION,
  type AgentDefinition,
  type AgentPolicy,
} from '@indx-workspace/contracts/agents';

import { ApiProblemError, ContractViolationError, TransportError } from '../errors.js';
import { HttpClient } from '../http.js';
import { fetchDouble, jsonResponse as json, type RecordedRequest } from '../testing.js';
import { AgentsClient } from './agents.js';

/**
 * A two-workspace control plane in the recording double: each API key is bound to one workspace,
 * every resource has workspace-local ids, and the routes answer exactly the shapes the contracts
 * pin. Names are shared between the two workspaces; ids never are.
 */
const STAMP = '2026-09-29T10:00:00.000Z';
const CAPABILITIES = {
  mcp: true,
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
};

interface Named {
  readonly id: string;
  readonly name: string;
}
interface FileRow {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'folder';
}
interface AgentRow {
  readonly body: Record<string, unknown>;
  assignments: {
    files: { fileId: string; access: string }[];
    skillIds: string[];
    connectorIds: string[];
  };
  /** `null` until a `PUT`: the route then answers the policy compiled from the agent. */
  policy: AgentPolicy | null;
}

interface Workspace {
  readonly id: string;
  readonly skills: Named[];
  readonly connectors: Named[];
  readonly modelConnections: Named[];
  readonly runtimeProfiles: Named[];
  readonly files: FileRow[];
  readonly agents: Map<string, AgentRow>;
  engineInstalled: boolean;
  refusePolicy: boolean;
  /** `DELETE /api/agents/:id` answers 503 instead of removing the agent. */
  refuseDelete: boolean;
  /** The policy route omits `source`, as a server older than #239 does. */
  legacyPolicySource: boolean;
  /** Called once `POST /api/agents` has created an agent. */
  afterCreate: () => void;
}

function workspace(prefix: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: `${prefix}-ws`,
    skills: [{ id: `${prefix}-skill-triage`, name: 'triage' }],
    connectors: [{ id: `${prefix}-conn-crm`, name: 'crm' }],
    modelConnections: [{ id: `${prefix}-mc`, name: 'anthropic-prod' }],
    runtimeProfiles: [{ id: `${prefix}-rp`, name: 'small' }],
    files: [
      { id: `${prefix}-f-docs`, path: 'docs', kind: 'folder' },
      { id: `${prefix}-f-play`, path: 'docs/playbook.md', kind: 'file' },
    ],
    agents: new Map(),
    engineInstalled: true,
    refusePolicy: false,
    refuseDelete: false,
    legacyPolicySource: false,
    afterCreate: () => undefined,
    ...overrides,
  };
}

const basePolicy: Extract<AgentPolicy, { engine: 'claude-agent-sdk' }> = {
  engine: 'claude-agent-sdk',
  tools: {
    base: 'claude_code_preset',
    autoApprove: ['mcp__crm__*'],
    deny: ['Bash'],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  skills: { mode: 'allowlist', names: ['triage'] },
  limits: { maxTurns: 20, maxBudgetUsd: 5 },
};

function seedAgent(ws: Workspace, id: string): void {
  ws.agents.set(id, {
    body: {
      id,
      workspaceId: ws.id,
      name: 'Support triage',
      instructions: 'Answer support mail.',
      modelConnectionId: ws.modelConnections[0]?.id ?? null,
      model: 'claude-sonnet-4-5',
      runtimeProfileId: ws.runtimeProfiles[0]?.id ?? null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
      createdBy: null,
      ownerPrincipalId: 'principal-1',
      createdAt: STAMP,
      updatedAt: STAMP,
    },
    assignments: {
      files: [{ fileId: `${ws.id.split('-')[0] ?? ''}-f-play`, access: 'read' }],
      skillIds: ws.skills.map((row) => row.id),
      connectorIds: ws.connectors.map((row) => row.id),
    },
    policy: basePolicy,
  });
}

const skillBody = (row: Named): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  enabled: true,
  description: null,
  fileCount: 1,
  createdAt: STAMP,
  updatedAt: STAMP,
  source: '# secret-free skill body',
  instructions: null,
  allowedTools: null,
  files: [{ path: 'SKILL.md', sizeBytes: 24 }],
});
const connectorBody = (ws: Workspace, row: Named): Record<string, unknown> => ({
  id: row.id,
  workspaceId: ws.id,
  name: row.name,
  transport: 'http',
  command: null,
  args: null,
  url: 'https://crm.example.com/mcp',
  authType: 'bearer',
  hasCredential: true,
  enabled: true,
  createdBy: null,
  ownerPrincipalId: 'principal-1',
  createdAt: STAMP,
  updatedAt: STAMP,
});
const modelConnectionBody = (row: Named): Record<string, unknown> => ({
  id: row.id,
  name: row.name,
  provider: 'anthropic',
  config: {},
  hasCredential: true,
  ready: true,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const runtimeProfileBody = (ws: Workspace, row: Named): Record<string, unknown> => ({
  id: row.id,
  workspaceId: ws.id,
  name: row.name,
  driver: 'local',
  runtimeConnectionId: null,
  cpu: null,
  memoryMb: null,
  diskMb: null,
  networkPolicy: 'none',
  allowedDomains: null,
  filesystem: 'read-only',
  persistPaths: null,
  timeoutSeconds: null,
  idleTimeoutSeconds: null,
  driverConfig: null,
  createdAt: STAMP,
  updatedAt: STAMP,
});
const fileBody = (row: FileRow): Record<string, unknown> => ({
  id: row.id,
  path: row.path,
  kind: row.kind,
  sizeBytes: row.kind === 'file' ? 10 : null,
  contentType: null,
  lastModified: row.kind === 'file' ? STAMP : null,
});

const notFound = (code: string): Response => json(404, { error: { code, message: 'Not found.' } });

function serve(ws: Workspace, request: RecordedRequest): Response {
  const path = request.url.pathname;
  const route = `${request.method} ${path}`;
  const agentMatch = /^\/api\/agents\/([^/]+)(\/resources|\/policy)?$/u.exec(path);
  if (agentMatch !== null) {
    const agent = ws.agents.get(decodeURIComponent(agentMatch[1] ?? ''));
    if (agent === undefined) return notFound('agent_not_found');
    if (agentMatch[2] === '/resources') return json(200, { assignments: agent.assignments });
    if (agentMatch[2] === '/policy' && request.method === 'GET') {
      // The compiled policy: the permission floor and every assigned skill, by name.
      const policy = agent.policy ?? {
        ...basePolicy,
        tools: { ...basePolicy.tools, autoApprove: [], deny: ['Write', 'Edit', 'Bash'] },
        skills: {
          mode: 'allowlist',
          names: ws.skills
            .filter((row) => agent.assignments.skillIds.includes(row.id))
            .map((row) => row.name),
        },
        limits: { maxTurns: null, maxBudgetUsd: null },
      };
      const source = agent.policy === null ? 'compiled' : 'stored';
      return json(200, ws.legacyPolicySource ? { policy } : { policy, source });
    }
    if (agentMatch[2] === '/policy' && request.method === 'PUT') {
      if (ws.refusePolicy) {
        return json(422, {
          error: { code: 'engine_capability_unsupported', message: 'No.', details: ['mcp'] },
        });
      }
      agent.policy = request.json as AgentPolicy;
      return json(200, { policy: agent.policy, source: 'stored' });
    }
    if (request.method === 'DELETE') {
      if (ws.refuseDelete) {
        return json(503, { error: { code: 'service_unavailable', message: 'Try later.' } });
      }
      ws.agents.delete(decodeURIComponent(agentMatch[1] ?? ''));
      return json(204, null);
    }
    return json(200, agent.body);
  }
  const byId = (rows: readonly Named[], prefix: string): Named | undefined =>
    rows.find((row) => path === `${prefix}/${row.id}`);
  switch (route) {
    case 'GET /api/engines':
      return json(200, {
        engines: [
          {
            id: 'claude-agent-sdk',
            displayName: 'Claude Agent SDK',
            version: '1',
            capabilities: CAPABILITIES,
            installed: ws.engineInstalled,
          },
          {
            id: 'openai-agents',
            displayName: 'OpenAI Agents SDK',
            version: '1',
            capabilities: {
              ...CAPABILITIES,
              skills: false,
              wireProtocols: ['openai-responses'],
            },
            installed: ws.engineInstalled,
          },
        ],
      });
    case 'GET /api/skills':
      return json(200, { skills: ws.skills.map(skillBody) });
    case 'GET /api/connectors':
      return json(200, { connectors: ws.connectors.map((row) => connectorBody(ws, row)) });
    case 'GET /api/model-connections':
      return json(200, { models: ws.modelConnections.map(modelConnectionBody) });
    case 'GET /api/runtime-profiles':
      return json(200, {
        runtimeProfiles: ws.runtimeProfiles.map((row) => runtimeProfileBody(ws, row)),
      });
    case 'GET /api/files': {
      const folder = request.url.searchParams.get('path') ?? '';
      const children = ws.files.filter((row) => {
        const slash = row.path.lastIndexOf('/');
        return (slash === -1 ? '' : row.path.slice(0, slash)) === folder;
      });
      if (folder !== '' && !ws.files.some((row) => row.path === folder)) {
        return notFound('file_not_found');
      }
      return json(200, { files: children.map(fileBody) });
    }
    case 'POST /api/agents': {
      const body = request.json as {
        agent: Record<string, unknown>;
        assignments: AgentRow['assignments'];
      };
      const id = `${ws.id}-agent-${String(ws.agents.size + 1)}`;
      const created = {
        ...body.agent,
        id,
        workspaceId: ws.id,
        createdBy: null,
        ownerPrincipalId: 'principal-2',
        createdAt: STAMP,
        updatedAt: STAMP,
      };
      ws.agents.set(id, { body: created, assignments: body.assignments, policy: null });
      ws.afterCreate();
      return json(201, { agent: created, assignments: body.assignments });
    }
    default: {
      const mc = byId(ws.modelConnections, '/api/model-connections');
      if (mc !== undefined) return json(200, modelConnectionBody(mc));
      const rp = byId(ws.runtimeProfiles, '/api/runtime-profiles');
      if (rp !== undefined) return json(200, runtimeProfileBody(ws, rp));
      return notFound('not_found');
    }
  }
}

function deployment(workspaces: Readonly<Record<string, Workspace>>): {
  readonly clientFor: (key: string) => AgentsClient;
  readonly calls: RecordedRequest[];
} {
  const api = fetchDouble((request) => {
    const key = (request.headers.get('authorization') ?? '').replace(/^Bearer /u, '');
    const ws = workspaces[key];
    // As `fetch` does: a request made under an aborted signal never reaches the server.
    if (request.init.signal?.aborted === true) {
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    }
    return ws === undefined
      ? json(401, { error: { code: 'unauthenticated', message: 'No.' } })
      : serve(ws, request);
  });
  return {
    clientFor: (key) =>
      new AgentsClient(
        new HttpClient({
          baseUrl: 'https://aw.example.com',
          auth: { kind: 'api-key', apiKey: key },
          fetch: api.fetch,
        }),
      ),
    calls: api.calls,
  };
}

const SOURCE_AGENT = 'a-ws-agent-src';

function setup(target: Workspace = workspace('b')): {
  readonly source: AgentsClient;
  readonly target: AgentsClient;
  readonly a: Workspace;
  readonly b: Workspace;
  readonly calls: RecordedRequest[];
} {
  const a = workspace('a');
  seedAgent(a, SOURCE_AGENT);
  const { clientFor, calls } = deployment({ ak_a: a, ak_b: target });
  return { source: clientFor('ak_a'), target: clientFor('ak_b'), a, b: target, calls };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('AgentsClient.export', () => {
  it('writes every reference by name and carries no id, credential or skill bytes', async () => {
    const { source, calls } = setup();
    const definition = await source.export(SOURCE_AGENT);
    expect(definition).toEqual({
      apiVersion: AGENT_DEFINITION_API_VERSION,
      kind: 'AgentDefinition',
      agent: {
        name: 'Support triage',
        instructions: 'Answer support mail.',
        permissions: {
          readFiles: true,
          writeFiles: false,
          runCommands: false,
          unrestrictedNetwork: false,
        },
        model: 'claude-sonnet-4-5',
        modelConnectionName: 'anthropic-prod',
        runtimeProfileName: 'small',
      },
      policy: basePolicy,
      policySource: 'stored',
      resources: {
        files: [{ path: 'docs/playbook.md', access: 'read' }],
        skills: ['triage'],
        connectors: ['crm'],
      },
    } satisfies AgentDefinition);
    const text = JSON.stringify(definition);
    expect(text).not.toMatch(/a-ws|a-skill|a-conn|a-mc|a-rp|a-f-|secret-free|hasCredential/u);
    // Only reads: an export never writes, and never asks for a skill's bytes.
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
    expect(calls.some((call) => call.url.pathname.endsWith('/export'))).toBe(false);
  });

  it('refuses, naming it, an assignment whose name cannot be read back', async () => {
    const { source, a } = setup();
    a.connectors.splice(0, a.connectors.length);
    const error = await failure(source.export(SOURCE_AGENT));
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).code).toBe('agent_definition_reference_unresolvable');
    expect((error as ApiProblemError).details).toEqual(['connector:a-conn-crm']);
  });

  it('records a compiled policy as compiled, and reads a server that does not say as stored', async () => {
    const { source, a } = setup();
    const row = a.agents.get(SOURCE_AGENT);
    if (row === undefined) throw new Error('seeded agent missing');
    row.policy = null;
    expect((await source.export(SOURCE_AGENT)).policySource).toBe('compiled');
    a.legacyPolicySource = true;
    expect((await source.export(SOURCE_AGENT)).policySource).toBe('stored');
  });

  it('carries only the allowlist entries the agent is still assigned', async () => {
    const { source, a } = setup();
    const row = a.agents.get(SOURCE_AGENT);
    if (row === undefined) throw new Error('seeded agent missing');
    row.assignments.skillIds = [];
    const definition = await source.export(SOURCE_AGENT);
    expect(definition.resources.skills).toEqual([]);
    expect(definition.policy.skills).toEqual({ mode: 'allowlist', names: [] });
  });

  it('lists folders level by level, several at once, and stops at the bound', async () => {
    const folders = Array.from({ length: 600 }, (_, i) => ({
      id: `a-f-dir-${String(i)}`,
      path: `dir-${String(i)}`,
      kind: 'folder' as const,
    }));
    const { source, a, calls } = setup();
    a.files.push(...folders);
    const row = a.agents.get(SOURCE_AGENT);
    if (row === undefined) throw new Error('seeded agent missing');
    row.assignments.files = [{ fileId: 'a-f-nowhere', access: 'read' }];
    const error = await failure(source.export(SOURCE_AGENT));
    expect((error as ApiProblemError).details).toEqual(['file:a-f-nowhere']);
    expect(calls.filter((call) => call.url.pathname === '/api/files')).toHaveLength(500);
  });

  it('surfaces a foreign agent exactly as the server conceals it', async () => {
    const { target } = setup();
    const error = await failure(target.export(SOURCE_AGENT));
    expect((error as ApiProblemError).code).toBe('agent_not_found');
  });
});

describe('AgentsClient.import', () => {
  it('round-trips into a second workspace: policy and assignments equal by name', async () => {
    const { source, target, b } = setup();
    const definition = await source.export(SOURCE_AGENT);
    const result = await target.import(JSON.parse(JSON.stringify(definition)) as unknown);

    expect(result.skipped).toEqual([]);
    expect(result.agent.workspaceId).toBe('b-ws');
    expect(result.agent.modelConnectionId).toBe('b-mc');
    expect(result.agent.runtimeProfileId).toBe('b-rp');
    expect(result.assignments).toEqual({
      files: [{ fileId: 'b-f-play', access: 'read' }],
      skillIds: ['b-skill-triage'],
      connectorIds: ['b-conn-crm'],
    });
    expect(result.policy).toEqual(definition.policy);
    // Exporting the imported agent gives back the same definition.
    const again = await target.export(result.agent.id);
    expect(again).toEqual(definition);
    expect(b.agents.size).toBe(1);
  });

  it('never copies skill bytes or credentials across the boundary', async () => {
    const { source, target, calls } = setup();
    const definition = await source.export(SOURCE_AGENT);
    const before = calls.length;
    await target.import(definition);
    const writes = calls.slice(before).filter((call) => call.method !== 'GET');
    expect(writes.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /api/agents',
      'PUT /api/agents/b-ws-agent-1/policy',
    ]);
    for (const write of writes) {
      expect(JSON.stringify(write.json)).not.toMatch(
        /credential|apiKey|token|contentBase64|secret/iu,
      );
    }
  });

  it('refuses a definition naming absent skills, listing every missing name, and writes nothing', async () => {
    const target = workspace('b', { skills: [], connectors: [], files: [] });
    const { source, target: client, b, calls } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition));
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).status).toBe(422);
    expect((error as ApiProblemError).code).toBe('agent_definition_references_missing');
    expect((error as ApiProblemError).details).toEqual([
      'skill:triage',
      'connector:crm',
      'file:docs/playbook.md',
    ]);
    expect(b.agents.size).toBe(0);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it("onMissing: 'skip' drops the missing names, from the allowlist too, and reports them", async () => {
    const target = workspace('b', { skills: [], modelConnections: [] });
    const { source, target: client } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const result = await client.import(definition, { onMissing: 'skip' });
    expect(result.skipped).toEqual(['skill:triage', 'model-connection:anthropic-prod']);
    expect(result.agent.modelConnectionId).toBeNull();
    expect(result.assignments.skillIds).toEqual([]);
    expect(result.policy.skills).toEqual({ mode: 'allowlist', names: [] });
  });

  it('refuses a name two destination resources share, even when skipping', async () => {
    const target = workspace('b', {
      connectors: [
        { id: 'b-conn-1', name: 'crm' },
        { id: 'b-conn-2', name: 'crm' },
      ],
    });
    const { source, target: client } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition, { onMissing: 'skip' }));
    expect((error as ApiProblemError).code).toBe('agent_definition_reference_ambiguous');
    expect((error as ApiProblemError).details).toEqual(['connector:crm']);
  });

  it('refuses an engine the destination does not install before anything is written', async () => {
    const target = workspace('b', { engineInstalled: false });
    const { source, target: client, calls } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition));
    expect((error as ApiProblemError).code).toBe('unsupported_engine');
    expect((error as ApiProblemError).status).toBe(400);
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('removes the new agent again when the policy is refused, and rethrows the refusal', async () => {
    const target = workspace('b', { refusePolicy: true });
    const { source, target: client, b } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition));
    expect((error as ApiProblemError).code).toBe('engine_capability_unsupported');
    expect(b.agents.size).toBe(0);
  });

  it('names the agent it could not remove, keeping the refusal as the error', async () => {
    const target = workspace('b', { refusePolicy: true, refuseDelete: true });
    const { source, target: client, b } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition));
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).status).toBe(422);
    expect((error as ApiProblemError).code).toBe('engine_capability_unsupported');
    expect((error as ApiProblemError).details).toEqual(['mcp', 'agent:b-ws-agent-1']);
    expect((error as ApiProblemError).cause).toBeInstanceOf(ApiProblemError);
    expect(b.agents.has('b-ws-agent-1')).toBe(true);
  });

  it('removes the agent when the import is aborted after it was created, and reports the abort', async () => {
    const controller = new AbortController();
    const target = workspace('b', { afterCreate: () => controller.abort() });
    const { source, target: client, b, calls } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition, { signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
    expect(b.agents.size).toBe(0);
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });

  it('names the agent when an aborted import cannot remove it either', async () => {
    const controller = new AbortController();
    const target = workspace('b', { afterCreate: () => controller.abort(), refuseDelete: true });
    const { source, target: client, b } = setup(target);
    const definition = await source.export(SOURCE_AGENT);
    const error = await failure(client.import(definition, { signal: controller.signal }));
    expect(error).toBeInstanceOf(ApiProblemError);
    expect((error as ApiProblemError).code).toBe('agent_definition_import_incomplete');
    expect((error as ApiProblemError).details).toEqual(['agent:b-ws-agent-1']);
    expect((error as ApiProblemError).cause).toBeInstanceOf(TransportError);
    expect(b.agents.size).toBe(1);
  });

  it('keeps a compiled policy compiled: no PUT, and the destination still derives it', async () => {
    const { source, target, a, b, calls } = setup();
    const row = a.agents.get(SOURCE_AGENT);
    if (row === undefined) throw new Error('seeded agent missing');
    row.policy = null;
    const definition = await source.export(SOURCE_AGENT);
    const before = calls.length;
    const result = await target.import(definition);
    expect(calls.slice(before).filter((call) => call.method === 'PUT')).toEqual([]);
    expect(b.agents.get(result.agent.id)?.policy).toBeNull();
    expect(result.policy).toEqual(definition.policy);
    expect(await target.export(result.agent.id)).toEqual(definition);
  });

  // ADR-0074: an `openai-agents` definition is stored through `PUT /api/agents/:id/policy`, so the
  // server's policy checks (unsupported_engine, engine capabilities, withheldPermissions) decide it.
  const OPENAI_POLICY: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
    reasoningEffort: 'low',
    withheldPermissions: ['writeFiles', 'runCommands'],
  };

  it('stores an openai-agents policy verbatim through the policy route, withheld switches included', async () => {
    const { source, target, b, calls } = setup();
    const exported = await source.export(SOURCE_AGENT);
    const definition = { ...exported, policy: OPENAI_POLICY };
    const before = calls.length;
    const result = await target.import(definition);
    const puts = calls.slice(before).filter((call) => call.method === 'PUT');
    expect(puts.map((call) => call.url.pathname)).toEqual([
      `/api/agents/${result.agent.id}/policy`,
    ]);
    expect(puts[0]?.json).toEqual(OPENAI_POLICY);
    expect(b.agents.get(result.agent.id)?.policy).toEqual(OPENAI_POLICY);
    expect(result.policy).toEqual(OPENAI_POLICY);
  });

  it('removes the agent when the server refuses the openai-agents policy a capability', async () => {
    const target = workspace('b', { refusePolicy: true });
    const { source, target: client, b } = setup(target);
    const exported = await source.export(SOURCE_AGENT);
    const error = await failure(client.import({ ...exported, policy: OPENAI_POLICY }));
    expect((error as ApiProblemError).code).toBe('engine_capability_unsupported');
    expect(b.agents.size).toBe(0);
  });

  it('refuses a compiled openai-agents policy the destination would compile for another engine', async () => {
    const { source, target, b } = setup();
    const exported = await source.export(SOURCE_AGENT);
    const definition = { ...exported, policy: OPENAI_POLICY, policySource: 'compiled' };
    const error = await failure(target.import(definition));
    expect((error as ApiProblemError).status).toBe(400);
    expect((error as ApiProblemError).code).toBe('invalid_agent_definition');
    expect((error as ApiProblemError).details).toEqual([
      "policySource: a compiled policy cannot name the engine 'openai-agents'",
    ]);
    expect(b.agents.size).toBe(0);
  });

  it('sends a hand-written allowlist unchanged under fail, and drops only skipped names under skip', async () => {
    const target = workspace('b', {
      skills: [
        { id: 'b-skill-triage', name: 'triage' },
        { id: 'b-skill-extra', name: 'extra' },
      ],
    });
    const { source, target: client, b } = setup(target);
    const exported = await source.export(SOURCE_AGENT);
    const handWritten = {
      ...exported,
      policy: {
        ...exported.policy,
        skills: { mode: 'allowlist', names: ['triage', 'absent', 'extra'] },
      },
      resources: { ...exported.resources, skills: ['triage', 'extra', 'absent'] },
    };
    const skipped = await client.import(handWritten, { onMissing: 'skip' });
    expect(skipped.skipped).toEqual(['skill:absent']);
    expect(b.agents.get(skipped.agent.id)?.policy?.skills).toEqual({
      mode: 'allowlist',
      names: ['triage', 'extra'],
    });
    const stray = {
      ...exported,
      policy: { ...exported.policy, skills: { mode: 'allowlist', names: ['triage', 'unlisted'] } },
    };
    const error = await failure(client.import(stray));
    expect((error as ApiProblemError).code).toBe('invalid_agent_definition');
    expect((error as ApiProblemError).details).toEqual([
      'policy.skills.names.1: the allowlist names the skill "unlisted", which resources.skills does not assign',
    ]);
  });

  it('refuses a malformed or credential-carrying file as invalid_agent_definition', async () => {
    const { source, target } = setup();
    const definition = await source.export(SOURCE_AGENT);
    const smuggled = { ...definition, agent: { ...definition.agent, apiKey: 'sk-live' } };
    const error = await failure(target.import(smuggled));
    expect((error as ApiProblemError).code).toBe('invalid_agent_definition');
    expect((error as ApiProblemError).details.join(' ')).toMatch(/apiKey/u);
    expect(((await failure(target.import({ apiVersion: 'v0' }))) as ApiProblemError).status).toBe(
      400,
    );
  });

  it('reports a contract violation from a composed read', async () => {
    const api = fetchDouble(() => json(200, { engines: [{ id: 'claude-agent-sdk' }] }));
    const agents = new AgentsClient(
      new HttpClient({
        baseUrl: 'https://aw.example.com',
        auth: { kind: 'api-key', apiKey: 'ak' },
        fetch: api.fetch,
      }),
    );
    const { source } = setup();
    const definition = await source.export(SOURCE_AGENT);
    expect(await failure(agents.import(definition))).toBeInstanceOf(ContractViolationError);
  });

  it('reports an aborted import as an aborted transport failure', async () => {
    const { source } = setup();
    const definition = await source.export(SOURCE_AGENT);
    const controller = new AbortController();
    controller.abort();
    const api = fetchDouble(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    const agents = new AgentsClient(
      new HttpClient({
        baseUrl: 'https://aw.example.com',
        auth: { kind: 'api-key', apiKey: 'ak' },
        fetch: api.fetch,
      }),
    );
    const error = await failure(agents.import(definition, { signal: controller.signal }));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).aborted).toBe(true);
  });
});
