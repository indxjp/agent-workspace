import { describe, expect, it } from 'vitest';

import {
  AgentVersionBodySchema,
  type AgentVersionBody,
} from '@indx-workspace/contracts/agent-versions';

import {
  DefinitionError,
  agentFromVersionBody,
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
} from './index.js';

const crm = openapiTool({ name: 'crm', spec: 'apis/crm.json', allow: ['GET /customers/*'] });
const ledger = postgresTool({
  name: 'ledger',
  url: secret('LEDGER_URL'),
  tables: ['public.entries'],
  readOnly: true,
});
const modules = toolModulesOf([{ path: 'tools/crm.ts', namespace: { crm, ledger } }]);
const connectors = { hub: { url: 'https://hub.example.test/mcp' } };

function convert(
  input: Partial<DefineAgentInput>,
  overrides?: (body: AgentVersionBody) => unknown,
) {
  const agent = defineAgent({ name: 'helper', instructions: 'Help.', ...input });
  const body = toAgentVersionBody(agent);
  return agentFromVersionBody({
    body: AgentVersionBodySchema.parse(overrides?.(body) ?? body),
    project: { connectors },
    toolModules: modules,
  });
}

describe('agentFromVersionBody', () => {
  it('writes every grant out, including one knowledge implied and a read-write one', () => {
    const { value, dropped } = convert({
      files: [files('inbox', 'read-write')],
      knowledge: [{ kind: 'files', paths: ['inbox', 'manuals'] }],
    });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.files).toStrictEqual([
      files('inbox', 'read-write'),
      files('manuals', 'read'),
    ]);
  });

  it('takes module tools as the exact value and mcp tools from the project', () => {
    const { value, dropped } = convert({ tools: [mcp('hub'), crm, ledger] });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.tools).toStrictEqual([mcp('hub'), crm, ledger]);
    expect(value.imports).toStrictEqual([
      { kind: 'openapi', name: 'crm', module: 'tools/crm.ts', exportName: 'crm' },
      { kind: 'postgres', name: 'ledger', module: 'tools/crm.ts', exportName: 'ledger' },
    ]);
    expect(value.connectors).toStrictEqual(connectors);
  });

  it('drops a name nothing resolves at its index, without dropping the tools after it', () => {
    const { value, dropped } = convert({ tools: [mcp('hub'), mcp('nowhere'), crm] });
    expect(dropped.map(({ path }) => path)).toStrictEqual(['definition.resources.connectors.1']);
    expect(dropped[0]?.reason).toContain('nowhere');
    expect(value.agent.tools).toStrictEqual([mcp('hub'), crm]);
  });

  it('drops a knowledge connector whose mcp() tool was dropped, instead of throwing', () => {
    const { value, dropped } = agentFromVersionBody({
      body: toAgentVersionBody(
        defineAgent({
          name: 'helper',
          instructions: 'Help.',
          tools: [mcp('hub')],
          knowledge: [{ kind: 'connector', name: 'hub' }],
        }),
      ),
      project: { connectors: {} },
    });
    const paths = dropped.map(({ path }) => path);
    expect(paths).toContain('definition.resources.connectors.0');
    expect(paths.some((path) => path === 'knowledge.0' || path.startsWith('knowledge.0.'))).toBe(
      true,
    );
    expect(value.agent.knowledge ?? []).toStrictEqual([]);
  });

  it('drops an inline tool, which looks like a name no module supplies', () => {
    const { value, dropped } = agentFromVersionBody({
      body: toAgentVersionBody(
        defineAgent({ name: 'helper', instructions: 'Help.', tools: [crm] }),
      ),
    });
    expect(dropped.map(({ path }) => path)).toStrictEqual(['definition.resources.connectors.0']);
    expect(dropped[0]?.reason).toContain('declare it in a module under tools/');
    expect(value.agent.tools ?? []).toStrictEqual([]);
  });

  it('drops a stored autoApprove rule for a tool the permissions deny, instead of throwing', () => {
    const { value, dropped } = convert({}, (body) => {
      if (!('tools' in body.definition.policy)) throw new Error('expected a tool policy');
      return {
        ...body,
        definition: {
          ...body.definition,
          policy: {
            ...body.definition.policy,
            tools: { ...body.definition.policy.tools, autoApprove: ['Bash', 'WebFetch'] },
          },
        },
      };
    });
    expect(dropped.map(({ path }) => path)).toContain('definition.policy.tools.autoApprove.0');
    expect(value.agent).toBeDefined();
  });

  it('drops a name that is both a module tool and a connector', () => {
    const { dropped } = agentFromVersionBody({
      body: toAgentVersionBody(
        defineAgent({ name: 'helper', instructions: 'Help.', tools: [crm] }),
      ),
      project: { connectors: { crm: connectors.hub } },
      toolModules: modules,
    });
    expect(dropped.map(({ path }) => path)).toStrictEqual(['definition.resources.connectors.0']);
    expect(dropped[0]?.reason).toContain('SD1');
  });

  it('keeps an engine other than the project default, and a withholding engine with its settings', () => {
    const engine = { id: 'openai-agents', reasoningEffort: 'high' } as const;
    const { value, dropped } = convert({ engine, model: { connection: 'azure', id: 'gpt-x' } });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.engine).toStrictEqual(engine);
    expect(value.agent.model).toStrictEqual({ connection: 'azure', id: 'gpt-x' });
  });

  it('keeps skill revisions, subagents and limits', () => {
    const { value, dropped } = convert({
      skills: [skill('cite', { revision: 2 }), skill('plain')],
      subagents: ['reviewer'],
      limits: { maxTurns: 5 },
    });
    expect(dropped).toStrictEqual([]);
    expect(value.agent.skills).toStrictEqual([skill('cite', { revision: 2 }), skill('plain')]);
    expect(value.agent.subagents).toStrictEqual(['reviewer']);
    expect(value.agent.limits).toStrictEqual({ maxTurns: 5 });
  });

  describe('self-check', () => {
    it('reports a runtimeProfileName defineAgent() cannot write, at its path', () => {
      const { dropped } = convert({}, (body) => ({
        ...body,
        definition: {
          ...body.definition,
          agent: { ...body.definition.agent, runtimeProfileName: 'gpu' },
        },
      }));
      expect(dropped).toStrictEqual([
        {
          path: 'definition.agent.runtimeProfileName',
          reason:
            'the runtime profile "gpu" is an Agent Workspace resource defineAgent() cannot name; switch it with aw agents update',
        },
      ]);
    });

    it('reports a narrowed skill allowlist', () => {
      const { dropped } = convert({ skills: [skill('a'), skill('b')] }, (body) => ({
        ...body,
        definition: {
          ...body.definition,
          policy: { ...body.definition.policy, skills: { mode: 'allowlist', names: ['a'] } },
        },
      }));
      expect(dropped.map(({ path }) => path)).toStrictEqual(['definition.policy.skills.names.1']);
      expect(dropped[0]?.reason).toBe(
        'defineAgent() writes no skill allowlist, so every assigned skill stays allowed; set the allowlist with aw agents policy set',
      );
    });

    it('reports a stored tool policy that is not the base policy plus autoApprove', () => {
      let baseDeny = 0;
      const { dropped } = convert({}, (body) => {
        if (!('tools' in body.definition.policy)) throw new Error('expected a tool policy');
        baseDeny = body.definition.policy.tools.deny.length;
        return {
          ...body,
          definition: {
            ...body.definition,
            policy: {
              ...body.definition.policy,
              tools: { ...body.definition.policy.tools, deny: ['Bash'] },
            },
          },
        };
      });
      // ['Bash'] replaces the base deny list, so every index of the longer list differs.
      expect(baseDeny).toBeGreaterThan(1);
      expect(dropped.map(({ path }) => path)).toStrictEqual(
        Array.from({ length: baseDeny }, (_, index) => `definition.policy.tools.deny.${index}`),
      );
      expect(new Set(dropped.map(({ reason }) => reason))).toStrictEqual(
        new Set([
          'defineAgent() writes the base tool policy plus engine.autoApprove only; set any other tool rule with aw agents policy set',
        ]),
      );
    });

    it('reports a surface the project does not supply', () => {
      const agent = defineAgent({ name: 'helper', instructions: 'Help.' });
      const surface = defineSurface({ name: 'desk', agent: 'helper', title: 'Desk' });
      const { dropped } = agentFromVersionBody({
        body: toAgentVersionBody(agent, { surfaces: [surface] }),
      });
      expect(dropped.map(({ path }) => path)).toStrictEqual(['surfaces.0']);
    });
  });

  it('refuses a body that is not an agent version body', () => {
    const body = AgentVersionBodySchema.parse(
      toAgentVersionBody(defineAgent({ name: 'helper', instructions: 'Help.' })),
    );
    expect(() => agentFromVersionBody({ body: Object.assign({}, body, { extra: true }) })).toThrow(
      DefinitionError,
    );
  });
});

