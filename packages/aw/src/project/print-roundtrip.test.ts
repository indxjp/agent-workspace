/**
 * `printAgentProject` round trip through the project loader [US-BLD-06][unit][aw]. This file lives
 * in `packages/aw` because the loader is internal to aw: each gallery project is loaded as
 * `aw check` loads it, its bodies are printed as `agents/<name>.ts` + `.md`, the printed files
 * replace the originals in a copy of the project, and the copy loads back to the same bodies.
 */
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import {
  defineAgent,
  defineSurface,
  files,
  mcp,
  openapiTool,
  postgresTool,
  secret,
  skill,
  toAgentVersionBody,
  toolModulesOf,
  type DefineAgentInput,
} from '@indx-workspace/sdk/define';
import { printAgentProject } from '@indx-workspace/sdk/portable';
import { parseProjectFile } from '@indx-workspace/sdk/project';
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import type { CliIo } from '../io.js';
import { tempDirectory } from '../testing.js';
import { loadProject, type ProjectLoad } from './load.js';

/** Each load starts a child process, so a test that loads many projects gets its own budget. */
const LOAD_TIMEOUT_MS = 60_000;

/** The 200-run loader-backed property; measured, then given room for a slower machine. */
const PROPERTY_TIMEOUT_MS = 600_000;

const GALLERY = fileURLToPath(new URL('../../../../tests/gallery/', import.meta.url));

const io: CliIo = {
  stdin: () => Promise.resolve(''),
  stdout: () => undefined,
  stderr: () => undefined,
  env: {},
  homeDir: path.join(tmpdir(), 'aw-print-roundtrip-no-home'),
  fetch: () => Promise.reject(new Error('no network')),
  isTty: false,
};

const directories: string[] = [];

afterAll(async () => {
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function projectFile(root: string) {
  const read = parseProjectFile(await readFile(path.join(root, 'agent-workspace.yaml'), 'utf8'));
  if (read.lifted) throw new Error(`${root} is a v1 profile; a gallery project is written as v2`);
  return read.project;
}

async function load(root: string): Promise<ProjectLoad> {
  const result = await loadProject({
    root,
    io,
    signal: new AbortController().signal,
    defaultEngine: (await projectFile(root)).engine,
  });
  expect(result.problems, root).toStrictEqual([]);
  return result;
}

/**
 * The tool modules of a loaded project, as `toolModulesOf` takes them. The loader answers each
 * tool's module file and definition but not the name it is exported under, so the export name is
 * read from the module's `export const <name> = openapiTool({ name: '…'`, and the tool is made
 * again from its definition's name, spec and allow list (all the printer reads is the name).
 */
async function toolModulesOfLoad(root: string, result: ProjectLoad) {
  const modules = [];
  for (const { file, definition } of result.tools) {
    if (definition.kind !== 'openapi') throw new Error(`${file}: only openapiTool() is printed`);
    const text = await readFile(path.join(root, file), 'utf8');
    const exported = new RegExp(
      String.raw`export const (\w+) = openapiTool\(\{\s*name: '${definition.name}'`,
      'u',
    ).exec(text);
    if (exported?.[1] === undefined) throw new Error(`${file} does not export ${definition.name}`);
    const { name, spec, allow } = definition;
    modules.push({
      path: file,
      namespace: { [exported[1]]: openapiTool({ name, spec, allow: [...allow] }) },
    });
  }
  return toolModulesOf(modules);
}

/** Prints every agent of the project at `root` into a copy of it and loads the copy. */
async function roundTrip(root: string): Promise<{ before: ProjectLoad; after: ProjectLoad }> {
  const before = await load(root);
  const project = await projectFile(root);
  const toolModules = await toolModulesOfLoad(root, before);
  const copy = await tempDirectory();
  directories.push(copy);
  await cp(root, copy, {
    recursive: true,
    filter: (from) =>
      ['', 'agent-workspace.yaml', 'tools', 'surfaces'].includes(
        path.relative(root, from).split(path.sep)[0] ?? '',
      ),
  });
  await mkdir(path.join(copy, 'agents'));
  for (const agent of before.agents) {
    const printed = printAgentProject({
      body: agent.body,
      project,
      toolModules,
      surfaces: agent.body.surfaces.map((surface) => defineSurface(surface)),
    });
    for (const file of printed.files) await writeFile(path.join(copy, file.path), file.text);
  }
  return { before, after: await load(copy) };
}

function bodies(result: ProjectLoad): unknown {
  return result.agents.map((agent) => AgentVersionBodySchema.parse(agent.body));
}

const ids = readdirSync(GALLERY, { withFileTypes: true })
  .filter(
    (entry) =>
      entry.isDirectory() && existsSync(path.join(GALLERY, entry.name, 'agent-workspace.yaml')),
  )
  .map((entry) => entry.name)
  .sort();

describe('printAgentProject through the project loader', () => {
  it('finds the ten gallery use cases', () => {
    expect(ids).toHaveLength(10);
  });

  it.each(ids)(
    'prints %s as files that load back to the same body',
    async (id) => {
      const { before, after } = await roundTrip(path.join(GALLERY, id));
      expect(before.agents.length).toBeGreaterThan(0);
      expect(bodies(after)).toStrictEqual(bodies(before));
    },
    LOAD_TIMEOUT_MS,
  );
});

/** The connectors `agent-workspace.yaml` declares, which generated agents may use as `mcp()` tools. */
const CONNECTORS = ['hub', 'crm', 'wiki'] as const;

/** The two catalog tools of the generated project's `tools/catalog.ts`. */
const catalog = {
  orders: openapiTool({
    name: 'orders',
    spec: 'apis/orders.json',
    allow: ['GET /orders/*'],
    auth: secret('ORDERS_TOKEN'),
  }),
  ledger: postgresTool({
    name: 'ledger',
    url: secret('LEDGER_URL'),
    readOnly: true,
    tables: ['public.entries', 'public.accounts'],
    maxRows: 500,
  }),
};

const CATALOG_SOURCE = `import { openapiTool, postgresTool, secret } from '@indx-workspace/sdk/define';

export const orders = openapiTool({
  name: 'orders',
  spec: 'apis/orders.json',
  allow: ['GET /orders/*'],
  auth: secret('ORDERS_TOKEN'),
});

export const ledger = postgresTool({
  name: 'ledger',
  url: secret('LEDGER_URL'),
  readOnly: true,
  tables: ['public.entries', 'public.accounts'],
  maxRows: 500,
});
`;

const PROJECT_SOURCE =
  'apiVersion: agentworkspace.dev/v2\nkind: Project\nname: printed\n' +
  `connectors:\n${CONNECTORS.map((connector) => `  ${connector}:\n    url: https://${connector}.example.test/mcp\n`).join('')}` +
  'environments:\n  local:\n    cloud: local\n    identity:\n      bootstrapAdmin: admin@localhost.test\n';

const ORDERS_SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Orders', version: '1.0.0' },
  servers: [{ url: 'https://orders.example.test/api' }],
  paths: {},
});

