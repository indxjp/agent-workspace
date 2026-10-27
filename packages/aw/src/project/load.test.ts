/**
 * The loader's closed linker serves project-relative `.ts` modules (issue #548, ADR-0111's slice-2
 * amendment). Each case is a project in a temporary directory, loaded through the real child.
 */
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { CliIo } from '../io.js';
import { tempDirectory, tempFile } from '../testing.js';

import { loadProject, type ProjectLoad } from './load.js';

const DEFINE = `import { defineAgent } from '@indx-workspace/sdk/define';\n`;

/** An agent named `name` that imports `imports` and writes `instructions` (a JS expression). */
function agentFile(name: string, imports: string, instructions = `'Help people.'`): string {
  return `${DEFINE}${imports}
export default defineAgent({ name: '${name}', instructions: ${instructions} });
`;
}

/** `agents/support.ts`, importing `orders` from `specifier` and writing it into its body. */
function supportAgent(specifier: string): string {
  return agentFile('support', `import { orders } from '${specifier}';\n`, '`Orders: ${orders}`');
}

const ORDERS_TOOL = `export const orders: string = 'from the tool';\n`;

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await tempDirectory();
  directories.push(directory);
  return directory;
}

/** Write `files` (paths relative to `root`) and answer `root`. */
async function write(root: string, files: Readonly<Record<string, string>>): Promise<string> {
  for (const [file, contents] of Object.entries(files)) await tempFile(root, file, contents);
  return root;
}

async function project(files: Readonly<Record<string, string>>): Promise<string> {
  return write(await scratch(), files);
}

const io: CliIo = {
  stdin: () => Promise.resolve(''),
  stdout: () => undefined,
  stderr: () => undefined,
  env: {},
  homeDir: 'C:/nonexistent-home',
  fetch: () => Promise.reject(new Error('no network')),
  isTty: false,
};

function load(root: string): Promise<ProjectLoad> {
  return loadProject({ root, io, signal: new AbortController().signal });
}

function instructionsOf(result: ProjectLoad, name: string): unknown {
  return result.agents.find((agent) => agent.name === name)?.body.definition.agent.instructions;
}

/** The single problem of a load whose only agent is `agents/support.ts`. */
function refusedSupport(details: readonly string[]): ProjectLoad['problems'] {
  return [{ file: 'agents/support.ts', status: null, code: 'import_refused', details }];
}

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

const TOOLS_DEFINE = `import { defineAgent, openapiTool, secret } from '@indx-workspace/sdk/define';\n`;

/** `tools/orders.ts`: the `orders` tool, with `allow` as given. */
function ordersTool(allow = `['GET /orders/*']`): string {
  return `import { openapiTool, secret } from '@indx-workspace/sdk/define';
export const orders = openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ${allow},
  auth: secret('ORDERS_TOKEN'),
});
`;
}

/** An agent named `name` whose tools are the `orders` it imports from `tools/orders.ts`. */
function toolAgent(name: string, from = '../tools/orders'): string {
  return `${TOOLS_DEFINE}import { orders } from '${from}';
export default defineAgent({ name: '${name}', instructions: 'Help.', tools: [orders] });
`;
}

const ORDERS_DEFINITION = {
  kind: 'openapi',
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ['GET /orders/*'],
  auth: 'bearer',
  credential: { secret: 'ORDERS_TOKEN' },
};

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
