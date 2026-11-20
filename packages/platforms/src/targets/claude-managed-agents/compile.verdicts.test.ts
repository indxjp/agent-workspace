import type { FieldVerdict } from '@indx-workspace/contracts/platforms';
import { describe, expect, it } from 'vitest';

import {
  agentFrontmatter,
  compiled,
  rootOf,
  sample,
  verdictOf,
  withNetworking,
  withRoot,
} from '../../testing/claude-managed-agents-compile.test-support.js';

describe('claude-managed-agents verdicts', () => {
  it('covers every row of the mapping table on the sample', () => {
    const { report } = compiled(sample);
    const at = (path: string): FieldVerdict => verdictOf(report, path);
    expect(at('support-triage.tools.0').verdict).toBe('mapped');
    expect(at('support-triage.tools.1').code).toBe('stdio_mcp_unsupported');
    expect(at('support-triage.tools.2').verdict).toBe('mapped');
    expect(at('support-triage.tools.3').code).toBe('field_unsupported');
    expect(at('support-triage.tools.4')).toMatchObject({ verdict: 'native' });
    expect(at('support-triage.tools.4').note).toContain('allowed_hosts');
    expect(at('support-triage.tools.5').verdict).toBe('mapped');
    expect(at('support-triage.knowledge.0').code).toBe('knowledge_unsupported');
    expect(at('support-triage.knowledge.1').code).toBe('knowledge_unsupported');
    expect(at('support-triage.limits.maxTurns').code).toBe('limits_unsupported');
    expect(at('support-triage.limits.maxBudgetUsd').code).toBe('limits_unsupported');
    expect(at('support-triage.permissions.unrestrictedNetwork').verdict).toBe('mapped');
    expect(at('support-triage.subagents.0').verdict).toBe('mapped');
    expect(at('support-triage.skills.0').verdict).toBe('native');
    expect(at('toolEndpoint').verdict).toBe('mapped');
  });

  it('reports sse as mapped, web_fetch as native, file_access as mapped and a connector as dropped', () => {
    const root = rootOf(sample);
    const project = withRoot({
      tools: [
        { kind: 'mcp', name: 'legacy', transport: 'sse', url: 'https://mcp.example.com/sse' },
        { kind: 'builtin', id: 'web_fetch' },
        { kind: 'builtin', id: 'file_access' },
      ],
      knowledge: [{ kind: 'connector', name: 'sharepoint' }],
      engine: root.engine,
    });
    const { files, report } = compiled(project);
    expect(verdictOf(report, 'support-triage.tools.0').verdict).toBe('mapped');
    expect(verdictOf(report, 'support-triage.tools.1').verdict).toBe('native');
    expect(verdictOf(report, 'support-triage.tools.2').verdict).toBe('mapped');
    expect(verdictOf(report, 'support-triage.knowledge.0')).toMatchObject({
      verdict: 'dropped',
      code: 'knowledge_unsupported',
    });
    const servers = agentFrontmatter(files, 'support-triage')['mcp_servers'];
    expect(servers).toEqual([{ type: 'url', name: 'legacy', url: 'https://mcp.example.com/sse' }]);
  });

  it('maps the own platform block, drops the others and drops engine settings', () => {
    const project = withRoot({
      engine: 'claude-agent-sdk',
      extensions: {
        engines: { 'claude-agent-sdk': { effort: 'high' } },
        platforms: { 'claude-managed-agents': {}, 'copilot-studio': {} },
      },
    });
    const { report } = compiled(project);
    expect(verdictOf(report, 'support-triage.engine').code).toBe('field_unsupported');
    expect(verdictOf(report, 'support-triage.extensions.engines.claude-agent-sdk').code).toBe(
      'field_unsupported',
    );
    expect(
      verdictOf(report, 'support-triage.extensions.platforms.claude-managed-agents'),
    ).toMatchObject({
      verdict: 'mapped',
    });
    expect(verdictOf(report, 'support-triage.extensions.platforms.copilot-studio').code).toBe(
      'field_unsupported',
    );
  });

  it('reports an unused tool endpoint as dropped', () => {
    const root = rootOf(sample);
    const project = withRoot({ tools: root.tools.filter((tool) => tool.kind !== 'code') });
    expect(verdictOf(compiled(project).report, 'toolEndpoint')).toMatchObject({
      verdict: 'dropped',
      code: 'field_unsupported',
    });
  });
});

describe('claude-managed-agents networking verdicts', () => {
  it('drops unrestricted networking on a subagent under a limited root', () => {
    const { report } = compiled(withNetworking(false, true));
    expect(verdictOf(report, 'billing-specialist.permissions.unrestrictedNetwork')).toMatchObject({
      verdict: 'dropped',
      code: 'permissions_unsupported',
    });
  });

  it('maps a limited subagent under an unrestricted root and names the widening', () => {
    const { report } = compiled(withNetworking(true, false));
    expect(verdictOf(report, 'billing-specialist.permissions.unrestrictedNetwork')).toMatchObject({
      verdict: 'mapped',
      note: "The sandbox is shared; this agent gets the root agent's unrestricted networking",
    });
  });
});
