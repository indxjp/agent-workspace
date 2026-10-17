import { describe, expect, it } from 'vitest';

import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { claudeBaseToolPolicyFor } from '@indx-workspace/contracts/agents';

import {
  DefinitionError,
  defineAgent,
  defineSurface,
  files,
  mcp,
  skill,
  toAgentVersionBody,
  isDefinedAgent,
  type DefineAgentInput,
  type DefinedAgent,
  type ToAgentVersionBodyOptions,
} from './index.js';

const NO_PERMISSIONS = {
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

const MINIMAL: DefineAgentInput = { name: 'assistant', instructions: 'Answer briefly.' };

const CLAUDE_TOOLS_NONE = {
  ...claudeBaseToolPolicyFor(NO_PERMISSIONS),
  deny: [...claudeBaseToolPolicyFor(NO_PERMISSIONS).deny],
};

const NO_LIMITS = { maxTurns: null, maxBudgetUsd: null };
const NO_SKILLS = { mode: 'allowlist', names: [] };

interface Fixture {
  readonly name: string;
  readonly input: DefineAgentInput;
  readonly options?: ToAgentVersionBodyOptions;
  readonly expected: Record<string, unknown>;
}

const mainSurface = defineSurface({ name: 'main', agent: 'assistant' });
const helpSurface = defineSurface({
  name: 'help',
  agent: 'assistant',
  title: 'Help',
  theme: { colour: '#0055ff' },
  layout: 'side',
});

const FIXTURES: readonly Fixture[] = [
  {
    name: 'the minimal agent compiles on the default engine and model connection',
    input: MINIMAL,
    expected: {
      agent: {
        name: 'assistant',
        instructions: 'Answer briefly.',
        permissions: NO_PERMISSIONS,
        model: null,
        modelConnectionName: 'default',
        runtimeProfileName: null,
      },
      policySource: 'compiled',
      policy: {
        engine: 'claude-agent-sdk',
        tools: CLAUDE_TOOLS_NONE,
        skills: NO_SKILLS,
        limits: NO_LIMITS,
      },
      resources: { files: [], skills: [], connectors: [] },
    },
  },
  {
    name: "model 'default' is the connection named default",
    input: { ...MINIMAL, model: 'default' },
    expected: { agent: { modelConnectionName: 'default', model: null } },
  },
  {
    name: 'a model string names a connection',
    input: { ...MINIMAL, model: 'anthropic-prod' },
    expected: { agent: { modelConnectionName: 'anthropic-prod', model: null } },
  },
  {
    name: 'a model object names a connection and a model',
    input: { ...MINIMAL, model: { connection: 'anthropic-prod', id: 'claude-opus-4' } },
    expected: { agent: { modelConnectionName: 'anthropic-prod', model: 'claude-opus-4' } },
  },
  {
    name: 'a model object without an id uses the connection default',
    input: { ...MINIMAL, model: { connection: 'anthropic-prod' } },
    expected: { agent: { modelConnectionName: 'anthropic-prod', model: null } },
  },
  {
    name: 'tools, skills and files land in resources in author order, with the skill allowlist',
    input: {
      ...MINIMAL,
      permissions: { readFiles: true },
      tools: [mcp('github'), mcp('linear')],
      skills: [skill('summarise'), skill('triage')],
      files: [files('docs/handbook.md'), files('notes', 'read-write')],
    },
    expected: {
      agent: { permissions: { ...NO_PERMISSIONS, readFiles: true } },
      policySource: 'compiled',
      policy: {
        engine: 'claude-agent-sdk',
        tools: {
          ...claudeBaseToolPolicyFor({ ...NO_PERMISSIONS, readFiles: true }),
          deny: [...claudeBaseToolPolicyFor({ ...NO_PERMISSIONS, readFiles: true }).deny],
        },
        skills: { mode: 'allowlist', names: ['summarise', 'triage'] },
        limits: NO_LIMITS,
      },
      resources: {
        files: [
          { path: 'docs/handbook.md', access: 'read' },
          { path: 'notes', access: 'read-write' },
        ],
        skills: ['summarise', 'triage'],
        connectors: ['github', 'linear'],
      },
    },
  },
  {
    name: 'limits make a stored claude policy, with null for each limit left out',
    input: { ...MINIMAL, engine: 'claude-agent-sdk', limits: { maxTurns: 8 } },
    expected: {
      policySource: 'stored',
      policy: {
        engine: 'claude-agent-sdk',
        tools: CLAUDE_TOOLS_NONE,
        skills: NO_SKILLS,
        limits: { maxTurns: 8, maxBudgetUsd: null },
      },
    },
  },
  {
    name: 'an empty limits object gives no limit, so the claude policy still compiles',
    input: { ...MINIMAL, limits: {} },
    expected: { policySource: 'compiled', policy: { limits: NO_LIMITS } },
  },
  {
    name: 'limits that are all undefined give no limit, so the claude policy still compiles',
    input: { ...MINIMAL, limits: { maxTurns: undefined, maxBudgetUsd: undefined } },
    expected: { policySource: 'compiled', policy: { limits: NO_LIMITS } },
  },
  {
    name: 'the claude engine as an object with no settings still compiles',
    input: { ...MINIMAL, engine: { id: 'claude-agent-sdk' } },
    expected: { policySource: 'compiled', policy: { engine: 'claude-agent-sdk' } },
  },
  {
    name: 'openai-agents with no settings is stored',
    input: { ...MINIMAL, engine: 'openai-agents' },
    expected: {
      policySource: 'stored',
      policy: { engine: 'openai-agents', skills: NO_SKILLS, limits: NO_LIMITS },
    },
  },
  {
    name: 'openai-agents with settings carries them',
    input: {
      ...MINIMAL,
      engine: { id: 'openai-agents', reasoningEffort: 'high', parallelToolCalls: false },
      limits: { maxBudgetUsd: 2.5 },
    },
    expected: {
      policySource: 'stored',
      policy: {
        engine: 'openai-agents',
        reasoningEffort: 'high',
        parallelToolCalls: false,
        skills: NO_SKILLS,
        limits: { maxTurns: null, maxBudgetUsd: 2.5 },
      },
    },
  },
  {
    name: 'pi with no settings is stored',
    input: { ...MINIMAL, engine: 'pi' },
    expected: {
      policySource: 'stored',
      policy: { engine: 'pi', skills: NO_SKILLS, limits: NO_LIMITS },
    },
  },
  {
    name: 'pi with a thinking level carries it',
    input: { ...MINIMAL, engine: { id: 'pi', thinkingLevel: 'low' } },
    expected: {
      policySource: 'stored',
      policy: { engine: 'pi', thinkingLevel: 'low', skills: NO_SKILLS, limits: NO_LIMITS },
    },
  },
  {
    name: 'mastra with no settings is stored',
    input: { ...MINIMAL, engine: 'mastra' },
    expected: {
      policySource: 'stored',
      policy: { engine: 'mastra', skills: NO_SKILLS, limits: NO_LIMITS },
    },
  },
  {
    name: 'mastra with a tool-call concurrency carries it',
    input: { ...MINIMAL, engine: { id: 'mastra', toolCallConcurrency: 4 } },
    expected: {
      policySource: 'stored',
      policy: { engine: 'mastra', toolCallConcurrency: 4, skills: NO_SKILLS, limits: NO_LIMITS },
    },
  },
  {
    name: 'file instructions take the resolved text',
    input: { ...MINIMAL, instructions: { file: './instructions.md' } },
    options: { instructions: '# Assistant\n\nAnswer briefly.\n' },
    expected: { agent: { instructions: '# Assistant\n\nAnswer briefly.\n' } },
  },
  {
    name: 'no surface',
    input: MINIMAL,
    options: { surfaces: [] },
    expected: {},
  },
  {
    name: 'one surface',
    input: MINIMAL,
    options: { surfaces: [mainSurface] },
    expected: {},
  },
  {
    name: 'two surfaces',
    input: MINIMAL,
    options: { surfaces: [mainSurface, helpSurface] },
    expected: {},
  },
];

describe('toAgentVersionBody', () => {
  it.each(FIXTURES)('$name', ({ input, options, expected }) => {
    const body = toAgentVersionBody(defineAgent(input), options);

    expect(AgentVersionBodySchema.parse(body)).toStrictEqual(body);
    expect(body.definition).toMatchObject({
      apiVersion: 'agentworkspace.dev/v1',
      kind: 'AgentDefinition',
      ...expected,
    });
    expect(body.surfaces).toStrictEqual(
      (options?.surfaces ?? []).map((surface) => ({ ...surface })),
    );
  });

  it('builds exactly the policy the server compiles for a claude agent without limits', () => {
    const permissions = { ...NO_PERMISSIONS, runCommands: true };
    const body = toAgentVersionBody(
      defineAgent({ ...MINIMAL, permissions: { runCommands: true }, skills: [skill('triage')] }),
    );
    const tools = claudeBaseToolPolicyFor(permissions);

    expect(body.definition.policySource).toBe('compiled');
    expect(body.definition.policy).toStrictEqual({
      engine: 'claude-agent-sdk',
      tools: {
        base: tools.base,
        autoApprove: [...tools.autoApprove],
        deny: [...tools.deny],
        permissionMode: tools.permissionMode,
        allowDangerouslySkipPermissions: tools.allowDangerouslySkipPermissions,
      },
      skills: { mode: 'allowlist', names: ['triage'] },
      limits: { maxTurns: null, maxBudgetUsd: null },
    });
  });

  it('stores a declared autoApprove in the claude policy and leaves the rest of it as compiled', () => {
    const permissions = { ...NO_PERMISSIONS, runCommands: true };
    const body = toAgentVersionBody(
      defineAgent({
        ...MINIMAL,
        permissions: { runCommands: true },
        engine: { id: 'claude-agent-sdk', autoApprove: ['Bash', 'Bash', 'Bash(node:*)'] },
      }),
    );
    const tools = claudeBaseToolPolicyFor(permissions);

    expect(body.definition.policySource).toBe('stored');
    expect(body.definition.policy).toMatchObject({
      engine: 'claude-agent-sdk',
      tools: {
        base: tools.base,
        autoApprove: ['Bash', 'Bash(node:*)'],
        deny: [...tools.deny],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
    });
  });

  it('refuses an autoApprove rule for a tool the permissions turn off', () => {
    const issues = issuesOf(() =>
      defineAgent({
        ...MINIMAL,
        permissions: { readFiles: true },
        engine: { id: 'claude-agent-sdk', autoApprove: ['Read', 'Bash(node:*)'] },
      }),
    );

    expect(issues.map((issue) => issue.path)).toStrictEqual(['engine.autoApprove.1']);
  });

  it('refuses an autoApprove rule that is an unanchored wildcard', () => {
    const issues = issuesOf(() =>
      defineAgent({
        ...MINIMAL,
        permissions: { runCommands: true },
        engine: { id: 'claude-agent-sdk', autoApprove: ['*'] },
      }),
    );

    expect(issues.map((issue) => issue.path)).toStrictEqual(['engine.autoApprove.0']);
  });

  it('gives the same body, key order included, for the same definition', () => {
    const agent = defineAgent({ ...MINIMAL, tools: [mcp('github')] });

    expect(JSON.stringify(toAgentVersionBody(agent))).toBe(
      JSON.stringify(toAgentVersionBody(agent)),
    );
  });

  it('carries no brand into the body', () => {
    const body = toAgentVersionBody(defineAgent(MINIMAL), { surfaces: [mainSurface] });

    expect(Object.getOwnPropertySymbols(body.surfaces[0])).toStrictEqual([]);
  });
});

function issuesOf(run: () => unknown): readonly { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DefinitionError) {
      expect(error.code).toBe('invalid_definition');
      expect(error.name).toBe('DefinitionError');
      return error.issues;
    }
    throw error;
  }
  throw new Error('expected a DefinitionError');
}

