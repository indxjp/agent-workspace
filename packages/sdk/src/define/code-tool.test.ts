import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  CODE_TOOL_DEFAULT_TIMEOUT_MS,
  DefinitionError,
  defineAgent,
  defineTool,
  isCodeTool,
  mcp,
  secret,
  toAgentVersionBody,
  z,
  type ToolRun,
} from './index.js';

const ORDER = {
  name: 'get_order',
  description: 'Look up an order by its id',
  input: z.object({ id: z.string().describe('Order id') }),
  run: './get-order.run.ts',
} as const;

function issuesOf(run: () => unknown): readonly { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) return error.issues;
    throw error;
  }
  return [];
}

describe('defineTool', () => {
  it('stores the input as JSON Schema and defaults the timeout', () => {
    const tool = defineTool(ORDER);
    expect(isCodeTool(tool)).toBe(true);
    expect(Object.isFrozen(tool)).toBe(true);
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string', description: 'Order id' } },
      required: ['id'],
    });
    expect(tool.limits.timeoutMs).toBe(CODE_TOOL_DEFAULT_TIMEOUT_MS);
    expect(JSON.parse(JSON.stringify(tool))).toEqual({ ...tool });
  });

  it('stores an output schema and a timeout when given', () => {
    const tool = defineTool({
      ...ORDER,
      output: z.object({ status: z.string() }),
      limits: { timeoutMs: 5000 },
    });
    expect(tool.outputSchema).toMatchObject({ properties: { status: { type: 'string' } } });
    expect(tool.limits.timeoutMs).toBe(5000);
  });

  it('never reads the run file', () => {
    expect(defineTool({ ...ORDER, run: './does/not/exist.ts' }).run).toBe('./does/not/exist.ts');
  });

  it.each([
    ['a name with a space', { name: 'get order' }, 'name'],
    ['an empty description', { description: '' }, 'description'],
    ['a run path that is not .ts or .js', { run: './x.json' }, 'run'],
    ['a parent segment in run', { run: '../x.ts' }, 'run'],
    ['a URL as run', { run: 'https://example.com/x.ts' }, 'run'],
    ['a null timeout', { limits: { timeoutMs: null } }, 'limits.timeoutMs'],
    ['a declaration file as run', { run: './x.d.ts' }, 'run'],
    ['a zero timeout', { limits: { timeoutMs: 0 } }, 'limits.timeoutMs'],
    ['a timeout over ten minutes', { limits: { timeoutMs: 600_001 } }, 'limits.timeoutMs'],
    ['an input that is not a Zod object', { input: { id: 'string' } }, 'input'],
    ['an unknown key', { retries: 2 }, '(root)'],
    ['an output that cannot be JSON Schema', { output: z.date() }, 'output'],
  ])('refuses %s', (_label, change, path) => {
    const issues = issuesOf(() => defineTool({ ...ORDER, ...change } as never));
    expect(issues.map((issue) => issue.path)).toContain(path);
  });

  it('types a run function from its declaration', () => {
    type Run = ToolRun<ReturnType<typeof defineTool<typeof ORDER.input>>>;
    expectTypeOf<Parameters<Run>[0]>().toEqualTypeOf<{ id: string }>();
  });

  it('types the run arguments as the model sends them, before any default', () => {
    const tool = defineTool({ ...ORDER, input: z.object({ limit: z.number().default(10) }) });
    expect(isCodeTool(tool)).toBe(true);
    expectTypeOf<Parameters<ToolRun<typeof tool>>[0]>().toEqualTypeOf<{
      limit?: number | undefined;
    }>();
  });

  it('reports a conversion failure together with the other problems', () => {
    const issues = issuesOf(() =>
      defineTool({ ...ORDER, name: 'bad name', input: z.object({ d: z.date() }) }),
    );
    expect(issues.map((issue) => issue.path).sort()).toEqual(['input', 'name']);
  });

  it('is a tool defineAgent accepts, listed once as the aw-dev-tools connector', () => {
    const second = defineTool({ ...ORDER, name: 'list_orders', run: './list-orders.run.ts' });
    const agent = defineAgent({
      name: 'a',
      instructions: 'x',
      tools: [defineTool(ORDER), second, mcp('tickets')],
    });
    expect(toAgentVersionBody(agent).definition.resources.connectors).toEqual([
      'aw-dev-tools',
      'tickets',
    ]);
  });

  it('refuses the same code tool name twice', () => {
    const issues = issuesOf(() =>
      defineAgent({
        name: 'a',
        instructions: 'x',
        tools: [defineTool(ORDER), defineTool(ORDER)],
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(['tools.1']);
  });

  it('stores the secrets by name and the allowed domains, and keeps them out of a tool without', () => {
    const plain = defineTool(ORDER);
    expect(plain).not.toHaveProperty('secrets');
    expect(JSON.stringify(plain)).not.toContain('allowedDomains');
    const tool = defineTool({
      ...ORDER,
      secrets: [secret('ORDERS_API_KEY'), { secret: 'OTHER_KEY' }],
      allowedDomains: ['api.example.com', '*.example.org'],
    });
    expect(tool.secrets).toEqual(['ORDERS_API_KEY', 'OTHER_KEY']);
    expect(tool.allowedDomains).toEqual(['api.example.com', '*.example.org']);
  });

  it.each([
    ['a secret value instead of a reference', { secrets: ['sk-live-123'] }, 'secrets.0'],
    ['a reserved secret name', { secrets: [{ secret: 'PORT' }] }, 'secrets.0.secret'],
    ['the same secret twice', { secrets: [secret('A_KEY'), secret('A_KEY')] }, 'secrets'],
    ['a bare * domain', { allowedDomains: ['*'] }, 'allowedDomains.0'],
    ['a domain with a comma', { allowedDomains: ['a.com,b.com'] }, 'allowedDomains.0'],
    ['a domain with a scheme', { allowedDomains: ['https://a.com'] }, 'allowedDomains.0'],
    ['the same domain twice', { allowedDomains: ['a.com', 'a.com'] }, 'allowedDomains'],
  ])('refuses %s', (_label, change, path) => {
    expect(
      issuesOf(() => defineTool({ ...ORDER, ...change } as never)).map((issue) => issue.path),
    ).toEqual([path]);
  });
});
