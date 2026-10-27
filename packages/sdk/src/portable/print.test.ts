import { format, resolveConfig } from 'prettier';
import { describe, expect, it } from 'vitest';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';

import { DefinitionError } from '../define/errors.js';

import {
  defineAgent,
  files,
  mcp,
  skill,
  openapiTool,
  postgresTool,
  secret,
  toAgentVersionBody,
  toolModulesOf,
  type AgentVersionSource,
  type DefineAgentInput,
} from '../define/index.js';
import { PrintError, printAgentProject, type PrintedFile } from './index.js';

// the repository's prettier config, found from this file (the SDK imports no Node.js module)
const CONFIG_FROM = new URL('../../../../package.json', import.meta.url).pathname;

async function expectPrettierClean(file: PrintedFile): Promise<void> {
  const options = await resolveConfig(CONFIG_FROM);
  expect(await format(file.text, { ...options, filepath: file.path })).toBe(file.text);
}

const hub = { url: 'https://hub.example.test/mcp' };
const ledger = postgresTool({
  name: 'ledger',
  url: secret('LEDGER_URL'),
  tables: ['public.entries'],
  readOnly: true,
});

function sourceOf(
  input: Partial<DefineAgentInput>,
  rest: Partial<AgentVersionSource> = {},
): AgentVersionSource {
  const agent = defineAgent({ name: 'helper', instructions: 'Help.', ...input });
  return { body: AgentVersionBodySchema.parse(toAgentVersionBody(agent)), ...rest };
}

function refusal(run: () => unknown): PrintError {
  try {
    run();
  } catch (error) {
    if (error instanceof PrintError) return error;
    throw error;
  }
  throw new Error('did not throw');
}

describe('printAgentProject', () => {
  it.each(['../evil', 'Evil', 'a'.repeat(65), 'a/b'])('refuses the agent name %s', (name) => {
    const source = sourceOf({});
    const { definition } = source.body;
    const body = {
      ...source.body,
      definition: { ...definition, agent: { ...definition.agent, name } },
    };
    expect(() => printAgentProject({ body })).toThrow(DefinitionError);
  });

  it('names aw-dev-tools, a code tool that is not printed yet', () => {
    const source = sourceOf({});
    const { resources } = source.body.definition;
    const body = AgentVersionBodySchema.parse({
      ...source.body,
      definition: {
        ...source.body.definition,
        resources: { ...resources, connectors: ['aw-dev-tools'] },
      },
    });
    expect(refusal(() => printAgentProject({ body })).paths).toStrictEqual([
      'definition.resources.connectors.0',
    ]);
  });

  it.each(['../tools/ledger.ts', 'tools\\..\\..\\evil.ts', 'tools/%2e%2e/%2e%2e/evil.ts'])(
    'refuses the module path %s, which leaves the project',
    (path) => {
      const modules = toolModulesOf([{ path, namespace: { ledger } }]);
      const error = refusal(() =>
        printAgentProject(sourceOf({ tools: [ledger] }, { toolModules: modules })),
      );
      expect(error.paths).toStrictEqual([`toolModules.${path}`]);
    },
  );

  it('imports module tools by name, by default and aliased on a clash, and returns the connectors', async () => {
    const mine = openapiTool({ name: 'my-crm', spec: 'apis/a.json', allow: ['GET /x'] });
    const first = openapiTool({ name: 'crm', spec: 'apis/b.json', allow: ['GET /x'] });
    const second = openapiTool({ name: 'crm2', spec: 'apis/c.json', allow: ['GET /x'] });
    const reserved = openapiTool({ name: 'pub', spec: 'apis/d.json', allow: ['GET /x'] });
    const toolModules = toolModulesOf([
      { path: 'tools/a.ts', namespace: { default: mine, files: ledger, public: reserved } },
      { path: 'tools/b.ts', namespace: { crm: first } },
      { path: 'tools/c.ts', namespace: { crm: second } },
    ]);
    const source = sourceOf(
      { tools: [mine, ledger, reserved, first, second, mcp('hub')], files: [files('manuals')] },
      { toolModules, project: { connectors: { hub } } },
    );

    const printed = printAgentProject(source);
    const text = printed.files[0]?.text ?? '';

    expect(printed.connectors).toStrictEqual({ hub });
    expect(text).toContain("import { defineAgent, files, mcp } from '@indx-workspace/sdk/define';");
    expect(text).toContain(
      "import myCrm, { files as filesTool, public as publicTool } from '../tools/a.ts';",
    );
    expect(text).toContain("import { crm } from '../tools/b.ts';");
    expect(text).toContain("import { crm as crmTool } from '../tools/c.ts';");
    expect(text).toContain("tools: [myCrm, filesTool, publicTool, crm, crmTool, mcp('hub')],");
    expect(text).not.toContain('openapiTool(');
    expect(printed.files[1]).toStrictEqual({ path: 'agents/helper.md', text: 'Help.' });
    await expectPrettierClean(printed.files[0] as PrintedFile);
  });
});

describe('printAgentProject line breaking and error paths', () => {
  async function printedTs(input: Partial<DefineAgentInput>): Promise<PrintedFile> {
    const printed = printAgentProject(sourceOf(input));
    const file = printed.files[0] as PrintedFile;
    await expectPrettierClean(file);
    return file;
  }

  it('breaks a files() call whose path does not fit the line', async () => {
    const grant = files(`${'manuals/'.repeat(10)}plant-a/line-3`, 'read-write');
    const { text } = await printedTs({ files: [grant] });
    expect(text).toContain(`files(\n      '${grant.path}',\n      'read-write',\n    ),`);
  });

  it('hugs the revision object of a skill() call that does not fit the line', async () => {
    const name = 'a'.repeat(64);
    const { text } = await printedTs({ skills: [skill(name, { revision: 123456789 })] });
    expect(text).toContain(`skill('${name}', {\n      revision: 123456789,\n    }),`);
  });

  it('keeps a call that fits on one line', async () => {
    const { text } = await printedTs({
      skills: [skill('triage', { revision: 2 })],
      files: [files('manuals', 'read-write')],
    });
    expect(text).toContain("skill('triage', { revision: 2 })");
    expect(text).toContain("files('manuals', 'read-write')");
  });

  it('names the body path of each connector that no module and no project supplies', () => {
    const tools = [mcp('one'), mcp('two'), mcp('three'), mcp('four')];
    const error = refusal(() =>
      printAgentProject(sourceOf({ tools }, { project: { connectors: { one: hub, three: hub } } })),
    );
    expect(error.paths).toStrictEqual([
      'definition.resources.connectors.1',
      'definition.resources.connectors.3',
    ]);
  });
});

describe('printAgentProject imports', () => {
  it('breaks an import that does not fit on one line, one name per line', async () => {
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf'].map(
      (name) => `${name}CustomerRecords`,
    );
    const tools = names.map((name) =>
      openapiTool({ name, spec: 'apis/a.json', allow: ['GET /x'] }),
    );
    const toolModules = toolModulesOf([
      {
        path: 'tools/many.ts',
        namespace: Object.fromEntries(names.map((name, index) => [name, tools[index]])),
      },
    ]);

    const printed = printAgentProject(sourceOf({ tools }, { toolModules }));
    const text = printed.files[0]?.text ?? '';

    expect(text).toContain(`import {\n  ${names.join(',\n  ')},\n} from '../tools/many.ts';`);
    await expectPrettierClean(printed.files[0] as PrintedFile);
  });
});