/** An object carrying the define brand without having been made by `defineAgent()`. */
function forgeAgent(fields: Record<string, unknown>): DefinedAgent {
  const forged = Object.defineProperty({ ...fields }, Symbol.for('agentworkspace.dev/define'), {
    value: 'agent',
  });
  if (!isDefinedAgent(forged)) throw new Error('expected the forged brand to be recognised');
  return forged;
}

describe('toAgentVersionBody description, subagents and knowledge', () => {
  it('leaves the three keys out of a body whose agent sets none', () => {
    const body = toAgentVersionBody(defineAgent(MINIMAL));
    expect(Object.keys(body)).toStrictEqual(['definition', 'surfaces']);
  });

  it('carries them, and grants each knowledge file that is not already granted', () => {
    const agent = defineAgent({
      ...MINIMAL,
      description: 'Answers billing questions.',
      subagents: ['researcher', defineAgent({ ...MINIMAL, name: 'writer' })],
      tools: [mcp('wiki')],
      files: [files('docs/a.md', 'read-write')],
      knowledge: [
        { kind: 'files', paths: ['docs/a.md', 'docs/b.md'] },
        { kind: 'files', paths: ['docs/b.md'] },
        { kind: 'connector', name: 'wiki' },
      ],
    });
    const body = toAgentVersionBody(agent);
    expect(AgentVersionBodySchema.parse(body)).toStrictEqual(body);
    expect(body.description).toBe('Answers billing questions.');
    expect(body.subagents).toStrictEqual([{ name: 'researcher' }, { name: 'writer' }]);
    expect(body.knowledge).toStrictEqual([
      { kind: 'files', paths: ['docs/a.md', 'docs/b.md'] },
      { kind: 'files', paths: ['docs/b.md'] },
      { kind: 'connector', name: 'wiki' },
    ]);
    expect(body.definition.resources.files).toStrictEqual([
      { path: 'docs/a.md', access: 'read-write' },
      { path: 'docs/b.md', access: 'read' },
    ]);
    expect(body.definition.resources.connectors).toStrictEqual(['wiki']);
  });
});

