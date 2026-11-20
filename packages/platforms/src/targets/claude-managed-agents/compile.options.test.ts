import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  agentFrontmatter,
  compiled,
  frontmatterOf,
  rootOf,
  sample,
  text,
  verdictOf,
  withRoot,
} from '../../testing/claude-managed-agents-compile.test-support.js';
import { AGENT_TOOLSET_TYPE, CREDENTIAL_PLAN_FILE, MULTIAGENT_TYPE } from './index.js';

const GOLDEN = join(import.meta.dirname, '__golden__');

describe('claude-managed-agents toolset and environment', () => {
  const none = {
    readFiles: false,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: false,
  };

  it('emits no agent toolset when no permission or builtin tool enables a tool', () => {
    const { files } = compiled(withRoot({ permissions: none, tools: [] }));
    const frontmatter = agentFrontmatter(files, 'support-triage');
    expect(frontmatter['tools']).toBeUndefined();
    expect(JSON.stringify(frontmatter)).not.toContain(AGENT_TOOLSET_TYPE);
  });

  it('enables write and edit for writeFiles with file_access, in the fixed order', () => {
    const { files } = compiled(
      withRoot({
        permissions: { ...none, writeFiles: true },
        tools: [{ kind: 'builtin', id: 'file_access' }],
      }),
    );
    const tools = agentFrontmatter(files, 'support-triage')['tools'] as Record<string, unknown>[];
    expect(tools[0]).toEqual({
      type: AGENT_TOOLSET_TYPE,
      default_config: { enabled: false },
      configs: ['read', 'write', 'edit', 'glob', 'grep'].map((name) => ({ name, enabled: true })),
    });
  });

  it('uses unrestricted networking without allow_mcp_servers', () => {
    const { files } = compiled(
      withRoot({ permissions: { ...rootOf(sample).permissions, unrestrictedNetwork: true } }),
    );
    const environment = parse(text(files, 'environments/default.yaml')) as {
      config: { networking: Record<string, unknown> };
    };
    expect(environment.config.networking).toEqual({ type: 'unrestricted' });
  });

  it('limits networking, allows MCP servers and adds the allowed hosts', () => {
    const { files } = compiled(sample, { allowedHosts: ['api.example.com', '*.example.org'] });
    const environment = parse(text(files, 'environments/default.yaml')) as {
      name: string;
      config: { networking: Record<string, unknown> };
    };
    expect(environment.name).toBe('support-triage');
    expect(environment.config.networking).toEqual({
      type: 'limited',
      allowed_hosts: ['api.example.com', '*.example.org'],
      allow_mcp_servers: true,
    });
  });
});

describe('claude-managed-agents options', () => {
  it('switches to the object model form on every emitted agent', () => {
    const { files } = compiled(sample, { model: { effort: 'high', inferenceGeo: 'us' } });
    for (const name of ['support-triage', 'billing-specialist']) {
      expect(agentFrontmatter(files, name)['model']).toEqual({
        id: 'claude-sonnet-4-6',
        effort: 'high',
        inference_geo: 'us',
      });
    }
  });

  it('allows package managers when packages are set', () => {
    const { files } = compiled(sample, { packages: { pip: ['pandas'], apt: ['git'] } });
    const environment = parse(text(files, 'environments/default.yaml')) as {
      config: { packages: unknown; networking: Record<string, unknown> };
    };
    expect(environment.config.packages).toEqual({ apt: ['git'], pip: ['pandas'] });
    expect(environment.config.networking['allow_package_managers']).toBe(true);
  });

  it('writes the MCP permission policy on every mcp_toolset', () => {
    const { files } = compiled(sample, {
      mcpPermissionPolicy: 'always_allow',
      toolsetPermissionPolicy: 'auto',
    });
    const tools = agentFrontmatter(files, 'support-triage')['tools'] as Record<string, unknown>[];
    const toolsets = tools.filter((tool) => tool['type'] === 'mcp_toolset');
    expect(toolsets).toHaveLength(2);
    for (const toolset of toolsets) {
      expect(toolset['default_config']).toMatchObject({
        permission_policy: { type: 'always_allow' },
      });
    }
    expect(tools[0]?.['default_config']).toEqual({
      enabled: false,
      permission_policy: { type: 'auto' },
    });
  });
});

describe('claude-managed-agents VERIFY items (docs read 2026-10-11)', () => {
  const vendor = (...path: string[]): string =>
    readFileSync(join(GOLDEN, 'vendor-fixtures', ...path), 'utf8');

  it('VERIFY-1 still open: the relative path id is reported as mapped with the VERIFY note, not native', () => {
    const lead = frontmatterOf(vendor('multiagent', 'engineering-lead.md')) as {
      multiagent: { type: string; subagents: { predefined_agents: Record<string, unknown>[] } };
    };
    expect(lead.multiagent.type).toBe(MULTIAGENT_TYPE);
    expect(lead.multiagent.subagents.predefined_agents[0]).toMatchObject({ type: 'agent' });
    const coordinator = frontmatterOf(vendor('apply', 'agents', 'lead.md')) as {
      multiagent: { agents: string[] };
    };
    expect(coordinator.multiagent.agents).toEqual(['./reviewer.md']);
    const { files, report } = compiled(sample);
    const emitted = agentFrontmatter(files, 'support-triage') as {
      multiagent: { subagents: { predefined_agents: unknown[] } };
    };
    expect(emitted.multiagent.subagents.predefined_agents).toEqual([
      { type: 'agent', id: './billing-specialist.md' },
    ]);
    const verdict = verdictOf(report, 'support-triage.subagents.0');
    expect(verdict.verdict).toBe('mapped');
    expect(verdict.note).toContain(
      'VERIFY-1: ant apply resolving a relative file path as the agent id is not yet confirmed; see #1003',
    );
  });

  it('VERIFY-2 confirmed by the documented kind inference: the credential plan is skipped by ant apply', () => {
    const { files } = compiled(sample);
    const plan = JSON.parse(text(files, CREDENTIAL_PLAN_FILE)) as Record<string, unknown>;
    expect(plan['type']).toBeUndefined();
    expect(CREDENTIAL_PLAN_FILE).not.toContain('/');
    expect(CREDENTIAL_PLAN_FILE).not.toMatch(/^(agent|environment|memory_store|deployment)/u);
  });

  it('VERIFY-3 confirmed: an sse server is emitted as a url server, because Managed Agents falls back to SSE', () => {
    const { files } = compiled(
      withRoot({
        tools: [
          { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
        ],
      }),
    );
    expect(agentFrontmatter(files, 'support-triage')['mcp_servers']).toEqual([
      { type: 'url', name: 'legacy', url: 'https://mcp.example.com/sse' },
    ]);
  });

  it('emits the layout of the vendor apply example', () => {
    const reviewer = frontmatterOf(vendor('apply', 'agents', 'reviewer.md'));
    expect(reviewer['skills']).toEqual(['../skills/pr-summary']);
    const { files } = compiled(sample);
    expect(agentFrontmatter(files, 'billing-specialist')['skills']).toEqual([
      '../skills/refund-policy',
    ]);
    const cloud = parse(vendor('apply', 'environments', 'cloud.yaml')) as Record<string, unknown>;
    const emitted = parse(text(files, 'environments/default.yaml')) as Record<string, unknown>;
    expect(Object.keys(emitted)).toEqual(['name', 'config']);
    expect(Object.keys(cloud)).toContain('config');
  });
});
