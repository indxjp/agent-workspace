import { AgentDefinitionSchema, type AgentDefinition } from '@indx-workspace/contracts/agents';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, IDS, json, runCli, type Route } from '../testing.js';

type RecordedRequest = Parameters<Route>[0];

const agent = { ...FIXTURES.agent, modelConnectionId: null };
const policy = FIXTURES.policy;
const empty = { files: [], skillIds: [], connectorIds: [] };

const definition: AgentDefinition = AgentDefinitionSchema.parse({
  apiVersion: 'agentworkspace.dev/v1',
  kind: 'AgentDefinition',
  agent: {
    name: agent.name,
    instructions: agent.instructions,
    permissions: agent.permissions,
    model: agent.model,
    modelConnectionName: null,
    runtimeProfileName: null,
  },
  // The agent has no skill assigned, so export carries none of its allowlist either.
  policy: { ...policy, skills: { mode: 'allowlist', names: [] } },
  resources: { files: [], skills: [], connectors: [] },
});

function source(request: RecordedRequest): Response {
  const path = request.url.pathname;
  if (path === `/api/agents/${IDS.agent}`) return json(200, agent);
  if (path === `/api/agents/${IDS.agent}/policy`) return json(200, { policy });
  if (path === `/api/agents/${IDS.agent}/resources`) return json(200, { assignments: empty });
  return json(404, { error: { code: 'not_found', message: 'No.' } });
}

function destination(request: RecordedRequest): Response {
  const route = `${request.method} ${request.url.pathname}`;
  if (route === 'GET /api/engines') return json(200, { engines: [FIXTURES.engine] });
  if (route === 'GET /api/skills') return json(200, { skills: [] });
  if (route === 'POST /api/agents') return json(201, { agent, assignments: empty });
  if (route === `PUT /api/agents/${IDS.agent}/policy`) return json(200, { policy });
  return json(404, { error: { code: 'not_found', message: 'No.' } });
}

describe('aw agents export', () => {
  it('writes the definition as JSON even without --json, ready for a redirect to a file', async () => {
    const run = await runCli(['agents', 'export', IDS.agent], { route: source });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(AgentDefinitionSchema.parse(JSON.parse(run.stdout))).toEqual(definition);
    expect(run.stdout).not.toContain(IDS.agent);
  });
});

describe('aw agents import', () => {
  it('reads the file from stdin, creates the agent and stores its policy', async () => {
    const run = await runCli(['agents', 'import', '-', '--json'], {
      stdin: JSON.stringify(definition),
      route: destination,
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /api/engines',
      'POST /api/agents',
      `PUT /api/agents/${IDS.agent}/policy`,
    ]);
    expect((JSON.parse(run.stdout) as { agent: { id: string } }).agent.id).toBe(IDS.agent);
  });

  it('with --on-missing skip, names every skipped reference on stderr', async () => {
    const withSkill = {
      ...definition,
      resources: { ...definition.resources, skills: ['release-notes'] },
    };
    const run = await runCli(['agents', 'import', '-', '--on-missing', 'skip'], {
      stdin: JSON.stringify(withSkill),
      route: destination,
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stderr).toContain('skipped skill:release-notes');
  });

  it('fails with the problem, listing the missing names, when skipping was not asked for', async () => {
    const withSkill = {
      ...definition,
      resources: { ...definition.resources, skills: ['release-notes'] },
    };
    const run = await runCli(['agents', 'import', '-'], {
      stdin: JSON.stringify(withSkill),
      route: destination,
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('agent_definition_references_missing');
    expect(run.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('refuses a malformed or credential-carrying file before any request', async () => {
    const smuggled = { ...definition, agent: { ...definition.agent, apiKey: 'sk-live' } };
    const run = await runCli(['agents', 'import', '-'], { stdin: JSON.stringify(smuggled) });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('AgentDefinition');
    expect(run.calls).toEqual([]);
    const notJson = await runCli(['agents', 'import', '-'], { stdin: '{' });
    expect(notJson.code).toBe(EXIT_CODE.usage);
    const badFlag = await runCli(['agents', 'import', '-', '--on-missing', 'maybe'], {
      stdin: JSON.stringify(definition),
    });
    expect(badFlag.code).toBe(EXIT_CODE.usage);
    expect(badFlag.calls).toEqual([]);
  });
});
