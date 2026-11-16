/**
 * The loader's closed linker serves project-relative `.ts` modules (issue #548, ADR-0111's slice-2
 * amendment). Each case is a project in a temporary directory, loaded through the real child.
 */
import { symlink } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFINE,
  ORDERS_TOOL,
  agentFile,
  instructionsOf,
  load,
  project,
  refusedSupport,
  scratch,
  supportAgent,
  write,
} from './load.fixture.test-support.js';
describe('the loader serves project-relative modules', () => {
  it('loads a definition that imports ../tools/orders, and the value reaches the body', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders'),
      'tools/orders.ts': ORDERS_TOOL,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'support')).toBe('Orders: from the tool');
  });

  it('carries description and subagents from the definition into the body', async () => {
    const root = await project({
      'agents/support.ts': `${DEFINE}export default defineAgent({ name: 'support', description: 'Answers orders.', instructions: 'Help.', subagents: ['billing'] });\n`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    const body = result.agents.find((agent) => agent.name === 'support')?.body;
    expect(body?.description).toBe('Answers orders.');
    expect(body?.subagents).toEqual([{ name: 'billing' }]);
  });

  it('loads ../tools/orders.ts written with its extension', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders.ts'),
      'tools/orders.ts': ORDERS_TOOL,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'support')).toBe('Orders: from the tool');
  });

  it('loads orders.schema.ts for ../tools/orders.schema', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders.schema'),
      'tools/orders.schema.ts': `export const orders = 'the schema';\n`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'support')).toBe('Orders: the schema');
  });

  it('loads a defineTool declaration without loading its run file', async () => {
    const root = await project({
      'agents/support.ts': agentFile(
        'support',
        `import getOrder from '../tools/get-order.ts';
`,
        '`Tool: ${getOrder.name} ${getOrder.run}`',
      ),
      'tools/get-order.ts': `import { defineTool, z } from '@indx-workspace/sdk/define';
export default defineTool({
  name: 'get_order',
  description: 'Look up an order',
  input: z.object({ id: z.string() }),
  run: './get-order.run.ts',
});
`,
      // Importing this would throw, and its node:fs import would be refused.
      'tools/get-order.run.ts': `import 'node:fs';
throw new Error('the run file was loaded');
`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'support')).toBe('Tool: get_order ./get-order.run.ts');
  });

  it('refuses a symlinked tools/ directory whose real path leaves the root', async () => {
    const outside = await project({ 'orders.ts': ORDERS_TOOL });
    const root = await project({ 'agents/support.ts': supportAgent('../tools/orders') });
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    await symlink(outside, path.join(root, 'tools'), 'junction');
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['../tools/orders']));
  });

  it('refuses ../../x even when x.ts exists outside the root', async () => {
    const base = await project({ 'x.ts': ORDERS_TOOL });
    const root = await write(path.join(base, 'project'), {
      'agents/support.ts': supportAgent('../../x'),
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['../../x']));
  });

  it('refuses node:fs imported in a tool file, naming the tool', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders'),
      'tools/orders.ts': `import { readFileSync } from 'node:fs';\nexport const orders = typeof readFileSync;\n`,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['node:fs', 'tools/orders.ts']));
  });

  it('refuses another package imported in a tool file', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders'),
      'tools/orders.ts': `import { z } from 'zod';\nexport const orders = typeof z;\n`,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['zod', 'tools/orders.ts']));
  });

  it('refuses a path through node_modules, in any case', async () => {
    const root = await project({
      'agents/lower.ts': agentFile(
        'lower',
        `import { orders } from '../node_modules/pkg/index';\n`,
      ),
      'agents/mixed.ts': agentFile(
        'mixed',
        `import { orders } from '../Node_Modules/pkg/index';\n`,
      ),
      'node_modules/pkg/index.ts': ORDERS_TOOL,
      // On a case-insensitive filesystem this is the same file as above.
      'Node_Modules/pkg/index.ts': ORDERS_TOOL,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual([
      {
        file: 'agents/lower.ts',
        status: null,
        code: 'import_refused',
        details: ['../node_modules/pkg/index'],
      },
      {
        file: 'agents/mixed.ts',
        status: null,
        code: 'import_refused',
        details: ['../Node_Modules/pkg/index'],
      },
    ]);
  });

  it('still serves a project whose root sits under a node_modules directory', async () => {
    const base = await scratch();
    const root = await write(path.join(base, 'node_modules', 'proj'), {
      'agents/support.ts': supportAgent('../tools/orders'),
      'tools/orders.ts': ORDERS_TOOL,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'support')).toBe('Orders: from the tool');
  });

  it('refuses ../tools/orders.js, which names orders.js.ts, even when both files exist', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders.js'),
      'tools/orders.ts': ORDERS_TOOL,
      'tools/orders.js': `export const orders = 'javascript';\n`,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['../tools/orders.js']));
  });
});
