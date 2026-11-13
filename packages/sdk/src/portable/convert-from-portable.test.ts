import { expect, it } from 'vitest';

import { claudeBaseToolPolicyFor } from '@indx-workspace/contracts/agents';

import type { PortableAgentInput } from '@indx-workspace/contracts/portable-agent';

import {
  defineAgent,
  openapiTool,
  toAgentVersionBody,
  toolDefinitionsOf,
} from '../define/index.js';
import { defineAgentFromPortable, toPortableAgent } from './index.js';
import {
  claude,
  openai,
  pi,
  NO_PERMISSIONS,
  PROJECT,
  MINIMAL,
  SAMPLE_PERMISSIONS,
  thrown,
  PORTABLE,
  fromPortable,
} from './convert.fixture.test-support.js';

it('name, instructions, permissions: are carried unchanged', () => {
  const { value, dropped } = fromPortable({
    name: 'support-triage',
    instructions: 'Triage.',
    permissions: SAMPLE_PERMISSIONS,
  });
  expect(dropped).toEqual([]);
  expect(value).toMatchObject({
    name: 'support-triage',
    instructions: 'Triage.',
    permissions: SAMPLE_PERMISSIONS,
  });
});

it('input: refuses something that is not a portable agent, under its subject', () => {
  const error = thrown(() => defineAgentFromPortable({ ...PORTABLE, name: 'Not Kebab' }));
  expect(error.message).toContain('defineAgentFromPortable()');
  expect(error.issues[0]?.path).toBe('name');
});

it('model: absent stays absent', () => {
  expect(fromPortable({}).value.model).toBeUndefined();
});

it('model: a provider becomes the alphabetically first connection with that provider', () => {
  const { value } = fromPortable(
    { model: { provider: 'anthropic', id: 'm-1' } },
    { models: PROJECT.models },
  );
  expect(value.model).toEqual({ connection: 'anthropic', id: 'm-1' });
  const later = fromPortable(
    { model: { provider: 'anthropic', id: 'm-1' } },
    {
      models: {
        'z-conn': { provider: 'anthropic', credential: { secret: 'Z_KEY' } },
        'b-conn': { provider: 'anthropic', credential: { secret: 'B_KEY' } },
      },
    },
  );
  expect(later.value.model).toEqual({ connection: 'b-conn', id: 'm-1' });
});

it("model: no connection with the provider, or no provider, gives 'default'", () => {
  expect(
    fromPortable({ model: { provider: 'openai', id: 'm-1' } }, { models: PROJECT.models }).value
      .model,
  ).toEqual({ connection: 'default', id: 'm-1' });
  expect(fromPortable({ model: { id: 'm-1' } }, { models: PROJECT.models }).value.model).toEqual({
    connection: 'default',
    id: 'm-1',
  });
  expect(fromPortable({ model: { provider: 'anthropic', id: 'm-1' } }).value.model).toEqual({
    connection: 'default',
    id: 'm-1',
  });
});

it('engine: an engine with a block becomes { id, ...block }', () => {
  const { value, dropped } = fromPortable({
    engine: pi,
    extensions: { engines: { [pi]: { thinkingLevel: 'low' } } },
  });
  expect(dropped).toEqual([]);
  expect(value.engine).toEqual({ id: pi, thinkingLevel: 'low' });
});

it('engine: an engine with no block stays the engine id; none stays none', () => {
  expect(fromPortable({ engine: openai }).value.engine).toBe(openai);
  expect(fromPortable({}).value.engine).toBeUndefined();
});

it('engine: a block defineAgent refuses throws', () => {
  const error = thrown(() =>
    fromPortable({ engine: pi, extensions: { engines: { [pi]: { thinkingLevel: 'loud' } } } }),
  );
  expect(error.message).toContain('defineAgentFromPortable()');
  expect(error.issues[0]?.path).toBe('engine');
});

