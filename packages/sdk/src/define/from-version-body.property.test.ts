/**
 * Property test for `agentFromVersionBody()`: for any agent in the printable subset of
 * `DefineAgentInput`, converting its body back and writing that agent's body again gives the same
 * body with no drops, and the tool definitions are unchanged. The seed is fixed so a CI failure
 * replays: rerun with the same `SEED` and `RUNS`, or paste the counterexample fast-check prints.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';

import {
  agentFromVersionBody,
  defineAgent,
  defineTool,
  files,
  isCodeTool,
  mcp,
  openapiTool,
  postgresTool,
  secret,
  skill,
  toAgentVersionBody,
  toolDefinitionsOf,
  toolModulesOf,
  z,
  type DefineAgentInput,
  type CodeTool,
  type DefineTool,
} from './index.js';

const SEED = 1855;
const RUNS = 200;

const name = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/u);
const secretName = fc.constantFrom('TOKEN_ONE', 'TOKEN_TWO', 'DB_URL');

const tricky = fc.constantFrom(
  'He said "hi"',
  "it's `code`",
  '${process.env.HOME}',
  '`${x}`',
  'line one\nline two\r\n\ttabbed',
  'back\\slash \\n',
  'é 日本語 😀   \u0000',
  '</script> <!-- -->',
);
const text = fc.oneof(
  tricky,
  fc.array(tricky, { minLength: 1, maxLength: 4 }).map((parts) => parts.join(' ')),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 120 }),
);

type ToolSpec = {
  readonly name: string;
  readonly kind: 'mcp' | 'openapi' | 'postgres' | 'code';
  readonly flag: boolean;
  readonly secrets: readonly string[];
  readonly text: string;
};

const toolSpec = fc.record({
  name,
  kind: fc.constantFrom('mcp', 'openapi', 'postgres', 'code'),
  flag: fc.boolean(),
  secrets: fc.uniqueArray(secretName, { maxLength: 2 }),
  text,
});

function toolOf(spec: ToolSpec): DefineTool {
  const [first] = spec.secrets;
  switch (spec.kind) {
    case 'mcp':
      return mcp(spec.name);
    case 'openapi':
      return openapiTool({
        name: spec.name,
        spec: `apis/${spec.name}.json`,
        allow: ['GET /items/*', 'operationId:update'],
        ...(spec.flag && first !== undefined ? { auth: secret(first) } : {}),
        ...(spec.flag ? { baseUrl: 'https://api.example.test/v1' } : {}),
        ...(first === undefined ? {} : { identity: secret(first) }),
      });
    case 'postgres':
      return postgresTool({
        name: spec.name,
        url: secret(first ?? 'DB_URL'),
        readOnly: true,
        tables: ['public.orders', 'public.customers'],
        ...(spec.flag ? { maxRows: 50 } : {}),
      });
    case 'code':
      return defineTool({
        name: spec.name,
        description: spec.text,
        input: z.object({ id: z.string(), count: z.number().optional() }),
        run: `./${spec.name}.run.ts`,
        ...(spec.flag
          ? { output: z.object({ ok: z.boolean() }), limits: { timeoutMs: 5000 } }
          : {}),
        secrets: spec.secrets.map((each) => secret(each)),
        ...(spec.flag ? { allowedDomains: ['api.example.test', '*.example.org'] } : {}),
      });
  }
}

const paths = ['inbox', 'manuals', 'shared/reports', 'archive'];

const input = fc
  .record({
    agentName: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 _.-]{0,30}$/u),
    description: fc.option(text, { nil: undefined }),
    instructions: text,
    tools: fc.uniqueArray(toolSpec, { selector: (each) => each.name, maxLength: 8 }),
    grants: fc.uniqueArray(
      fc.record({ path: fc.constantFrom(...paths), access: fc.constantFrom('read', 'read-write') }),
      { selector: (each) => each.path, maxLength: 4 },
    ),
    knowledgePaths: fc.subarray(paths, { minLength: 0, maxLength: 3 }),
    knowledgeConnector: fc.boolean(),
    skills: fc.uniqueArray(
      fc.record({
        name: fc.constantFrom('triage', 'summarize', 'extract'),
        revision: fc.option(fc.integer({ min: 1, max: 9 }), { nil: undefined }),
      }),
      { selector: (each) => each.name, maxLength: 3 },
    ),
    subagents: fc.option(fc.uniqueArray(name, { maxLength: 3 }), { nil: undefined }),
    model: fc.constantFrom<DefineAgentInput['model']>(
      undefined,
      'default',
      'azure',
      { connection: 'azure' },
      { connection: 'azure', id: 'gpt-x' },
    ),
    permissions: fc.record(
      {
        readFiles: fc.boolean(),
        writeFiles: fc.boolean(),
        runCommands: fc.boolean(),
        unrestrictedNetwork: fc.boolean(),
      },
      { requiredKeys: [] },
    ),
    engine: fc.constantFrom('default', 'claude-settings', 'openai'),
    limits: fc.option(
      fc.record(
        {
          maxTurns: fc.integer({ min: 1, max: 200 }),
          maxBudgetUsd: fc.double({ min: 0.01, max: 500, noNaN: true }),
        },
        { requiredKeys: [] },
      ),
      { nil: undefined },
    ),
  })
  .map((each): { definition: DefineAgentInput; mcpNames: string[] } => {
    const tools = each.tools.map(toolOf);
    const mcpNames = each.tools.filter(({ kind }) => kind === 'mcp').map((tool) => tool.name);
    const permissions = each.permissions;
    const knowledge: NonNullable<DefineAgentInput['knowledge']> = [
      ...(each.knowledgePaths.length === 0
        ? []
        : [{ kind: 'files' as const, paths: each.knowledgePaths }]),
      ...(each.knowledgeConnector && mcpNames[0] !== undefined
        ? [{ kind: 'connector' as const, name: mcpNames[0] }]
        : []),
    ];
    const engine: DefineAgentInput['engine'] =
      each.engine === 'openai'
        ? { id: 'openai-agents', reasoningEffort: 'high' }
        : each.engine === 'claude-settings'
          ? {
              id: 'claude-agent-sdk',
              handoff: true,
              ...(permissions.runCommands === true ? { autoApprove: ['Bash(node:*)'] } : {}),
            }
          : undefined;
    return {
      mcpNames,
      definition: {
        name: each.agentName,
        ...(each.description === undefined ? {} : { description: each.description }),
        ...(each.subagents === undefined ? {} : { subagents: each.subagents }),
        ...(knowledge.length === 0 ? {} : { knowledge }),
        instructions: each.instructions,
        ...(each.model === undefined ? {} : { model: each.model }),
        ...(engine === undefined ? {} : { engine }),
        permissions,
        tools,
        skills: each.skills.map(({ name: skillName, revision }) =>
          skill(skillName, revision === undefined ? {} : { revision }),
        ),
        files: each.grants.map(({ path, access }) => files(path, access)),
        ...(each.limits === undefined ? {} : { limits: each.limits }),
      },
    };
  });

/** The bundle aw pins for a code tool (`pinnedOf` in packages/aw), as a body carries it. */
const bundleOf = (tool: CodeTool) => ({
  tool: tool.name,
  digest: 'b'.repeat(64),
  description: tool.description,
  inputSchema: tool.inputSchema,
  ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  timeoutMs: tool.limits.timeoutMs,
  ...(tool.secrets === undefined ? {} : { secrets: tool.secrets }),
  ...(tool.allowedDomains === undefined ? {} : { allowedDomains: tool.allowedDomains }),
});

