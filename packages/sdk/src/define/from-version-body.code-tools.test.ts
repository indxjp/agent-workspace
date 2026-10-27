import { describe, expect, it } from 'vitest';

import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';

import {
  agentFromVersionBody,
  defineAgent,
  defineTool,
  mcp,
  openapiTool,
  toAgentVersionBody,
  toolModulesOf,
  z,
  type DefineAgentInput,
} from './index.js';

const tool = (name: string, description = `Run ${name}`) =>
  defineTool({ name, description, input: z.object({ id: z.string() }), run: `./${name}.run.ts` });

const x = tool('x');
const z2 = tool('z');
const y = openapiTool({ name: 'y', spec: 'apis/y.json', allow: ['GET /y'] });
const modules = toolModulesOf([
  { path: 'tools/x.ts', namespace: { x } },
  { path: 'tools/y.ts', namespace: { y } },
  { path: 'tools/z.ts', namespace: { default: z2 } },
]);
const project = { connectors: { a: { url: 'https://a.example.test/mcp' } } };
const DIGEST = 'a'.repeat(64);

const bodyOf = (tools: DefineAgentInput['tools']) =>
  AgentVersionBodySchema.parse(
    toAgentVersionBody(defineAgent({ name: 'helper', instructions: 'Help.', tools })),
  );

/** The pinned declaration aw writes for a code tool (`pinnedOf` in packages/aw). */
const pinned = (code: ReturnType<typeof tool>) => ({
  description: code.description,
  inputSchema: code.inputSchema,
  timeoutMs: code.limits.timeoutMs,
});

const withBundles = (body: AgentVersionBody, toolBundles: AgentVersionBody['toolBundles']) =>
  AgentVersionBodySchema.parse({ ...body, toolBundles });

const paths = (dropped: readonly { path: string }[]) => dropped.map(({ path }) => path);