it('engine: a customised Claude tool policy is dropped', () => {
  const tools = { ...claudeBaseToolPolicyFor(NO_PERMISSIONS), deny: [] };
  for (const block of [{ tools }, { tools: { base: 'claude_code_preset' } }]) {
    const { value, dropped } = fromPortable({
      engine: claude,
      extensions: { engines: { [claude]: block } },
    });
    expect(value.engine).toBe(claude);
    expect(dropped).toEqual([
      {
        path: `extensions.engines.${claude}.tools`,
        reason:
          'a stored Claude tool policy cannot be written in defineAgent(); set it with aw agents policy',
      },
    ]);
  }
});

it('engine: the base Claude tool policy of the permissions is stripped without a drop', () => {
  const { value, dropped } = fromPortable({
    engine: claude,
    extensions: { engines: { [claude]: { tools: claudeBaseToolPolicyFor(NO_PERMISSIONS) } } },
  });
  expect(value.engine).toBe(claude);
  expect(dropped).toEqual([]);
});

it('engine: a Claude tool policy that only adds autoApprove round-trips as engine.autoApprove', () => {
  const agent = defineAgent({
    ...MINIMAL,
    engine: { id: claude, autoApprove: ['Bash'] },
    permissions: { runCommands: true },
  });
  const portable = toPortableAgent(agent);
  const { value, dropped } = defineAgentFromPortable(portable.value);
  expect(dropped).toEqual([]);
  expect(value.engine).toEqual({ id: claude, autoApprove: ['Bash'] });
  expect(toAgentVersionBody(value)).toEqual(toAgentVersionBody(agent));
});

it('engine: an autoApprove for a tool the permissions turn off throws', () => {
  const tools = { ...claudeBaseToolPolicyFor(NO_PERMISSIONS), autoApprove: ['Read'] };
  const error = thrown(() =>
    fromPortable({ engine: claude, extensions: { engines: { [claude]: { tools } } } }),
  );
  expect(error.issues[0]?.path).toBe('engine.autoApprove.0');
});

it('engine: the base Claude tool policy in another rule order is stripped without a drop', () => {
  const base = claudeBaseToolPolicyFor(SAMPLE_PERMISSIONS);
  expect(base.deny.length).toBeGreaterThan(1);
  const tools = { ...base, deny: [...base.deny].reverse() };
  const { dropped } = fromPortable({
    engine: claude,
    permissions: SAMPLE_PERMISSIONS,
    extensions: { engines: { [claude]: { tools } } },
  });
  expect(dropped).toEqual([]);
});

it('engine: settings for another engine are dropped, also when the agent names none', () => {
  const { dropped } = fromPortable({
    engine: pi,
    extensions: { engines: { [openai]: { reasoningEffort: 'high' } } },
  });
  expect(dropped).toEqual([
    {
      path: `extensions.engines.${openai}`,
      reason: 'settings for an engine this agent does not use',
    },
  ]);
  const implicit = fromPortable({ extensions: { engines: { [pi]: { thinkingLevel: 'low' } } } });
  expect(implicit.dropped.map((entry) => entry.path)).toEqual([`extensions.engines.${pi}`]);
});

it('extensions.platforms: each platform’s options are dropped', () => {
  const { dropped } = fromPortable({
    extensions: { platforms: { 'copilot-studio': { schemaName: 'x' } } },
  });
  expect(dropped).toEqual([
    {
      path: 'extensions.platforms.copilot-studio',
      reason: 'platform options apply to aw platforms export, not to the agent',
    },
  ]);
});

it('limits: are carried', () => {
  expect(fromPortable({ limits: { maxTurns: 4, maxBudgetUsd: 2 } }).value.limits).toEqual({
    maxTurns: 4,
    maxBudgetUsd: 2,
  });
});