describe('agentFromVersionBody property', () => {
  it(`gives back the same body with no drops for ${RUNS} generated agents (seed ${SEED})`, () => {
    fc.assert(
      fc.property(input, ({ definition, mcpNames }) => {
        const agent = defineAgent(definition);
        const body = AgentVersionBodySchema.parse(toAgentVersionBody(agent));
        const modules = (definition.tools ?? []).flatMap((tool, index) =>
          'connector' in tool
            ? []
            : [
                {
                  path: `tools/${index}.ts`,
                  namespace: isCodeTool(tool) && index % 2 === 0 ? { default: tool } : { tool },
                },
              ],
        );

        const { value, dropped } = agentFromVersionBody({
          body,
          project: {
            connectors: Object.fromEntries(
              mcpNames.map((n) => [n, { url: `https://${n}.example.test/mcp` }]),
            ),
          },
          toolModules: toolModulesOf(modules),
          codeToolNames: (definition.tools ?? []).filter(isCodeTool).map((tool) => tool.name),
        });

        expect(dropped).toStrictEqual([]);
        expect(AgentVersionBodySchema.parse(toAgentVersionBody(value.agent))).toStrictEqual(body);
        expect(toolDefinitionsOf(value.agent)).toStrictEqual(toolDefinitionsOf(agent));
        // Code tools are expanded where the first one stood, so only their set is compared.
        const codeTools = (tools: readonly DefineTool[] | undefined) =>
          (tools ?? []).filter(isCodeTool).toSorted((a, b) => (a.name < b.name ? -1 : 1));
        expect(codeTools(value.agent.tools)).toStrictEqual(codeTools(agent.tools));
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });

  it(`compares the pinned bundles of the generated code tools without a drop (seed ${SEED})`, () => {
    fc.assert(
      fc.property(input, ({ definition, mcpNames }) => {
        const agent = defineAgent(definition);
        const codeTools = (definition.tools ?? []).filter(isCodeTool);
        const body = AgentVersionBodySchema.parse({
          ...toAgentVersionBody(agent),
          ...(codeTools.length === 0 ? {} : { toolBundles: codeTools.map(bundleOf) }),
        });

        const { value, dropped } = agentFromVersionBody({
          body,
          project: {
            connectors: Object.fromEntries(
              mcpNames.map((n) => [n, { url: `https://${n}.example.test/mcp` }]),
            ),
          },
          toolModules: toolModulesOf(
            (definition.tools ?? []).flatMap((tool, index) =>
              'connector' in tool ? [] : [{ path: `tools/${index}.ts`, namespace: { tool } }],
            ),
          ),
        });

        expect(dropped).toStrictEqual([]);
        expect(toolDefinitionsOf(value.agent)).toStrictEqual(toolDefinitionsOf(agent));
        expect(
          AgentVersionBodySchema.parse({
            ...toAgentVersionBody(value.agent),
            ...(body.toolBundles === undefined ? {} : { toolBundles: body.toolBundles }),
          }),
        ).toStrictEqual(body);
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });
});
