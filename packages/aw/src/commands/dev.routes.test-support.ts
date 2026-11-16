import { CreateAgentFromVersionRequestSchema } from '@indx-workspace/contracts/agent-versions';

import { FIXTURES, json, tempFile, type Route } from '../testing.js';
import {
  WORKSPACE_ID,
  DEFINE,
  READY,
  CREDENTIAL,
  sends,
  fakeRuntime,
  renderedYaml,
  project,
} from './dev.test-support.js';

/** A control plane with the given model connections that accepts a create. */
export function modelConnections(existing: readonly string[]): Route {
  return (request) => {
    // Issue #661: every connection's key checks out.
    if (request.url.pathname === '/api/models') return json(200, { models: [] });
    if (request.url.pathname !== '/api/model-connections') {
      return json(404, { error: { code: 'not_found', message: 'no route' } });
    }
    if (request.method === 'POST') {
      return json(201, { ...FIXTURES.modelConnection, name: 'default' });
    }
    return json(200, {
      models: existing.map((name) => ({ ...FIXTURES.modelConnection, name })),
    });
  };
}

/** A project the fake runtime runs, holding `agents/assistant.ts`. */
export async function projectWithAgent(ready: unknown = READY): Promise<string> {
  const cwd = await project({ script: fakeRuntime(sends(ready, CREDENTIAL)) });
  await tempFile(
    cwd,
    'agents/assistant.ts',
    `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });\n`,
  );
  return cwd;
}

/** {@link projectWithAgent} with its own project file. */
export async function projectWithAgentAnd(yaml: string): Promise<string> {
  const cwd = await project({ yaml, script: fakeRuntime(sends(READY, CREDENTIAL)) });
  await tempFile(
    cwd,
    'agents/assistant.ts',
    `${DEFINE}export default defineAgent({ name: 'assistant', instructions: 'Help people.' });\n`,
  );
  return cwd;
}

/** A workspace with no agents and a `default` model connection, that accepts a new agent. */
export const agentsRoute: Route = (request) => {
  if (request.url.pathname === '/api/model-connections') {
    return json(200, { models: [{ ...FIXTURES.modelConnection, name: 'default' }] });
  }
  if (request.url.pathname !== '/api/agents') {
    return json(404, { error: { code: 'not_found', message: 'no route' } });
  }
  if (request.method === 'GET') return json(200, { agents: [] });
  const body = CreateAgentFromVersionRequestSchema.parse(request.json);
  if (body.dryRun === true) return json(200, { ok: true, number: 1 });
  return json(201, {
    agent: { ...FIXTURES.agent, modelConnectionId: null, name: 'assistant' },
    version: {
      id: 'v-1',
      agentId: FIXTURES.agent.id,
      workspaceId: WORKSPACE_ID,
      number: 1,
      summary: body.version.summary,
      via: body.version.via,
      body: body.version.body,
      createdByPrincipalId: FIXTURES.agent.id,
      createdAt: '2026-10-02T10:00:00.000Z',
    },
  });
};

/**
 * A local workspace holding `models` and `connectors`, that accepts every create and rotation the
 * project's resources need and answers `/api/agents` as {@link agentsRoute} does.
 */
export function workspaceRoute(
  existing: { readonly models?: readonly unknown[]; readonly connectors?: readonly unknown[] } = {},
): Route {
  return (request) => {
    const { pathname } = request.url;
    const route = `${request.method} ${pathname}`;
    if (route === 'GET /api/model-connections') return json(200, { models: existing.models ?? [] });
    if (route === 'POST /api/model-connections') {
      return json(201, { ...FIXTURES.modelConnection, name: 'default' });
    }
    if (request.method === 'POST' && pathname.endsWith('/credential')) {
      return new Response(null, { status: 204 });
    }
    if (route === 'GET /api/connectors') {
      return json(200, { connectors: existing.connectors ?? [] });
    }
    if (route === 'POST /api/connectors') return json(201, FIXTURES.connector);
    return agentsRoute(request);
  };
}

/** `renderedYaml()` with `extra` added at the root. */
export function yamlWith(extra: string): string {
  return `${renderedYaml()}${extra}`;
}

export const DEFAULT_MODEL_YAML = [
  'models:',
  '  default:',
  '    provider: anthropic',
  '    credential:',
  '      secret: ANTHROPIC_API_KEY',
  '',
].join('\n');

export const GITHUB_YAML = [
  'connectors:',
  '  github:',
  '    url: https://mcp.example.com',
  '    auth:',
  '      scheme: bearer',
  '      credential:',
  '        secret: ORDERS_TOKEN',
  '',
].join('\n');
