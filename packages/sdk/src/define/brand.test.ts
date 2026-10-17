import { describe, expect, it, vi } from 'vitest';

describe('the define brand', () => {
  it('survives two copies of the module', async () => {
    vi.resetModules();
    const copyA = await import('./index.js');
    vi.resetModules();
    const copyB = await import('./index.js');

    expect(copyA.defineAgent).not.toBe(copyB.defineAgent);
    expect(copyA.DefinitionError).not.toBe(copyB.DefinitionError);

    const agent = copyA.defineAgent({
      name: 'assistant',
      instructions: 'Answer briefly.',
      tools: [copyA.mcp('github')],
    });
    const surface = copyA.defineSurface({ name: 'main', agent: 'assistant' });

    expect(copyB.isDefinedAgent(agent)).toBe(true);
    expect(copyB.isDefinedSurface(surface)).toBe(true);
    expect(copyB.isDefinedAgent(surface)).toBe(false);
    expect(copyB.toAgentVersionBody(agent, { surfaces: [surface] }).surfaces).toHaveLength(1);
    expect(
      copyB.defineAgent({ ...agent, tools: [copyB.mcp('linear'), ...(agent.tools ?? [])] }),
    ).toBeTruthy();
  });

  it('survives two copies of the module for secrets and catalog tools', async () => {
    vi.resetModules();
    const copyA = await import('./index.js');
    vi.resetModules();
    const copyB = await import('./index.js');

    expect(copyA.openapiTool).not.toBe(copyB.openapiTool);

    const token = copyA.secret('ORDERS_TOKEN');
    const orders = copyA.openapiTool({
      name: 'orders',
      spec: 'openapi/orders.json',
      allow: ['GET /orders/*'],
      auth: token,
    });
    const warehouse = copyA.postgresTool({
      name: 'warehouse',
      url: copyA.secret('DB_URL'),
      readOnly: true,
      tables: ['public.orders'],
    });

    expect(copyB.isOpenApiTool(orders)).toBe(true);
    expect(copyB.isPostgresTool(warehouse)).toBe(true);
    expect(copyB.isOpenApiTool(warehouse)).toBe(false);
    // A copy-A secret is a reference copy B's tools accept.
    expect(
      copyB.openapiTool({ name: 'b', spec: 'b.json', allow: ['GET /x'], auth: token }).auth,
    ).toStrictEqual({ secret: 'ORDERS_TOKEN' });

    const agent = copyB.defineAgent({
      name: 'assistant',
      instructions: 'Answer briefly.',
      tools: [copyB.mcp('github'), orders, warehouse],
    });
    expect(copyA.toAgentVersionBody(agent).definition.resources.connectors).toStrictEqual([
      'github',
      'orders',
      'warehouse',
    ]);
    expect(copyA.toolDefinitionsOf(agent).map((definition) => definition.name)).toStrictEqual([
      'orders',
      'warehouse',
    ]);
  });

  it('is not carried by an object that only looks defined', async () => {
    const { isDefinedAgent, isDefinedSurface } = await import('./index.js');

    expect(isDefinedAgent({ name: 'assistant', instructions: 'x' })).toBe(false);
    expect(isDefinedSurface({ name: 'main', agent: 'assistant' })).toBe(false);
    expect(isDefinedAgent(null)).toBe(false);
    expect(isDefinedAgent('agent')).toBe(false);

    const { isOpenApiTool, isPostgresTool } = await import('./index.js');
    expect(isOpenApiTool({ name: 'orders', spec: 'a.json', allow: ['GET /x'] })).toBe(false);
    expect(isPostgresTool({ name: 'w', url: { secret: 'DB_URL' }, readOnly: true })).toBe(false);
  });

  it('is not inherited from a defined value', async () => {
    const { defineAgent, defineSurface, isDefinedAgent, isDefinedSurface } =
      await import('./index.js');
    const agent = defineAgent({ name: 'assistant', instructions: 'x' });
    const surface = defineSurface({ name: 'main', agent: 'assistant' });

    expect(isDefinedAgent(Object.create(agent))).toBe(false);
    expect(isDefinedSurface(Object.create(surface))).toBe(false);
  });
});