it('tools: a remote mcp tool becomes mcp(name)', () => {
  const { value, dropped } = fromPortable({
    tools: [
      {
        kind: 'mcp',
        name: 'crm',
        transport: 'streamable-http',
        url: 'https://crm.example.com/mcp',
      },
      { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://legacy.example.com/sse' },
    ],
  });
  expect(dropped).toEqual([]);
  expect(toAgentVersionBody(value).definition.resources.connectors).toEqual(['crm', 'legacy']);
});

it('tools: a stdio mcp tool is dropped', () => {
  const { value, dropped } = fromPortable({
    tools: [{ kind: 'mcp', name: 'local', transport: 'stdio', command: 'npx' }],
  });
  expect(value.tools).toEqual([]);
  expect(dropped).toEqual([
    {
      path: 'tools.0',
      reason: 'Agent Workspace project files name remote connectors only (http or sse)',
    },
  ]);
});

it('tools: a code tool is dropped', () => {
  const { dropped } = fromPortable({
    tools: [{ kind: 'code', name: 'lookup', description: 'Looks up.', inputSchema: {} }],
  });
  expect(dropped).toEqual([
    { path: 'tools.0', reason: 'a code tool needs its run file; declare it with defineTool()' },
  ]);
});

it('tools: an openapi tool with allow becomes openapiTool(), its secrets by name', () => {
  const { value, dropped } = fromPortable({
    tools: [
      {
        kind: 'openapi',
        name: 'orders',
        specRef: 'openapi/orders.json',
        allow: ['GET /orders/*'],
        baseUrl: 'https://api.example.com',
        auth: { secretRef: 'ORDERS_TOKEN' },
      },
      {
        kind: 'openapi',
        name: 'keyed',
        specRef: 'https://api.example.com/openapi.json',
        allow: ['GET /k'],
        auth: { secretRef: 'KEYED_TOKEN', header: 'X-Api-Key' },
      },
      { kind: 'openapi', name: 'open', specRef: 'openapi/open.json', allow: ['GET /o'] },
    ],
  });
  expect(dropped).toEqual([]);
  expect(toolDefinitionsOf(value)).toEqual([
    {
      kind: 'openapi',
      name: 'orders',
      spec: 'openapi/orders.json',
      allow: ['GET /orders/*'],
      baseUrl: 'https://api.example.com',
      auth: 'bearer',
      credential: { secret: 'ORDERS_TOKEN' },
    },
    {
      kind: 'openapi',
      name: 'keyed',
      spec: 'https://api.example.com/openapi.json',
      allow: ['GET /k'],
      auth: { header: 'X-Api-Key' },
      credential: { secret: 'KEYED_TOKEN' },
    },
    { kind: 'openapi', name: 'open', spec: 'openapi/open.json', allow: ['GET /o'], auth: 'none' },
  ]);
});

it('tools: an openapi tool without allow is dropped', () => {
  const { value, dropped } = fromPortable({
    tools: [{ kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json' }],
  });
  expect(value.tools).toEqual([]);
  expect(dropped).toEqual([
    { path: 'tools.0', reason: 'Agent Workspace needs explicit allow rules for an OpenAPI tool' },
  ]);
});

it('tools: an openapi tool openapiTool() refuses is dropped with its message', () => {
  const rules = ['post /orders'];
  const refusal = thrown(() =>
    openapiTool({ name: 'orders', spec: 'openapi/orders.json', allow: rules }),
  );
  const { value, dropped } = fromPortable({
    tools: [{ kind: 'openapi', name: 'orders', specRef: 'openapi/orders.json', allow: rules }],
  });
  expect(value.tools).toEqual([]);
  expect(dropped).toEqual([{ path: 'tools.0', reason: refusal.message }]);
});

it('tools: web_search and web_fetch are kept by unrestrictedNetwork, with no drop when on', () => {
  const { value, dropped } = fromPortable({
    permissions: { ...NO_PERMISSIONS, unrestrictedNetwork: true },
    tools: [
      { kind: 'builtin', id: 'web_search' },
      { kind: 'builtin', id: 'web_fetch' },
    ],
  });
  expect(dropped).toEqual([]);
  expect(value.permissions?.unrestrictedNetwork).toBe(true);
});

it('tools: web_search with unrestrictedNetwork off is dropped', () => {
  const { dropped } = fromPortable({ tools: [{ kind: 'builtin', id: 'web_search' }] });
  expect(dropped).toEqual([
    { path: 'tools.0', reason: 'grant permissions.unrestrictedNetwork to keep it' },
  ]);
});

it('tools: web_fetch with unrestrictedNetwork off is dropped', () => {
  const { dropped } = fromPortable({ tools: [{ kind: 'builtin', id: 'web_fetch' }] });
  expect(dropped).toEqual([
    { path: 'tools.0', reason: 'grant permissions.unrestrictedNetwork to keep it' },
  ]);
});

it('tools: file_access is kept by readFiles and dropped without it', () => {
  const tools = [{ kind: 'builtin', id: 'file_access' }] as const;
  expect(
    fromPortable({ tools, permissions: { ...NO_PERMISSIONS, readFiles: true } }).dropped,
  ).toEqual([]);
  expect(fromPortable({ tools }).dropped).toEqual([
    { path: 'tools.0', reason: 'grant permissions.readFiles to keep it' },
  ]);
});

it('tools: code_execution is kept by runCommands and dropped without it', () => {
  const tools = [{ kind: 'builtin', id: 'code_execution' }] as const;
  expect(
    fromPortable({ tools, permissions: { ...NO_PERMISSIONS, runCommands: true } }).dropped,
  ).toEqual([]);
  expect(fromPortable({ tools }).dropped).toEqual([
    { path: 'tools.0', reason: 'grant permissions.runCommands to keep it' },
  ]);
});

it('skills: become skill(name) in order', () => {
  const { value, dropped } = fromPortable({
    skills: [
      { name: 'refund-policy', path: 'skills/refund-policy' },
      { name: 'escalation', path: 'skills/escalation' },
    ],
  });
  expect(dropped).toEqual([]);
  expect(value.skills?.map((entry) => entry.name)).toEqual(['refund-policy', 'escalation']);
});

it('skills: a path other than skills/<name> is reported, the skill is kept', () => {
  const { value, dropped } = fromPortable({
    skills: [{ name: 'refund-policy', path: 'shared/refunds' }],
  });
  expect(value.skills).toHaveLength(1);
  expect(dropped).toEqual([
    {
      path: 'skills.0.path',
      reason: 'a skill is read from skills/refund-policy/ in the project',
    },
  ]);
});

it('description, files knowledge, subagents: are carried; a url source is dropped', () => {
  const { value, dropped } = fromPortable({
    description: 'Answers questions.',
    knowledge: [
      { kind: 'files', paths: ['docs/a.md'] },
      { kind: 'url', url: 'https://example.com/help' },
    ],
    subagents: [{ name: 'billing' }],
  });
  expect(dropped).toEqual([
    {
      path: 'knowledge.1',
      reason:
        'Agent Workspace engines cannot read a URL knowledge source; add a connector or a file',
    },
  ]);
  expect(value.description).toBe('Answers questions.');
  expect(value.subagents).toEqual(['billing']);
  expect(value.knowledge).toEqual([{ kind: 'files', paths: ['docs/a.md'] }]);
});

it('knowledge: a connector source is kept with its mcp tool, dropped without it', () => {
  const kept = fromPortable({
    tools: [
      { kind: 'mcp', name: 'wiki', transport: 'streamable-http', url: 'https://w.example/mcp' },
    ],
    knowledge: [{ kind: 'connector', name: 'wiki' }],
  });
  expect(kept.dropped).toEqual([]);
  expect(kept.value.knowledge).toEqual([{ kind: 'connector', name: 'wiki' }]);

  const lost = fromPortable({
    tools: [{ kind: 'mcp', name: 'wiki', transport: 'stdio', command: 'wiki-mcp' }],
    knowledge: [{ kind: 'connector', name: 'wiki' }],
  });
  expect(lost.dropped.map((entry) => entry.path)).toEqual(['tools.0', 'knowledge.0']);
  expect(lost.value.knowledge).toBeUndefined();
});

it('is pure: the input is not changed and the output is frozen', () => {
  const input: PortableAgentInput = {
    ...PORTABLE,
    tools: [{ kind: 'builtin', id: 'web_search' }],
    extensions: { platforms: { 'copilot-studio': {} } },
  };
  const before = structuredClone(input);
  const result = defineAgentFromPortable(input);
  expect(input).toEqual(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.value)).toBe(true);
  expect(Object.isFrozen(result.dropped)).toBe(true);
  expect(result.dropped.every((entry) => Object.isFrozen(entry))).toBe(true);
});
