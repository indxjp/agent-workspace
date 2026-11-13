import { describe, expect, it } from 'vitest';
import {
  AGENT_POINTER_MOVES_LISTED,
  AGENT_VERSION_NUMBER_MAX,
  AgentVersionCheckResponseSchema,
  AgentVersionListResponseSchema,
  AgentVersionResourceSchema,
  CreateAgentFromVersionResponseSchema,
} from './agent-versions.js';
import { agent, resource, issuePaths } from './agent-versions.test-support.js';

describe('responses: version resource', () => {
  it('round-trips a version resource', () => {
    expect(AgentVersionResourceSchema.parse(resource)).toEqual(resource);
  });

  it('refuses a version resource numbered 0 or with an unknown key', () => {
    expect(issuePaths(AgentVersionResourceSchema.safeParse({ ...resource, number: 0 }))).toEqual([
      'number',
    ]);
    expect(
      AgentVersionResourceSchema.safeParse({ ...resource, updatedAt: resource.createdAt }).success,
    ).toBe(false);
  });

  it('refuses a version resource numbered above the PostgreSQL integer maximum', () => {
    expect(
      issuePaths(
        AgentVersionResourceSchema.safeParse({ ...resource, number: AGENT_VERSION_NUMBER_MAX + 1 }),
      ),
    ).toEqual(['number']);
  });
});

describe('responses: list round-trip', () => {
  it('round-trips the list response', () => {
    const list = {
      items: [resource],
      pointers: [
        { environment: 'local', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
        { environment: 'production', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      materialised: 1,
      evaluations: [{ version: 1, score: 0.9, passed: 9, total: 10 }],
      moves: [
        {
          environment: 'production',
          number: 1,
          reason: 'promote',
          movedByPrincipalId: 'principal-1',
          movedAt: '2026-10-02T00:00:00.000Z',
        },
        {
          environment: 'local',
          number: 1,
          reason: 'set',
          movedByPrincipalId: null,
          movedAt: '2026-10-01T00:00:00.000Z',
        },
      ],
    };
    expect(AgentVersionListResponseSchema.parse(list)).toEqual(list);
    const edited = { ...list, materialised: null };
    expect(AgentVersionListResponseSchema.parse(edited)).toEqual(edited);
  });
});

describe('responses: list moves, evaluations and materialised', () => {
  it('reads a listing without moves (an older server) as no moves, and caps them (#615)', () => {
    const list = { items: [resource], pointers: [], materialised: 1 };
    expect(AgentVersionListResponseSchema.parse(list)).toEqual({
      ...list,
      moves: [],
      evaluations: [],
    });
    const move = {
      environment: 'local',
      number: 1,
      reason: 'rollback',
      movedByPrincipalId: null,
      movedAt: '2026-10-01T00:00:00.000Z',
    };
    const tooMany = Array.from({ length: AGENT_POINTER_MOVES_LISTED + 1 }, () => move);
    expect(
      issuePaths(AgentVersionListResponseSchema.safeParse({ ...list, moves: tooMany })),
    ).toEqual(['moves']);
    expect(
      issuePaths(
        AgentVersionListResponseSchema.safeParse({ ...list, moves: [{ ...move, reason: 'push' }] }),
      ),
    ).toEqual(['moves.0.reason']);
  });

  it('refuses an evaluation with no cases, a score above 1 or an unknown key (#714)', () => {
    const list = { items: [resource], pointers: [], materialised: 1 };
    const evaluation = { version: 1, score: 0.9, passed: 9, total: 10 };
    const issues = (evaluations: unknown[]): readonly string[] =>
      issuePaths(AgentVersionListResponseSchema.safeParse({ ...list, evaluations }));
    expect(issues([{ ...evaluation, total: 0 }])).toEqual(['evaluations.0.total']);
    expect(issues([{ ...evaluation, score: 1.5 }])).toEqual(['evaluations.0.score']);
    expect(issues([{ ...evaluation, failing: [] }])).toEqual(['evaluations.0']);
    expect(issues([{ ...evaluation, version: 0 }])).toEqual(['evaluations.0.version']);
  });

  it('requires the materialised version, a number or null', () => {
    const list = { items: [resource], pointers: [], materialised: 1 };
    expect(
      issuePaths(AgentVersionListResponseSchema.safeParse({ items: [resource], pointers: [] })),
    ).toEqual(['materialised']);
    expect(
      issuePaths(AgentVersionListResponseSchema.safeParse({ ...list, materialised: 0 })),
    ).toEqual(['materialised']);
  });
});

describe('responses: list pointers', () => {
  it('refuses a list response with two pointers for one environment', () => {
    const list = {
      items: [resource],
      pointers: [
        { environment: 'local', number: 1, updatedAt: '2026-10-02T00:00:00.000Z' },
        { environment: 'local', number: 2, updatedAt: '2026-10-02T00:00:00.000Z' },
      ],
      materialised: 2,
    };
    expect(issuePaths(AgentVersionListResponseSchema.safeParse(list))).toEqual([
      'pointers.1.environment',
    ]);
  });
});

describe('responses: check and create-from-version', () => {
  it('round-trips the check response and refuses ok: false', () => {
    expect(AgentVersionCheckResponseSchema.parse({ ok: true, number: 2 })).toEqual({
      ok: true,
      number: 2,
    });
    expect(AgentVersionCheckResponseSchema.safeParse({ ok: false, number: 2 }).success).toBe(false);
    expect(AgentVersionCheckResponseSchema.safeParse({ ok: true, number: 0 }).success).toBe(false);
  });

  it('round-trips the create-from-version response', () => {
    const response = { agent, version: resource };
    expect(CreateAgentFromVersionResponseSchema.parse(response)).toEqual(response);
  });
});