describe('toAgentVersionBody refusals', () => {
  it.each([
    ['an unknown limit', { limits: { maxTurns: 1, maxTokens: 5 } }, ['agent.limits']],
    ['an unknown permission', { permissions: { admin: true } }, ['agent.permissions']],
    [
      'a setting on the claude engine',
      { engine: { id: 'claude-agent-sdk', tools: [] } },
      ['agent.engine'],
    ],
    [
      'an autoApprove on an engine with no tool rules',
      { engine: { id: 'pi', autoApprove: ['Bash'] } },
      ['agent.engine'],
    ],
    [
      'an autoApprove for a tool the permissions turn off',
      { engine: { id: 'claude-agent-sdk', autoApprove: ['Bash'] } },
      ['agent.engine.autoApprove.0'],
    ],
    ['an engine the SDK does not know', { engine: { id: 'langgraph' } }, ['agent.engine']],
    ['a tool not made by mcp()', { tools: [{ connector: 'raw' }] }, ['agent.tools.0']],
    [
      'an unchecked instructions file',
      { instructions: { file: '../secret.md' } },
      ['agent.instructions.file'],
    ],
  ])('refuses a forged agent with %s rather than dropping it', (_, fields, paths) => {
    const agent = forgeAgent({ ...MINIMAL, ...fields });
    const issues = issuesOf(() => toAgentVersionBody(agent));

    expect([...new Set(issues.map((issue) => issue.path))]).toStrictEqual(paths);
  });

  it('refuses an agent not made by defineAgent', () => {
    const issues = issuesOf(() =>
      toAgentVersionBody(Object.freeze({ ...defineAgent(MINIMAL) }), {}),
    );

    expect(issues).toStrictEqual([{ path: 'agent', message: 'must be made by defineAgent()' }]);
  });

  it('refuses a surface not made by defineSurface', () => {
    const issues = issuesOf(() =>
      toAgentVersionBody(defineAgent(MINIMAL), { surfaces: [{ ...mainSurface }] }),
    );

    expect(issues.map((issue) => issue.path)).toStrictEqual(['options.surfaces.0']);
  });

  it('refuses file instructions that are not resolved', () => {
    const agent = defineAgent({ ...MINIMAL, instructions: { file: './instructions.md' } });

    expect(issuesOf(() => toAgentVersionBody(agent)).map((issue) => issue.path)).toStrictEqual([
      'agent.instructions',
    ]);
  });

  it('refuses options.instructions for an agent with inline instructions', () => {
    expect(
      issuesOf(() => toAgentVersionBody(defineAgent(MINIMAL), { instructions: 'other' })).map(
        (issue) => issue.path,
      ),
    ).toStrictEqual(['options.instructions']);
  });

  it('refuses a surface that names another agent', () => {
    const other = defineSurface({ name: 'main', agent: 'someone-else' });

    expect(
      issuesOf(() => toAgentVersionBody(defineAgent(MINIMAL), { surfaces: [other] })).map(
        (issue) => issue.path,
      ),
    ).toStrictEqual(['surfaces.0.agent']);
  });

  it('refuses two surfaces of one name', () => {
    const again = defineSurface({ name: 'main', agent: 'assistant', layout: 'page' });

    expect(
      issuesOf(() =>
        toAgentVersionBody(defineAgent(MINIMAL), { surfaces: [mainSurface, again] }),
      ).map((issue) => issue.path),
    ).toStrictEqual(['surfaces.1.name']);
  });

  it('refuses resolved instructions longer than the contract allows', () => {
    const agent = defineAgent({ ...MINIMAL, instructions: { file: './long.md' } });

    expect(
      issuesOf(() => toAgentVersionBody(agent, { instructions: 'x'.repeat(100_001) })).map(
        (issue) => issue.path,
      ),
    ).toStrictEqual(['options.instructions']);
  });
});

