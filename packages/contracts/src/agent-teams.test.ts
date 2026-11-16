import { describe, expect, it } from 'vitest';

import {
  AGENT_TEAM_CHILD_RUNS_MAX,
  AGENT_TEAM_MEMBERS_MAX,
  AGENT_TEAM_MEMBER_NAME_MAX_LENGTH,
  AGENT_TEAM_MEMBER_TOOL_PREFIX,
  AGENT_TEAM_MODES,
  AGENT_TEAM_PROBLEM_CODES,
  AGENT_TEAM_TOOL_ERROR_CODES,
  AgentTeamListResponseSchema,
  AgentTeamNameSchema,
  AgentTeamResourceSchema,
  AgentTeamVersionListResponseSchema,
  AgentTeamVersionSchema,
  CreateAgentTeamRequestSchema,
  CreateAgentTeamVersionRequestSchema,
  defaultAgentTeamMemberName,
  isAgentTeamMemberName,
} from './agent-teams.js';
import { TOOL_NAME_MAX_LENGTH } from './tool-connectors.js';

/** A distinct, valid UUID per index, so a fixture never repeats an id by accident. */
function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

const LEAD = { agentId: uuid(1), agentVersionId: uuid(101) };

function members(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    agentId: uuid(index + 2),
    agentVersionId: uuid(index + 102),
  }));
}

const version = {
  id: uuid(900),
  teamId: uuid(800),
  workspaceId: uuid(700),
  version: 1,
  mode: 'handoff',
  lead: LEAD,
  members: [{ name: 'researcher', ...members(1)[0] }],
  createdBy: null,
  createdAt: '2026-11-01T00:00:00.000Z',
};

const team = {
  id: uuid(800),
  workspaceId: uuid(700),
  name: 'Support team',
  description: null,
  latestVersion: version,
  ownerPrincipalId: uuid(600),
  createdBy: uuid(500),
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('agent-team constants (ADR-0104 acceptance)', () => {
  it('accepts handoff only, with the limits decision 6 fixes', () => {
    expect(AGENT_TEAM_MODES).toEqual(['handoff']);
    expect(AGENT_TEAM_MEMBERS_MAX).toBe(8);
    expect(AGENT_TEAM_CHILD_RUNS_MAX).toBe(16);
    expect(AGENT_TEAM_TOOL_ERROR_CODES).toEqual([
      'team_member_limit',
      'team_member_unknown',
      'team_member_invalid_arguments',
      'team_member_forbidden',
      'team_member_refused',
      'team_member_failed',
      'team_member_cancelled',
      'team_member_paused',
      'team_member_timeout',
    ]);
    expect(AGENT_TEAM_MEMBER_TOOL_PREFIX).toBe('agent__');
  });

  it('keeps mcp__agent__<member name> within the tool-name budget', () => {
    expect(AGENT_TEAM_MEMBER_NAME_MAX_LENGTH).toBe(52);
    expect(`mcp__agent__${'a'.repeat(AGENT_TEAM_MEMBER_NAME_MAX_LENGTH)}`).toHaveLength(
      TOOL_NAME_MAX_LENGTH,
    );
  });

  it('maps each problem code to its status', () => {
    expect(AGENT_TEAM_PROBLEM_CODES).toEqual({
      invalid_agent_team_id: 400,
      agent_team_not_found: 404,
      agent_team_name_taken: 409,
      agent_team_member_invalid: 422,
      agent_team_has_no_version: 409,
    });
  });
});

describe('member names', () => {
  it('accepts a slug of at most 52 characters and nothing else', () => {
    expect(isAgentTeamMemberName('researcher')).toBe(true);
    expect(isAgentTeamMemberName('a1_b-c')).toBe(true);
    expect(isAgentTeamMemberName('a'.repeat(52))).toBe(true);
    expect(isAgentTeamMemberName('a'.repeat(53))).toBe(false);
    expect(isAgentTeamMemberName('')).toBe(false);
    expect(isAgentTeamMemberName('-lead')).toBe(false);
    expect(isAgentTeamMemberName('Researcher')).toBe(false);
    expect(isAgentTeamMemberName('two words')).toBe(false);
  });

  it("defaults to the agent's name only when that is a valid member name", () => {
    expect(defaultAgentTeamMemberName('researcher')).toBe('researcher');
    expect(defaultAgentTeamMemberName('Support Agent')).toBeNull();
    expect(defaultAgentTeamMemberName('a'.repeat(53))).toBeNull();
  });
});

describe('CreateAgentTeamVersionRequestSchema', () => {
  it('accepts 1 to 8 members', () => {
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({ lead: LEAD, members: members(1) }).success,
    ).toBe(true);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({ lead: LEAD, members: members(8) }).success,
    ).toBe(true);
  });

  it('refuses 0 and 9 members', () => {
    expect(CreateAgentTeamVersionRequestSchema.safeParse({ lead: LEAD, members: [] }).success).toBe(
      false,
    );
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({ lead: LEAD, members: members(9) }).success,
    ).toBe(false);
  });

  it('refuses an agent listed twice', () => {
    const [first] = members(1);
    const result = CreateAgentTeamVersionRequestSchema.safeParse({
      lead: LEAD,
      members: [first, { ...first, agentVersionId: uuid(300) }],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'must not repeat an agent',
    );
  });

  it('refuses the lead listed as a member', () => {
    const result = CreateAgentTeamVersionRequestSchema.safeParse({ lead: LEAD, members: [LEAD] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['members', 0, 'agentId']);
  });

  it('refuses a repeated member name and one over the length budget', () => {
    const [first, second] = members(2);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({
        lead: LEAD,
        members: [
          { ...first, name: 'same' },
          { ...second, name: 'same' },
        ],
      }).success,
    ).toBe(false);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({
        lead: LEAD,
        members: [{ ...first, name: 'a'.repeat(AGENT_TEAM_MEMBER_NAME_MAX_LENGTH + 1) }],
      }).success,
    ).toBe(false);
  });

  it('refuses unknown keys at every level, and an id that is not a UUID', () => {
    const [first] = members(1);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({
        lead: LEAD,
        members: [first],
        mode: 'switcher',
      }).success,
    ).toBe(false);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({
        lead: { ...LEAD, extra: 1 },
        members: [first],
      }).success,
    ).toBe(false);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({
        lead: LEAD,
        members: [{ ...first, toolName: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      CreateAgentTeamVersionRequestSchema.safeParse({
        lead: { ...LEAD, agentId: 'not-a-uuid' },
        members: [first],
      }).success,
    ).toBe(false);
  });
});

