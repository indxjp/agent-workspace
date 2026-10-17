import {
  PORTABLE_AGENT_API_VERSION,
  PORTABLE_AGENT_KIND,
  PortableProjectSchema,
} from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { SAMPLE_PORTABLE_PROJECT } from '../../testing/index.js';
import {
  EjectOptionsSchema,
  agentMainSource,
  code,
  ejectAgents,
  lit,
  mapMcpTool,
  modelProvider,
  render,
  secretEnvName,
  skillFiles,
  type McpBuild,
  type McpShape,
} from './project.js';

describe('secretEnvName', () => {
  it('upper-cases and replaces every run outside [A-Z0-9] with one underscore', () => {
    expect(secretEnvName('github-token')).toBe('GITHUB_TOKEN');
    expect(secretEnvName('a.b/c')).toBe('A_B_C');
    expect(secretEnvName('a--b')).toBe('A_B');
  });
});

describe('EjectOptionsSchema', () => {
  it('accepts no options and an npm package name', () => {
    expect(EjectOptionsSchema.safeParse({}).success).toBe(true);
    expect(EjectOptionsSchema.safeParse({ packageName: '@acme/triage' }).success).toBe(true);
  });

  it('rejects a bad name, an unknown key and a name over 214 characters', () => {
    expect(EjectOptionsSchema.safeParse({ packageName: 'Bad Name' }).success).toBe(false);
    expect(EjectOptionsSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(EjectOptionsSchema.safeParse({ packageName: 'a'.repeat(215) }).success).toBe(false);
    expect(EjectOptionsSchema.safeParse({ packageName: 'a'.repeat(214) }).success).toBe(true);
  });
});

describe('ejectAgents', () => {
  it('splits the project into the root, its subagents and the agents nobody runs', () => {
    const project = PortableProjectSchema.parse({
      ...SAMPLE_PORTABLE_PROJECT,
      agents: [
        ...SAMPLE_PORTABLE_PROJECT.agents,
        {
          apiVersion: PORTABLE_AGENT_API_VERSION,
          kind: PORTABLE_AGENT_KIND,
          name: 'spare',
          instructions: '',
          permissions: SAMPLE_PORTABLE_PROJECT.agents[0]?.permissions,
        },
      ],
    });
    const agents = ejectAgents(project);
    if (!agents.ok) throw new Error('expected agents');
    expect(agents.root.name).toBe('support-triage');
    expect(agents.subagents.map((agent) => agent.name)).toEqual(['billing-specialist']);
    expect(agents.unreachable.map((agent) => agent.name)).toEqual(['spare']);
  });

  it('refuses a subagent that is not in the project', () => {
    const whole = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    const agents = ejectAgents({
      ...whole,
      agents: whole.agents.filter((agent) => agent.name !== 'billing-specialist'),
    });
    expect(agents.ok ? undefined : agents.refusal.code).toBe('platform_agent_not_found');
  });
});

describe('render', () => {
  it('writes every string as a JSON literal, so hostile text stays inside it', () => {
    const hostile = '"); process.exit(1); //`${x}`\n\\';
    expect(render({ prompt: hostile, 'odd key': [hostile] })).toBe(
      `{\n  prompt: ${lit(hostile)},\n  ${lit('odd key')}: [${lit(hostile)}],\n}`,
    );
  });

  it('writes code as it is and skips undefined entries', () => {
    expect(render({ a: code('f()'), b: undefined, c: [] })).toBe('{\n  a: f(),\n  c: [],\n}');
  });
});

describe('modelProvider', () => {
  it('takes the named provider, else infers it from the id, else gives none', () => {
    expect(modelProvider({ provider: 'openai', id: 'anything' })).toBe('openai');
    expect(modelProvider({ provider: 'azure-openai', id: 'gpt-5' })).toBeUndefined();
    expect(modelProvider({ id: 'claude-sonnet-4-6' })).toBe('anthropic');
    expect(modelProvider({ id: 'gpt-5' })).toBe('openai');
    expect(modelProvider({ id: 'o3' })).toBe('openai');
    expect(modelProvider({ id: 'gemini-3' })).toBeUndefined();
  });
});

describe('skillFiles', () => {
  it('places the files of the named skills under the directory', () => {
    const project = PortableProjectSchema.parse(SAMPLE_PORTABLE_PROJECT);
    expect(skillFiles(project, new Set(['refund-policy']), '.x').map((file) => file.path)).toEqual([
      '.x/refund-policy/SKILL.md',
    ]);
    expect(skillFiles(project, new Set(), '.x')).toEqual([]);
  });
});

describe('agentMainSource', () => {
  it('closes the agent in finally and leaves out the import block when there are none', () => {
    const source = agentMainSource([], ['console.log(agent);']);
    expect(source.startsWith('import { createAgent }')).toBe(true);
    expect(source).toContain('  console.log(agent);');
    expect(source).toMatch(/finally \{\n {2}await close\?\.\(\);/u);
  });
});

describe('mapMcpTool', () => {
  const shape: McpShape = {
    stdio: (tool, name) => `${name}:${tool.command}`,
    remote: (tool, _headers, name) => `${name}:${tool.url}`,
  };
  const build = (): McpBuild => ({
    reserved: 'code-tools',
    root: 'root',
    servers: new Map(),
    usedBy: new Map(),
    envNames: [],
  });
  const stdio = (name: string, command: string) =>
    ({ kind: 'mcp', name, transport: 'stdio', command }) as const;

  it('shares one server between agents that declare the same tool', () => {
    const state = build();
    mapMcpTool(stdio('git', 'git-mcp'), 'a.tools.0', 'a', state, shape);
    mapMcpTool(stdio('git', 'git-mcp'), 'b.tools.0', 'b', state, shape);
    expect([...state.servers.keys()]).toEqual(['git']);
    expect(state.usedBy.get('b')).toEqual(['git']);
  });

  it('renames a server whose name is taken by another definition or reserved', () => {
    const state = build();
    mapMcpTool(stdio('git', 'git-mcp'), 'a.tools.0', 'a', state, shape);
    mapMcpTool(stdio('git', 'other-mcp'), 'b.tools.0', 'b', state, shape);
    mapMcpTool(stdio('code-tools', 'x'), 'a.tools.1', 'a', state, shape);
    expect([...state.servers.keys()]).toEqual(['git', 'git-b', 'code-tools-a']);
    expect(state.servers.get('git-b')?.config).toBe('git-b:other-mcp');
  });

  it('reads the bearer secret from the environment and names it', () => {
    const state = build();
    const verdict = mapMcpTool(
      {
        kind: 'mcp',
        name: 'zendesk',
        transport: 'streamable-http',
        url: 'https://mcp.example.com/z',
        auth: { scheme: 'bearer', secretRef: 'zendesk-token' },
      },
      'a.tools.0',
      'a',
      state,
      shape,
    );
    expect(verdict.verdict).toBe('native');
    expect(state.envNames).toEqual(['ZENDESK_TOKEN']);
  });
});