/**
 * One project directory the whole file reuses: the project file with its connectors, the catalog
 * tools and the spec stay; each load replaces `agents/`, so the cost of a case is the loader's.
 */
let fixture: Promise<string> | undefined;
function fixtureRoot(): Promise<string> {
  fixture ??= (async () => {
    const root = await tempDirectory();
    directories.push(root);
    await mkdir(path.join(root, 'tools'));
    await mkdir(path.join(root, 'apis'));
    await writeFile(path.join(root, 'agent-workspace.yaml'), PROJECT_SOURCE);
    await writeFile(path.join(root, 'tools', 'catalog.ts'), CATALOG_SOURCE);
    await writeFile(path.join(root, 'apis', 'orders.json'), ORDERS_SPEC);
    return root;
  })();
  return fixture;
}

/** Prints `inputs` into the fixture project, loads it with the loader, and answers the load. */
async function loadPrinted(inputs: readonly DefineAgentInput[]): Promise<ProjectLoad> {
  const root = await fixtureRoot();
  const project = await projectFile(root);
  const toolModules = toolModulesOf([{ path: 'tools/catalog.ts', namespace: catalog }]);
  await rm(path.join(root, 'agents'), { recursive: true, force: true });
  await mkdir(path.join(root, 'agents'));
  for (const input of inputs) {
    const body = AgentVersionBodySchema.parse(toAgentVersionBody(defineAgent(input)));
    for (const file of printAgentProject({ body, project, toolModules }).files) {
      await writeFile(path.join(root, file.path), file.text);
    }
  }
  return load(root);
}

const bodyOf = (input: DefineAgentInput): unknown =>
  AgentVersionBodySchema.parse(toAgentVersionBody(defineAgent(input)));

describe('printAgentProject text that needs escaping', () => {
  const texts = [
    "it's",
    'say "hi"',
    `both ' and "`,
    'a`b ${x}',
    'line\nbreak\r\nand\ttab',
    'back\\slash',
    '日本語 ✓ 😀',
    ' \ufeff\u0085\u0000',
    'word '.repeat(30).trim(),
  ];

  it(
    'loads back unchanged as instructions and as a model id',
    async () => {
      const inputs = texts.map((text, index) => ({
        name: `t${String(index)}`,
        instructions: text,
        model: { connection: 'default', id: text },
      }));
      const loaded = await loadPrinted(inputs);
      expect(loaded.agents.map((agent) => agent.body)).toStrictEqual(inputs.map(bodyOf));
    },
    LOAD_TIMEOUT_MS,
  );
});

/** Recorded so a failure replays; the SDK's printer property test uses the same seed. */
const SEED = 20_261_025;
const RUNS = 200;

