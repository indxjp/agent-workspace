/**
 * The agent-team half of the tool-connector composition (ADR-0104 acceptance decision 3, issue
 * #1517): member rules in the engine's spelling, and the lead's one `agent` server.
 */
import { AGENT_TEAM_MEMBER_NAME_MAX_LENGTH } from '@indx-workspace/contracts/agent-teams';
import { TOOL_NAME_MAX_LENGTH } from '@indx-workspace/contracts/tool-connectors';
import { describe, expect, it } from 'vitest';

import {
  AGENT_TEAM_MEMBER_SERVER_KEY,
  teamMemberServerFor,
  withMemberApprovalRules,
  withMemberToolRules,
} from './run-request-tool-connectors';

const TEAM = { url: 'https://aw.example.test/api/runs/r1/members/mcp', names: ['writer'] };

describe('withMemberToolRules and withMemberApprovalRules', () => {
  it('maps agent__<name> to mcp__agent__<name> and leaves every other rule alone', () => {
    const tools = withMemberToolRules({
      base: ['Read', 'agent__writer'],
      autoApprove: ['agent__critic', 'mcp__crm__lookup'],
      deny: ['agent__writer', 'WebFetch', 'my_agent__x'],
      permissionMode: 'default' as const,
      allowDangerouslySkipPermissions: false,
    });
    expect(tools.base).toEqual(['Read', 'mcp__agent__writer']);
    expect(tools.autoApprove).toEqual(['mcp__agent__critic', 'mcp__crm__lookup']);
    expect(tools.deny).toEqual(['mcp__agent__writer', 'WebFetch', 'my_agent__x']);
    expect(withMemberApprovalRules(['agent__writer', 'Bash'])).toEqual([
      'mcp__agent__writer',
      'Bash',
    ]);
  });

  it('keeps the preset base as it is', () => {
    const tools = withMemberToolRules({
      base: 'claude_code_preset' as const,
      autoApprove: [],
      deny: [],
      permissionMode: 'default' as const,
      allowDangerouslySkipPermissions: false,
    });
    expect(tools.base).toBe('claude_code_preset');
  });
});

describe('teamMemberServerFor', () => {
  it("serves the lead's members as one `agent` server with the run token", () => {
    expect(AGENT_TEAM_MEMBER_SERVER_KEY).toBe('agent');
    expect(
      teamMemberServerFor(TEAM, { parentRunId: null }, ['crm'], 'claude-agent-sdk', 't'),
    ).toEqual({
      agent: { type: 'http', url: TEAM.url, headers: { authorization: 'Bearer t' } },
    });
  });

  it('gives a child run and a run of no team nothing', () => {
    expect(teamMemberServerFor(TEAM, { parentRunId: 'lead' }, [], 'claude-agent-sdk', 't')).toEqual(
      {},
    );
    expect(teamMemberServerFor(null, { parentRunId: null }, [], 'claude-agent-sdk', 't')).toEqual(
      {},
    );
  });

  it('fits the longest member name and refuses one longer, or a connector already keyed agent', () => {
    const longest = 'm'.repeat(AGENT_TEAM_MEMBER_NAME_MAX_LENGTH);
    expect(`mcp__agent__${longest}`).toHaveLength(TOOL_NAME_MAX_LENGTH);
    expect(
      Object.keys(
        teamMemberServerFor({ ...TEAM, names: [longest] }, {}, [], 'claude-agent-sdk', 't'),
      ),
    ).toEqual(['agent']);
    expect(() =>
      teamMemberServerFor({ ...TEAM, names: [`${longest}x`] }, {}, [], 'claude-agent-sdk', 't'),
    ).toThrow(/connector_tool_name_collision/u);
    expect(() => teamMemberServerFor(TEAM, {}, ['agent'], 'claude-agent-sdk', 't')).toThrow(
      /connector_tool_name_collision/u,
    );
  });
});