describe('CreateAgentTeamRequestSchema', () => {
  it('trims the name and takes an optional first version', () => {
    const parsed = CreateAgentTeamRequestSchema.parse({
      name: '  Support team ',
      version: { lead: LEAD, members: members(2) },
    });
    expect(parsed.name).toBe('Support team');
    expect(parsed.version?.members).toHaveLength(2);
  });

  it('refuses a blank or over-long name and unknown keys', () => {
    expect(CreateAgentTeamRequestSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(CreateAgentTeamRequestSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false);
    expect(
      CreateAgentTeamRequestSchema.safeParse({ name: 'ok', leadAgentId: LEAD.agentId }).success,
    ).toBe(false);
    expect(AgentTeamNameSchema.safeParse('x'.repeat(200)).success).toBe(true);
  });
});

describe('the resources', () => {
  it('round-trip a team, a version and both list pages', () => {
    expect(AgentTeamResourceSchema.parse(team)).toEqual(team);
    expect(AgentTeamVersionSchema.parse(version)).toEqual(version);
    const page = { items: [team], nextCursor: null };
    expect(AgentTeamListResponseSchema.parse(page)).toEqual(page);
    const versions = { items: [version], nextCursor: 'opaque' };
    expect(AgentTeamVersionListResponseSchema.parse(versions)).toEqual(versions);
  });

  it('refuses unknown keys and a mode other than handoff', () => {
    expect(AgentTeamResourceSchema.safeParse({ ...team, leadAgentId: LEAD.agentId }).success).toBe(
      false,
    );
    expect(AgentTeamVersionSchema.safeParse({ ...version, mode: 'switcher' }).success).toBe(false);
    expect(AgentTeamVersionSchema.safeParse({ ...version, members: [] }).success).toBe(false);
    expect(
      AgentTeamListResponseSchema.safeParse({ items: [], nextCursor: null, total: 0 }).success,
    ).toBe(false);
  });
});