const name = fc.stringMatching(/^[a-z][a-z0-9]{0,10}(-[a-z0-9]{1,6}){0,2}$/u);
const text = fc.string({ minLength: 1, maxLength: 160, unit: 'binary' });
const grantPath = fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,12}(\/[a-z0-9_-]{1,12}){0,8}$/u);

/** Settings the engines accept, one or more per engine (the catalogue's own keys). */
const engine = fc.constantFrom<NonNullable<DefineAgentInput['engine']>>(
  'claude-agent-sdk',
  'openai-agents',
  'pi',
  'mastra',
  { id: 'claude-agent-sdk', handoff: true },
  { id: 'openai-agents', reasoningEffort: 'high' },
  { id: 'pi', thinkingLevel: 'low' },
  { id: 'mastra', toolCallConcurrency: 4 },
);

const limits = fc.record(
  {
    maxTurns: fc.integer({ min: 1, max: 1000 }),
    maxBudgetUsd: fc.double({ min: 0.01, max: 1000, noNaN: true }),
  },
  { requiredKeys: [] },
);

const agentInput = fc
  .record({
    name,
    instructions: text,
    description: fc.option(text, { nil: undefined }),
    model: fc.option(fc.record({ connection: fc.constant('default'), id: text }), {
      nil: undefined,
    }),
    engine: fc.option(engine, { nil: undefined }),
    permissions: fc.option(
      fc.record({ readFiles: fc.boolean(), writeFiles: fc.boolean(), runCommands: fc.boolean() }),
      { nil: undefined },
    ),
    limits: fc.option(limits, { nil: undefined }),
    connectors: fc.uniqueArray(fc.constantFrom(...CONNECTORS), { maxLength: CONNECTORS.length }),
    catalogTools: fc.subarray(['orders', 'ledger'] as const),
    searched: fc.array(fc.boolean(), { maxLength: CONNECTORS.length }),
    knowledgePaths: fc.array(fc.uniqueArray(grantPath, { minLength: 1, maxLength: 3 }), {
      maxLength: 2,
    }),
    subagents: fc.uniqueArray(name, { maxLength: 2 }),
    skills: fc.uniqueArray(
      fc.record({
        name,
        revision: fc.option(fc.integer({ min: 1, max: 99_999 }), { nil: undefined }),
      }),
      { maxLength: 3, selector: (entry) => entry.name },
    ),
    grants: fc.uniqueArray(
      fc.record({ path: grantPath, access: fc.constantFrom('read', 'read-write') }),
      { maxLength: 3, selector: (entry) => entry.path },
    ),
  })
  .map(
    ({
      connectors,
      catalogTools,
      searched,
      knowledgePaths,
      subagents,
      skills,
      grants,
      ...rest
    }): { readonly agent: DefineAgentInput; readonly children: readonly DefineAgentInput[] } => {
      const names = subagents.filter((child) => child !== rest.name);
      const knowledge = [
        ...knowledgePaths.map((paths) => ({ kind: 'files' as const, paths })),
        ...connectors
          .filter((_, index) => searched[index] === true)
          .map((connector) => ({
            kind: 'connector' as const,
            name: connector,
          })),
      ];
      return {
        agent: {
          ...rest,
          ...(names.length === 0 ? {} : { subagents: names }),
          ...(knowledge.length === 0 ? {} : { knowledge }),
          tools: [
            ...connectors.map((connector) => mcp(connector)),
            ...catalogTools.map((tool) => catalog[tool]),
          ],
          skills: skills.map((entry) =>
            skill(entry.name, entry.revision === undefined ? {} : { revision: entry.revision }),
          ),
          files: grants.map((grant) => files(grant.path, grant.access)),
        },
        children: names.map((child) => ({ name: child, instructions: `${child} helps.` })),
      };
    },
  );

function byName(values: readonly unknown[]): unknown[] {
  const nameOf = (value: unknown) => AgentVersionBodySchema.parse(value).definition.agent.name;
  return [...values].sort((left, right) => (nameOf(left) < nameOf(right) ? -1 : 1));
}

describe('printAgentProject on generated agents', () => {
  it(
    `loads back to the same body (${String(RUNS)} runs, seed ${String(SEED)})`,
    async () => {
      await fc.assert(
        fc.asyncProperty(agentInput, async ({ agent, children }) => {
          const loaded = await loadPrinted([agent, ...children]);
          // The loader answers the agents in file order; the bodies are compared by agent name.
          expect(byName(loaded.agents.map((entry) => entry.body))).toStrictEqual(
            byName([agent, ...children].map(bodyOf)),
          );
          // The loader reads a catalog tool's module only for the agents that use it.
          const used = (agent.tools ?? []).flatMap((tool) => ('name' in tool ? [tool.name] : []));
          expect(loaded.tools.map((entry) => entry.definition.name).sort()).toStrictEqual(
            used.sort(),
          );
        }),
        { seed: SEED, numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