describe('agentFromVersionBody code tools', () => {
  const body = bodyOf([mcp('a'), x, y, z2]);

  it('expands code tools in place at the aw-dev-tools position, default exports included', () => {
    expect(body.definition.resources.connectors).toStrictEqual(['a', 'aw-dev-tools', 'y']);
    const { value, dropped } = agentFromVersionBody({
      body,
      project,
      toolModules: modules,
      codeToolNames: ['x', 'z'],
    });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.tools).toStrictEqual([mcp('a'), x, z2, y]);
    expect(value.imports).toStrictEqual([
      { kind: 'code', name: 'x', module: 'tools/x.ts', exportName: 'x' },
      { kind: 'code', name: 'z', module: 'tools/z.ts', exportName: 'default' },
      { kind: 'openapi', name: 'y', module: 'tools/y.ts', exportName: 'y' },
    ]);
    expect(AgentVersionBodySchema.parse(toAgentVersionBody(value.agent))).toStrictEqual(body);
  });

  it('takes the names from toolBundles when codeToolNames is absent', () => {
    const { value, dropped } = agentFromVersionBody({
      body: withBundles(body, [
        { tool: 'x', digest: DIGEST, ...pinned(x) },
        { tool: 'z', digest: DIGEST, ...pinned(z2) },
      ]),
      project,
      toolModules: modules,
    });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.tools).toStrictEqual([mcp('a'), x, z2, y]);
  });

  it('accepts a pre-sandbox bundle entry, which pins a name and digest only', () => {
    const { dropped } = agentFromVersionBody({
      body: withBundles(bodyOf([x]), [{ tool: 'x', digest: DIGEST }]),
      toolModules: modules,
    });
    expect(dropped).toStrictEqual([]);
  });

  it('drops a bundle whose pinned declaration differs from the module tool, and its tool', () => {
    const { value, dropped } = agentFromVersionBody({
      body: withBundles(body, [
        { tool: 'x', digest: DIGEST, ...pinned(x), description: 'Changed' },
        { tool: 'z', digest: DIGEST, ...pinned(z2), timeoutMs: 1 },
      ]),
      project,
      toolModules: modules,
    });
    expect(paths(dropped)).toStrictEqual([
      'toolBundles.0',
      'toolBundles.1',
      'definition.resources.connectors.1',
    ]);
    expect(value.agent.tools).toStrictEqual([mcp('a'), y]);
  });

  it('drops a bundle for a tool codeToolNames does not name, and a named tool with no bundle', () => {
    const { dropped } = agentFromVersionBody({
      body: withBundles(body, [{ tool: 'x', digest: DIGEST, ...pinned(x) }]),
      project,
      toolModules: modules,
      codeToolNames: ['z'],
    });
    expect(paths(dropped)).toStrictEqual([
      'toolBundles.0',
      'toolBundles',
      'definition.resources.connectors.1',
    ]);
  });

  it('compares a bundle that pins a declaration without a description', () => {
    const { value, dropped } = agentFromVersionBody({
      body: withBundles(bodyOf([x]), [
        { tool: 'x', digest: DIGEST, inputSchema: { type: 'object', properties: {} } },
      ]),
      toolModules: modules,
    });
    expect(paths(dropped)).toStrictEqual(['toolBundles.0', 'definition.resources.connectors.0']);
    expect(value.agent.tools).toStrictEqual([]);
  });

  it('drops a code tool no module exports with defineTool(), naming it', () => {
    const { value, dropped } = agentFromVersionBody({
      body,
      project,
      toolModules: modules,
      codeToolNames: ['x', 'missing'],
    });
    expect(paths(dropped)).toStrictEqual(['definition.resources.connectors.1']);
    expect(dropped[0]?.reason).toContain('missing');
    expect(value.agent.tools).toStrictEqual([mcp('a'), x, y]);
  });

  it('drops aw-dev-tools when neither codeToolNames nor toolBundles names the tools', () => {
    const { dropped } = agentFromVersionBody({ body, project, toolModules: modules });
    expect(paths(dropped)).toStrictEqual(['definition.resources.connectors.1']);
    expect(dropped[0]?.reason).toContain('codeToolNames');
  });

  it('drops a duplicate in codeToolNames at its index and keeps the first', () => {
    const { value, dropped } = agentFromVersionBody({
      body,
      project,
      toolModules: modules,
      codeToolNames: ['x', 'x'],
    });
    expect(paths(dropped)).toStrictEqual(['codeToolNames.1']);
    expect(dropped[0]?.reason).toContain('x');
    expect(value.agent.tools).toStrictEqual([mcp('a'), x, y]);
  });

  it('drops a code tool named like an OpenAPI or Postgres module tool at its connector entry', () => {
    const { value, dropped } = agentFromVersionBody({
      body,
      project,
      toolModules: toolModulesOf([
        { path: 'tools/x.ts', namespace: { x } },
        { path: 'tools/y.ts', namespace: { y } },
        { path: 'tools/y-code.ts', namespace: { yCode: tool('y') } },
      ]),
      codeToolNames: ['x', 'y'],
    });
    expect(paths(dropped)).toStrictEqual(['definition.resources.connectors.2']);
    expect(dropped[0]?.reason).toContain('y');
    expect(value.agent.tools).toStrictEqual([mcp('a'), x, y]);
  });

  it('drops a code tool named like a module tool the body does not list at its index', () => {
    const { value, dropped } = agentFromVersionBody({
      body: bodyOf([x]),
      toolModules: toolModulesOf([
        { path: 'tools/x.ts', namespace: { x } },
        { path: 'tools/y.ts', namespace: { y } },
        { path: 'tools/y-code.ts', namespace: { yCode: tool('y') } },
      ]),
      codeToolNames: ['x', 'y'],
    });
    expect(paths(dropped)).toStrictEqual(['codeToolNames.1']);
    expect(value.agent.tools).toStrictEqual([x]);
  });

  it('drops a code tool named like a connector at that connector entry', () => {
    const { value, dropped } = agentFromVersionBody({
      body,
      project,
      toolModules: toolModulesOf([
        { path: 'tools/x.ts', namespace: { x } },
        { path: 'tools/y.ts', namespace: { y } },
        { path: 'tools/a.ts', namespace: { a: tool('a') } },
      ]),
      codeToolNames: ['x', 'a'],
    });
    expect(paths(dropped)).toStrictEqual(['definition.resources.connectors.0']);
    expect(dropped[0]?.reason).toContain('a');
    expect(value.agent.tools).toStrictEqual([mcp('a'), x, y]);
  });

  it('drops codeToolNames when the body has no code tools', () => {
    const { value, dropped } = agentFromVersionBody({
      body: bodyOf([mcp('a'), y]),
      project,
      toolModules: modules,
      codeToolNames: ['x'],
    });
    expect(dropped).toStrictEqual([
      { path: 'codeToolNames', reason: 'the body has no code tools' },
    ]);
    expect(value.agent.tools).toStrictEqual([mcp('a'), y]);
  });

  it('lets the first module of a code tool name win, in path order', () => {
    const other = tool('x', 'Another x');
    const { value, dropped } = agentFromVersionBody({
      body: bodyOf([x]),
      toolModules: toolModulesOf([
        { path: 'tools/b.ts', namespace: { x: other } },
        { path: 'tools/a.ts', namespace: { x } },
      ]),
      codeToolNames: ['x'],
    });
    expect(dropped).toStrictEqual([]);
    expect(value.imports).toStrictEqual([
      { kind: 'code', name: 'x', module: 'tools/a.ts', exportName: 'x' },
    ]);
    expect(value.agent.tools).toStrictEqual([x]);
  });
});
