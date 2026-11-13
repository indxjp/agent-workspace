/**
 * The loader's closed linker serves project-relative `.ts` modules (issue #548, ADR-0111's slice-2
 * amendment). Each case is a project in a temporary directory, loaded through the real child.
 */
import { rm, symlink } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  agentFile,
  DEFINE,
  instructionsOf,
  load,
  ORDERS_TOOL,
  project,
} from './load.fixture.test-support.js';
describe('the loader serves project-relative modules', () => {
  it('refuses a specifier holding %, ?, # or a backslash', async () => {
    const root = await project({
      'agents/percent.ts': agentFile(
        'percent',
        `import { orders } from './%2e%2e/tools/orders';\n`,
      ),
      'agents/query.ts': agentFile('query', `import { orders } from '../tools/orders?x';\n`),
      'agents/hash.ts': agentFile('hash', `import { orders } from '../tools/orders#x';\n`),
      'agents/slash.ts': agentFile('slash', `import { orders } from '..\\\\tools\\\\orders';\n`),
      'tools/orders.ts': ORDERS_TOOL,
      'agents/%2e%2e/tools/orders.ts': ORDERS_TOOL,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    expect(result.problems).toEqual([
      {
        file: 'agents/hash.ts',
        status: null,
        code: 'import_refused',
        details: ['../tools/orders#x'],
      },
      {
        file: 'agents/percent.ts',
        status: null,
        code: 'import_refused',
        details: ['./%2e%2e/tools/orders'],
      },
      {
        file: 'agents/query.ts',
        status: null,
        code: 'import_refused',
        details: ['../tools/orders?x'],
      },
      {
        file: 'agents/slash.ts',
        status: null,
        code: 'import_refused',
        details: [`..\\tools\\orders`],
      },
    ]);
  });

  it('links a cycle between two project files', async () => {
    const root = await project({
      'agents/support.ts': agentFile('support', `import { a } from '../tools/a';\n`, 'a()'),
      'tools/a.ts': `import { b } from './b';\nexport function a(): string {\n  return \`a\${b()}\`;\n}\n`,
      'tools/b.ts': `import { a } from './a';\nexport function b(): string {\n  return 'b';\n}\nexport const back = (): unknown => a;\n`,
    });
    const result = await load(root);
    expect(result.problems).toEqual([]);
    expect(instructionsOf(result, 'support')).toBe('ab');
  });

  it.each([
    ['throws while it evaluates', `throw new Error('the tool broke');\nexport const orders = 1;\n`],
    ['needs a transform', `enum Kind { A }\nexport const orders = Kind.A;\n`],
    [
      'imports node:fs',
      `import { readFileSync } from 'node:fs';\nexport const orders = typeof readFileSync;\n`,
    ],
    [
      'fails to link (a missing export of a sibling)',
      `import { nope } from './sibling';\nexport const orders = nope;\n`,
    ],
  ])('gives two definitions the same problem when a tool they import %s', async (_kind, tool) => {
    const imports = `import { orders } from '../tools/orders';\n`;
    const root = await project({
      'agents/one.ts': agentFile('one', imports, '`${orders}`'),
      'agents/two.ts': agentFile('two', imports, '`${orders}`'),
      'tools/orders.ts': tool,
      'tools/sibling.ts': `export const sibling = 'fine';\n`,
    });
    const result = await load(root);
    expect(result.agents).toEqual([]);
    const [one, two] = result.problems;
    expect(result.problems).toHaveLength(2);
    expect(one?.file).toBe('agents/one.ts');
    expect(two?.file).toBe('agents/two.ts');
    expect({ code: two?.code, details: two?.details }).toEqual({
      code: one?.code,
      details: one?.details,
    });
    expect(one?.code).toMatch(/^(module_failed|typescript_syntax_unsupported|import_refused)$/);
  });

  it('names the failure kind of each failing tool', async () => {
    const imports = `import { orders } from '../tools/orders';\n`;
    const thrown = await load(
      await project({
        'agents/one.ts': agentFile('one', imports, '`${orders}`'),
        'tools/orders.ts': `throw new Error('the tool broke');\nexport const orders = 1;\n`,
      }),
    );
    expect(thrown.problems).toEqual([
      {
        file: 'agents/one.ts',
        status: null,
        code: 'module_failed',
        details: ['the tool broke'],
        location: { file: 'tools/orders.ts', line: 1, column: 7 },
      },
    ]);
    const enumerated = await load(
      await project({
        'agents/one.ts': agentFile('one', imports, '`${orders}`'),
        'tools/orders.ts': `enum Kind { A }\nexport const orders = Kind.A;\n`,
      }),
    );
    expect(enumerated.problems).toMatchObject([
      { file: 'agents/one.ts', status: null, code: 'typescript_syntax_unsupported' },
    ]);
  });

  it('gives a syntax error and an unsupported construct the file, line and column', async () => {
    const root = await project({
      'agents/one.ts': agentFile('one', '', "'x'"),
      'surfaces/main.ts': 'export default {\n  name: "main"\n  agent: "one",\n};\n',
      'surfaces/enum.ts': 'export default 1;\n\n  enum Kind { A }\n',
    });
    const { problems } = await load(root);
    expect(problems).toMatchObject([
      {
        file: 'surfaces/enum.ts',
        code: 'typescript_syntax_unsupported',
        location: { file: 'surfaces/enum.ts', line: 3, column: 3 },
      },
      {
        file: 'surfaces/main.ts',
        code: 'module_failed',
        location: { file: 'surfaces/main.ts', line: 3, column: 3 },
      },
    ]);
  });

  it('gives a refused definition the line of its defineAgent() call (BH061-046)', async () => {
    const root = await project({
      'agents/one.ts': `${DEFINE}\n\nexport default defineAgent({ name: 'one', instruction: 'x' });\n`,
    });
    const { problems } = await load(root);
    expect(problems).toMatchObject([
      {
        file: 'agents/one.ts',
        code: 'invalid_agent_version',
        location: { file: 'agents/one.ts', line: 4 },
      },
    ]);
    expect(problems[0]?.details).toContain(
      '(root): Unrecognized key: "instruction" (did you mean "instructions"?)',
    );
  });

  it('keeps a location when the project root goes through a directory symlink', async () => {
    const root = await project({
      'agents/one.ts': agentFile('one', '', "'x'"),
      'surfaces/main.ts': 'export default {\n  name: "main"\n  agent: "one",\n};\n',
    });
    const link = `${root}-link`;
    await symlink(root, link, 'junction'); // a junction needs no admin on Windows; same as 'dir' elsewhere
    const { problems } = await load(link);
    expect(problems).toMatchObject([
      { file: 'surfaces/main.ts', location: { file: 'surfaces/main.ts', line: 3, column: 3 } },
    ]);
    await rm(link, { recursive: true, force: true });
  });
});