describe('toAgentVersionBody defaultEngine (contract C12)', () => {
  it('runs an agent with no engine on the default engine, as a stored policy', () => {
    const body = toAgentVersionBody(defineAgent(MINIMAL), { defaultEngine: 'pi' });

    expect(body.definition.policy.engine).toBe('pi');
    expect(body.definition.policySource).toBe('stored');
  });

  it("lets the agent's own engine win over the default", () => {
    const agent = defineAgent({ ...MINIMAL, engine: 'openai-agents' });
    const body = toAgentVersionBody(agent, { defaultEngine: 'pi' });

    expect(body.definition.policy.engine).toBe('openai-agents');
    expect(body.definition.policySource).toBe('stored');
  });

  it('keeps the compiled policy for a claude-agent-sdk default with no limits', () => {
    const body = toAgentVersionBody(defineAgent(MINIMAL), { defaultEngine: 'claude-agent-sdk' });

    expect(body).toStrictEqual(toAgentVersionBody(defineAgent(MINIMAL)));
    expect(body.definition.policySource).toBe('compiled');
  });

  it('refuses a default engine it does not know at options.defaultEngine', () => {
    const options = { defaultEngine: 'langgraph' };
    const issues = issuesOf(() =>
      Reflect.apply(toAgentVersionBody, undefined, [defineAgent(MINIMAL), options]),
    );

    expect(issues.map((issue) => issue.path)).toStrictEqual(['options.defaultEngine']);
  });
});