describe('toolModulesOf', () => {
  const other = openapiTool({ name: 'crm', spec: 'apis/other.json', allow: ['GET /x'] });

  it('keeps tool exports only, sorted by path then export name', () => {
    const exported = toolModulesOf([
      { path: 'tools/b.ts', namespace: { zed: ledger, note: 'text' } },
      { path: 'tools/a.ts', namespace: { second: other, first: crm, helper: () => undefined } },
    ]);
    expect(exported.map(({ module, exportName }) => `${module}#${exportName}`)).toStrictEqual([
      'tools/a.ts#first',
      'tools/a.ts#second',
      'tools/b.ts#zed',
    ]);
  });

  it('lets the first tool of a name win, and reports the one it ignored', () => {
    const { value, dropped } = agentFromVersionBody({
      body: toAgentVersionBody(
        defineAgent({ name: 'helper', instructions: 'Help.', tools: [crm] }),
      ),
      toolModules: toolModulesOf([
        { path: 'tools/b.ts', namespace: { crm: other } },
        { path: 'tools/a.ts', namespace: { crm } },
      ]),
    });
    expect(value.imports[0]?.module).toBe('tools/a.ts');
    expect(value.agent.tools).toStrictEqual([crm]);
    expect(dropped).toStrictEqual([
      {
        path: 'toolModules.1',
        reason:
          'crm: tools/b.ts#crm repeats the name of tools/a.ts#crm, which is used; rename one of them',
      },
    ]);
  });

  it('does not report the same tool exported twice, or a repeated name the body does not use', () => {
    const { dropped } = agentFromVersionBody({
      body: toAgentVersionBody(
        defineAgent({ name: 'helper', instructions: 'Help.', tools: [crm] }),
      ),
      toolModules: toolModulesOf([
        { path: 'tools/a.ts', namespace: { crm, alias: crm } },
        { path: 'tools/b.ts', namespace: { ledger } },
        {
          path: 'tools/c.ts',
          namespace: {
            ledger: postgresTool({
              name: 'ledger',
              url: secret('OTHER_URL'),
              tables: ['public.other'],
              readOnly: true,
            }),
          },
        },
      ]),
    });
    expect(dropped).toStrictEqual([]);
  });
});
