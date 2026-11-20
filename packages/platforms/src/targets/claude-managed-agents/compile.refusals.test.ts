import type { PortableProject } from '@indx-workspace/contracts/portable-agent';
import { describe, expect, it } from 'vitest';

import { compileForPlatform } from '../../compile.js';
import {
  type Tool,
  agentFrontmatter,
  compiled,
  mcp,
  refusalOf,
  rootOf,
  sample,
  withRoot,
} from '../../testing/claude-managed-agents-compile.test-support.js';
import {
  AW_TOOLS_SERVER_NAME,
  MAX_MCP_SERVERS_PER_AGENT,
  MAX_PREDEFINED_AGENTS,
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_URL_MAX_LENGTH,
  claudeManagedAgentsTarget,
} from './index.js';

describe('claude-managed-agents model refusals', () => {
  it('refuses a non-Claude model', () => {
    expect(refusalOf(withRoot({ model: { provider: 'anthropic', id: 'gpt-5' } }))).toBe(
      'platform_model_unsupported',
    );
  });

  it('refuses another provider even with a claude-* id', () => {
    expect(refusalOf(withRoot({ model: { provider: 'openai', id: 'claude-x' } }))).toBe(
      'platform_model_unsupported',
    );
  });

  it('refuses an agent with no model', () => {
    expect(refusalOf(withRoot({ model: undefined }))).toBe('platform_model_unsupported');
  });

  it('refuses a subagent with a non-Claude model', () => {
    const project: PortableProject = {
      ...sample,
      agents: sample.agents.map((agent) =>
        agent.name === 'billing-specialist' ? { ...agent, model: { id: 'gpt-5' } } : agent,
      ),
    };
    expect(refusalOf(project)).toBe('platform_model_unsupported');
  });

  it('accepts a non-Claude agent model replaced by options.model.id', () => {
    const project = withRoot({ model: { provider: 'openai', id: 'gpt-5' } });
    expect(compileForPlatform(claudeManagedAgentsTarget, project, {}).ok).toBe(false);
    const { files } = compiled(
      {
        ...project,
        agents: project.agents.map((agent) => ({ ...agent, model: { id: 'gpt-5' } })),
      },
      { model: { id: 'claude-opus-5-5' } },
    );
    expect(agentFrontmatter(files, 'support-triage')['model']).toBe('claude-opus-5-5');
    expect(agentFrontmatter(files, 'billing-specialist')['model']).toBe('claude-opus-5-5');
  });
});

describe('claude-managed-agents limit refusals', () => {
  it('refuses 21 MCP servers', () => {
    const tools = Array.from({ length: MAX_MCP_SERVERS_PER_AGENT + 1 }, (_, index) => mcp(index));
    expect(refusalOf(withRoot({ tools }))).toBe('platform_limit_exceeded');
  });

  it('counts aw-tools toward the 20 servers', () => {
    const servers = Array.from({ length: MAX_MCP_SERVERS_PER_AGENT }, (_, index) => mcp(index));
    expect(compileForPlatform(claudeManagedAgentsTarget, withRoot({ tools: servers }), {}).ok).toBe(
      true,
    );
    const code = rootOf(sample).tools.filter((tool) => tool.kind === 'code');
    expect(refusalOf(withRoot({ tools: [...servers, ...code] }))).toBe('platform_limit_exceeded');
  });

  it('refuses more than 20 subagents', () => {
    const names = Array.from({ length: MAX_PREDEFINED_AGENTS + 1 }, (_, index) => `sub-${index}`);
    const specialist = sample.agents.find((agent) => agent.name === 'billing-specialist');
    if (specialist === undefined) throw new Error('missing sample agent');
    const project: PortableProject = {
      ...withRoot({ subagents: names.map((name) => ({ name })) }),
      agents: [
        ...withRoot({ subagents: names.map((name) => ({ name })) }).agents.filter(
          (agent) => agent.name === sample.root,
        ),
        ...names.map((name) => ({ ...specialist, name })),
      ],
    };
    expect(refusalOf(project)).toBe('platform_limit_exceeded');
  });

  it('refuses a URL over the limit and a name over the limit', () => {
    const longUrl: Tool = {
      kind: 'mcp',
      name: 'long-url',
      transport: 'streamable-http',
      url: `https://mcp.example.com/${'a'.repeat(MCP_SERVER_URL_MAX_LENGTH)}`,
    };
    const longName: Tool = {
      kind: 'mcp',
      name: 'n'.repeat(MCP_SERVER_NAME_MAX_LENGTH + 1),
      transport: 'streamable-http',
      url: 'https://mcp.example.com/a',
    };
    expect(refusalOf(withRoot({ tools: [longUrl] }))).toBe('platform_limit_exceeded');
    expect(refusalOf(withRoot({ tools: [longName] }))).toBe('platform_limit_exceeded');
  });

  it('does not put a URL query or a secret in a refusal', () => {
    const result = claudeManagedAgentsTarget.compile(
      withRoot({
        tools: [
          {
            kind: 'mcp',
            name: 'long-url',
            transport: 'streamable-http',
            url: `https://mcp.example.com/${'a'.repeat(MCP_SERVER_URL_MAX_LENGTH)}?token=abc`,
            auth: { scheme: 'bearer', secretRef: 'ZENDESK_TOKEN' },
          },
        ],
      }),
      {},
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/token=abc|ZENDESK_TOKEN/u);
  });
});

describe('claude-managed-agents other refusals', () => {
  it('refuses an unknown root through compileForPlatform and an unknown subagent', () => {
    const result = compileForPlatform(claudeManagedAgentsTarget, { ...sample, root: 'nobody' }, {});
    expect(result).toMatchObject({ ok: false, refusal: { code: 'platform_agent_not_found' } });
    expect(refusalOf(withRoot({ subagents: [{ name: 'ghost' }] }))).toBe(
      'platform_agent_not_found',
    );
    expect(refusalOf({ ...sample, root: 'nobody' })).toBe('platform_agent_not_found');
  });

  it('refuses a user MCP server named aw-tools when code tools are emitted', () => {
    const code = rootOf(sample).tools.filter((tool) => tool.kind === 'code');
    const reserved: Tool = {
      kind: 'mcp',
      name: AW_TOOLS_SERVER_NAME,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/reserved',
    };
    expect(refusalOf(withRoot({ tools: [reserved, ...code] }))).toBe('platform_options_invalid');
    expect(
      compileForPlatform(claudeManagedAgentsTarget, withRoot({ tools: [reserved] }), {}).ok,
    ).toBe(true);
  });

  it('refuses an invalid option through compileForPlatform', () => {
    const result = compileForPlatform(claudeManagedAgentsTarget, sample, {
      model: { id: 'gpt-5' },
    });
    expect(result).toMatchObject({ ok: false, refusal: { code: 'platform_options_invalid' } });
    const unknown = compileForPlatform(claudeManagedAgentsTarget, sample, { colour: 'red' });
    expect(unknown).toMatchObject({ ok: false, refusal: { code: 'platform_options_invalid' } });
  });
});
