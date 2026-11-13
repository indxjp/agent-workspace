/**
 * The loader's closed linker serves project-relative `.ts` modules (issue #548, ADR-0111's slice-2
 * amendment). Each case is a project in a temporary directory, loaded through the real child.
 */
import { mkdir } from 'node:fs/promises';

import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  agentFile,
  instructionsOf,
  load,
  ORDERS_TOOL,
  project,
  refusedSupport,
  supportAgent,
} from './load.fixture.test-support.js';
describe('the loader serves project-relative modules', () => {
  it('drops a location in node_modules or outside the root', async () => {
    const throwing = (url: string): string =>
      `${agentFile('x', '', "'x'")}const e = new Error('boom');\ne.stack = 'Error: boom\\n    at ' + ${url};\nthrow e;\n`;
    const root = await project({
      'agents/one.ts': throwing(
        "new URL('../node_modules/pkg/x.js', import.meta.url).href + ':1:1'",
      ),
      'agents/two.ts': throwing("'file:///elsewhere/x.js:1:1'"),
    });
    const { problems } = await load(root);
    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem.code).toBe('module_failed');
      expect(problem).not.toHaveProperty('location');
    }
  });

  it('takes the first project frame, not text in the message', async () => {
    const root = await project({
      'agents/one.ts': `${agentFile('one', '', "'x'")}throw new Error('see (file:///x/agents/a.ts:9:9)');\n`,
    });
    const [problem] = (await load(root)).problems;
    expect(problem?.location).toMatchObject({ file: 'agents/one.ts' });
    expect(problem?.location?.line).not.toBe(9);
  });

  it('shares one instance of a tool between two definitions', async () => {
    const imports = `import { evaluations } from '../tools/counter';\n`;
    const root = await project({
      'agents/one.ts': agentFile('one', imports, '`${evaluations()}`'),
      'agents/two.ts': agentFile('two', imports, '`${evaluations()}`'),
      'tools/counter.ts': `const store = globalThis as { toolEvaluations?: number };
store.toolEvaluations = (store.toolEvaluations ?? 0) + 1;
export function evaluations(): number {
  return store.toolEvaluations ?? 0;
}
`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'one')).toBe('1');
    expect(instructionsOf(result, 'two')).toBe('1');
  });

  it('refuses a transitive import and names the module that made it', async () => {
    const root = await project({
      'agents/support.ts': agentFile('support', `import { a } from '../tools/a';\n`, '`${a}`'),
      'tools/a.ts': `import { b } from './b';\nexport const a = b;\n`,
      'tools/b.ts': `import { readFileSync } from 'node:fs';\nexport const b = typeof readFileSync;\n`,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['node:fs', 'tools/b.ts']));
  });

  it('refuses a directory named like a .ts file', async () => {
    const root = await project({ 'agents/support.ts': supportAgent('../tools/orders.ts') });
    await mkdir(path.join(root, 'tools', 'orders.ts'), { recursive: true });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['../tools/orders.ts']));
  });

  it('keeps a link failure on the tool that failed, so a definition importing its sibling loads', async () => {
    const root = await project({
      'agents/one.ts': agentFile('one', `import { a } from '../tools/a';\n`, '`${a}`'),
      'agents/two.ts': agentFile('two', `import { b } from '../tools/b';\n`, '`${b}`'),
      'agents/three.ts': agentFile('three', `import { a } from '../tools/a';\n`, '`${a}`'),
      'tools/a.ts': `import { nope } from './b';\nexport const a = nope;\n`,
      'tools/b.ts': `export const b = 'healthy';\n`,
    });
    const result = await load(root);
    const details = ["The requested module './b' does not provide an export named 'nope'"];
    expect(result.problems).toEqual([
      { file: 'agents/one.ts', status: null, code: 'module_failed', details },
      { file: 'agents/three.ts', status: null, code: 'module_failed', details },
    ]);
    expect(instructionsOf(result, 'two')).toBe('healthy');
  });

  it.each([
    ['the refusing definition loads first', 'a', 'b'],
    ['the importing definition loads first', 'z', 'b'],
  ])(
    'names the definition that made a refused import when another definition imports it (%s)',
    async (_order, refusing, importing) => {
      const root = await project({
        [`agents/${refusing}.ts`]: agentFile(
          refusing,
          `import { readFileSync } from 'node:fs';\n`,
          '`${typeof readFileSync}`',
        ),
        [`agents/${importing}.ts`]: `import other from './${refusing}';\nexport default other;\n`,
      });
      const result = await load(root);
      expect(result.agents).toEqual([]);
      const problems = [
        {
          file: `agents/${importing}.ts`,
          status: null,
          code: 'import_refused',
          details: ['node:fs', `agents/${refusing}.ts`],
        },
        {
          file: `agents/${refusing}.ts`,
          status: null,
          code: 'import_refused',
          details: ['node:fs'],
        },
      ];
      expect(result.problems).toEqual(
        [...problems].sort((left, right) => left.file.localeCompare(right.file)),
      );
    },
  );

  it('refuses a specifier holding a colon, which on Windows names an alternate data stream', async () => {
    const root = await project({
      'agents/support.ts': supportAgent('../tools/orders.ts:evil'),
      'tools/orders.ts': ORDERS_TOOL,
      // On NTFS this writes the stream `evil.ts` of orders.ts; elsewhere a file of that name.
      'tools/orders.ts:evil.ts': `export const orders = 'hidden';\n`,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport(['../tools/orders.ts:evil']));
  });

  it('refuses an import that carries import attributes', async () => {
    const root = await project({
      'agents/json.ts': agentFile(
        'json',
        `import { orders } from '../tools/orders' with { type: 'json' };\n`,
        '`${orders}`',
      ),
      'agents/css.ts': `import { defineAgent } from '@indx-workspace/sdk/define' with { type: 'css' };
export default defineAgent({ name: 'css', instructions: 'Help people.' });
`,
      'tools/orders.ts': ORDERS_TOOL,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual([
      {
        file: 'agents/css.ts',
        status: null,
        code: 'import_refused',
        details: ['@indx-workspace/sdk/define'],
      },
      {
        file: 'agents/json.ts',
        status: null,
        code: 'import_refused',
        details: ['../tools/orders'],
      },
    ]);
  });

  it('cuts an over-long refused specifier instead of refusing the whole load', async () => {
    const specifier = `./${'a'.repeat(5000)}`;
    const root = await project({ 'agents/support.ts': supportAgent(specifier) });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual(refusedSupport([specifier.slice(0, 2000)]));
  });
});
