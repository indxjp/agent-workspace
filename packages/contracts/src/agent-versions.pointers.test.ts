import { describe, expect, it } from 'vitest';
import {
  AGENT_VERSION_NUMBER_MAX,
  AgentPointerMoveResponseSchema,
  CreateAgentFromVersionRequestSchema,
  PromoteAgentRequestSchema,
  RollbackAgentRequestSchema,
  SetAgentPointerRequestSchema,
  SetAgentPointerResponseSchema,
} from './agent-versions.js';
import { definition, agent, issuePaths } from './agent-versions.test-support.js';

describe('pointers: environments and versions', () => {
  it.each(['local', 'production'])('accepts the %s environment', (environment) => {
    expect(SetAgentPointerRequestSchema.parse({ environment, version: 3 })).toEqual({
      environment,
      version: 3,
    });
  });

  it('refuses environment preview', () => {
    expect(
      issuePaths(SetAgentPointerRequestSchema.safeParse({ environment: 'preview', version: 1 })),
    ).toEqual(['environment']);
  });

  it('accepts the PostgreSQL integer maximum as a version', () => {
    expect(
      SetAgentPointerRequestSchema.parse({
        environment: 'local',
        version: AGENT_VERSION_NUMBER_MAX,
      }),
    ).toEqual({ environment: 'local', version: 2_147_483_647 });
  });

  it.each([0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER])('refuses version %s', (version) => {
    expect(
      issuePaths(SetAgentPointerRequestSchema.safeParse({ environment: 'local', version })),
    ).toEqual(['version']);
  });
});

describe('pointers: expectedVersion', () => {
  it.each([undefined, null, 3, AGENT_VERSION_NUMBER_MAX])(
    'accepts expectedVersion %s (#1847)',
    (expectedVersion) => {
      const request = {
        environment: 'local',
        version: 2,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      };
      expect(SetAgentPointerRequestSchema.parse(request)).toEqual(request);
    },
  );

  it.each([0, -1, 1.5, 2_147_483_648, '3', true])('refuses expectedVersion %s (#1847)', (value) => {
    expect(
      issuePaths(
        SetAgentPointerRequestSchema.safeParse({
          environment: 'local',
          version: 2,
          expectedVersion: value,
        }),
      ),
    ).toEqual(['expectedVersion']);
  });

  it('refuses an unknown key beside expectedVersion', () => {
    expect(
      SetAgentPointerRequestSchema.safeParse({
        environment: 'local',
        version: 2,
        expectedVersion: 1,
        expected: 1,
      }).success,
    ).toBe(false);
  });

  it('round-trips the pointer response', () => {
    const response = {
      agent,
      pointer: { environment: 'local', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
    };
    expect(SetAgentPointerResponseSchema.parse(response)).toEqual(response);
  });
});

describe('CreateAgentFromVersionRequestSchema', () => {
  const version = { body: { definition }, summary: 'First version', via: 'ui' };

  it('accepts a version and an optional dryRun: true', () => {
    expect(CreateAgentFromVersionRequestSchema.safeParse({ version }).success).toBe(true);
    expect(CreateAgentFromVersionRequestSchema.safeParse({ version, dryRun: true }).success).toBe(
      true,
    );
    expect(
      issuePaths(CreateAgentFromVersionRequestSchema.safeParse({ version, dryRun: false })),
    ).toEqual(['dryRun']);
  });

  it("refuses via 'builder' in the nested version", () => {
    expect(
      issuePaths(
        CreateAgentFromVersionRequestSchema.safeParse({
          version: { ...version, via: 'builder' },
        }),
      ),
    ).toEqual(['version.via']);
  });

  it('refuses the legacy name and instructions keys', () => {
    const result = CreateAgentFromVersionRequestSchema.safeParse({
      version,
      name: 'Support triage',
      instructions: 'Answer support mail.',
    });
    if (result.success) throw new Error('expected a refusal');
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        path: [],
        keys: ['name', 'instructions'],
      }),
    ]);
  });

  it('refuses a legacy CreateAgentInput body', () => {
    expect(
      CreateAgentFromVersionRequestSchema.safeParse({
        name: 'Support triage',
        instructions: 'Answer support mail.',
        modelConnectionId: null,
        model: null,
        runtimeProfileId: null,
        permissions: definition.agent.permissions,
      }).success,
    ).toBe(false);
  });
});

describe('promote and rollback (#615)', () => {
  it('accepts an empty promote, a version and a dry run; refuses dryRun false and unknown keys', () => {
    expect(PromoteAgentRequestSchema.parse({})).toEqual({});
    expect(PromoteAgentRequestSchema.parse({ version: 3, dryRun: true })).toEqual({
      version: 3,
      dryRun: true,
    });
    expect(issuePaths(PromoteAgentRequestSchema.safeParse({ dryRun: false }))).toEqual(['dryRun']);
    expect(issuePaths(PromoteAgentRequestSchema.safeParse({ version: 0 }))).toEqual(['version']);
    expect(PromoteAgentRequestSchema.safeParse({ environment: 'production' }).success).toBe(false);
  });

  it('rolls production back by default, and refuses preview, dryRun false and unknown keys', () => {
    expect(RollbackAgentRequestSchema.parse({})).toEqual({ environment: 'production' });
    expect(RollbackAgentRequestSchema.parse({ environment: 'local', dryRun: true })).toEqual({
      environment: 'local',
      dryRun: true,
    });
    expect(issuePaths(RollbackAgentRequestSchema.safeParse({ environment: 'preview' }))).toEqual([
      'environment',
    ]);
    expect(issuePaths(RollbackAgentRequestSchema.safeParse({ dryRun: false }))).toEqual(['dryRun']);
    expect(RollbackAgentRequestSchema.safeParse({ version: 1 }).success).toBe(false);
  });

  it('answers from and to, with from null for an environment that had no pointer', () => {
    const moved = { environment: 'production', from: null, to: 7, saved: false, bar: 0.9 };
    expect(AgentPointerMoveResponseSchema.parse(moved)).toEqual(moved);
    expect(AgentPointerMoveResponseSchema.safeParse({ ...moved, extra: true }).success).toBe(false);
  });

  it('reads an older server without bar as no bar (issue #619)', () => {
    const moved = { environment: 'production', from: 6, to: 7, saved: true };
    expect(AgentPointerMoveResponseSchema.parse(moved)).toEqual({ ...moved, bar: null });
    expect(AgentPointerMoveResponseSchema.safeParse({ ...moved, bar: 1.5 }).success).toBe(false);
  });
});
