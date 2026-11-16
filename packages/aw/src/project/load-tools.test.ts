import { describe, expect, it } from 'vitest';

import {
  ORDERS_DEFINITION,
  TOOLS_DEFINE,
  agentFile,
  io,
  load,
  ordersTool,
  project,
  toolAgent,
} from './load.fixture.test-support.js';

import { loadProject } from './load.js';
describe('the loader carries catalog tools with their files (issue #549)', () => {
  it('attributes a tool to the file that exports it', async () => {
    const root = await project({
      'agents/support.ts': toolAgent('support'),
      'tools/orders.ts': ordersTool(),
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(result.tools).toEqual([{ file: 'tools/orders.ts', definition: ORDERS_DEFINITION }]);
  });

  it("attributes an inline tool to the agent's file", async () => {
    const root = await project({
      'agents/support.ts': `${TOOLS_DEFINE}export default defineAgent({
  name: 'support',
  instructions: 'Help.',
  tools: [openapiTool({ name: 'orders', spec: 'apis/orders.openapi.json', allow: ['GET /orders/*'], auth: secret('ORDERS_TOKEN') })],
});
`,
    });
    const result = await load(root);
    expect(result.tools).toEqual([{ file: 'agents/support.ts', definition: ORDERS_DEFINITION }]);
  });

  it('carries the identity an openapiTool declares through the loader child (ADR-0142)', async () => {
    const root = await project({
      'agents/support.ts': toolAgent('support'),
      'tools/orders.ts': ordersTool().replace(
        "auth: secret('ORDERS_TOKEN'),",
        "auth: secret('ORDERS_TOKEN'),\n  identity: secret('ORDERS_IDENTITY_KEY'),",
      ),
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(result.tools).toEqual([
      {
        file: 'tools/orders.ts',
        definition: { ...ORDERS_DEFINITION, identity: { secret: 'ORDERS_IDENTITY_KEY' } },
      },
    ]);
  });

  it('gives one entry for a tool two agents import', async () => {
    const root = await project({
      'agents/a.ts': toolAgent('a'),
      'agents/b.ts': toolAgent('b'),
      'tools/orders.ts': ordersTool(),
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(result.agents.map((agent) => agent.name)).toEqual(['a', 'b']);
    expect(result.tools).toEqual([{ file: 'tools/orders.ts', definition: ORDERS_DEFINITION }]);
  });

  it('refuses a second, different tool of the same name', async () => {
    const root = await project({
      'agents/a.ts': toolAgent('a'),
      'agents/b.ts': toolAgent('b', '../tools/other'),
      'tools/orders.ts': ordersTool(),
      'tools/other.ts': ordersTool(`['GET /orders']`),
    });
    const result = await load(root);
    expect(result.problems).toEqual([
      { file: 'tools/other.ts', status: null, code: 'tool_name_duplicate', details: ['orders'] },
    ]);
    expect(result.tools).toEqual([{ file: 'tools/orders.ts', definition: ORDERS_DEFINITION }]);
  });

  it('applies no tool of an agent a later check refuses', async () => {
    const surface = `import { defineSurface } from '@indx-workspace/sdk/define';
export default defineSurface({ name: 'main', agent: 'a' });
`;
    const root = await project({
      'agents/a.ts': toolAgent('a'),
      'tools/orders.ts': ordersTool(),
      'agents/b.ts': agentFile('b', ''),
      'surfaces/main.ts': surface.replace("'a'", "'b'"),
      'surfaces/other.ts': surface,
    });
    const result = await load(root);
    expect(result.problems.map((problem) => problem.code)).toEqual(['surface_name_duplicate']);
    expect(result.agents.map((agent) => agent.name)).toEqual(['b']);
    expect(result.tools).toEqual([]);
  });

  it('loads a project with no tools as before', async () => {
    const root = await project({ 'agents/assistant.ts': agentFile('assistant', '') });
    const result = await load(root);
    expect(result).toEqual({
      agents: [expect.objectContaining({ file: 'agents/assistant.ts', name: 'assistant' })],
      problems: [],
      secrets: [],
      tools: [],
      codeTools: [],
    });
  });

  it('reports a defineTool() tool by name and file, and lists its connector (ADR-0115)', async () => {
    const root = await project({
      'agents/support.ts': `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order.ts';
export default defineAgent({ name: 'support', instructions: 'Help.', tools: [getOrder] });
`,
      'tools/get-order.ts': `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  run: './get-order.run.ts',
});
`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(result.codeTools).toMatchObject([
      {
        file: 'tools/get-order.ts',
        name: 'get_order',
        run: './get-order.run.ts',
        pinned: {
          description: 'Look up an order',
          inputSchema: { type: 'object' },
          timeoutMs: 30_000,
        },
      },
    ]);
    expect(result.tools).toEqual([]);
    expect(result.agents[0]?.body.definition.resources.connectors).toEqual(['aw-dev-tools']);
  });

  it('never hands the loader child the value of a secret a tool names (C10, SD17)', async () => {
    const root = await project({
      'agents/support.ts': toolAgent('support'),
      'tools/orders.ts': `import { openapiTool, secret } from '@indx-workspace/sdk/define';
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
export const orders = openapiTool({
  name: env?.ORDERS_TOKEN === undefined ? 'orders' : 'leaked',
  spec: 'apis/orders.openapi.json',
  allow: ['GET /orders/*'],
  auth: secret('ORDERS_TOKEN'),
});
`,
    });
    const result = await loadProject({
      root,
      io: { ...io, env: { ORDERS_TOKEN: 'sentinel-orders-token' } },
      signal: new AbortController().signal,
      withheld: ['ORDERS_TOKEN'],
    });
    expect(result.tools.map((tool) => tool.definition.name)).toEqual(['orders']);
  });
});
