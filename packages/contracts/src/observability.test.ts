import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AgentChangedAuditDetailsSchema,
  AgentCreatedAuditDetailsSchema,
  AuditEventListResponseSchema,
  AuditEventSchema,
  RunTelemetryListResponseSchema,
  RunTelemetrySchema,
} from './observability.js';
import { RUN_STATUSES } from './runs.js';

const WORKSPACE = '44444444-4444-4444-8444-444444444444';

const telemetry = {
  runId: '33333333-3333-4333-8333-333333333333',
  workspaceId: WORKSPACE,
  agentId: '11111111-1111-4111-8111-111111111111',
  status: 'completed',
  durationMs: 4000,
  costUsd: 0.001234,
};

const event = {
  id: '77777777-7777-4777-8777-777777777777',
  workspaceId: WORKSPACE,
  actorUserId: '88888888-8888-4888-8888-888888888888',
  actorPrincipalId: '99999999-9999-4999-8999-999999999999',
  actorLabel: 'Ito',
  action: 'agent-changed',
  subjectId: '11111111-1111-4111-8111-111111111111',
  subjectLabel: 'Customer Support Agent',
  createdAt: '2026-09-21T10:00:00.000Z',
};

describe('RunTelemetrySchema', () => {
  it('accepts a settled run and one the store carried no cost for', () => {
    expect(RunTelemetrySchema.safeParse(telemetry).success).toBe(true);
    expect(
      RunTelemetrySchema.safeParse({ ...telemetry, status: 'failed', costUsd: null, durationMs: 0 })
        .success,
    ).toBe(true);
  });

  it('rejects a cost rendered as a decimal string and a status outside the run lifecycle', () => {
    expect(RunTelemetrySchema.safeParse({ ...telemetry, costUsd: '0.001234' }).success).toBe(false);
    expect(RunTelemetrySchema.safeParse({ ...telemetry, status: 'paused' }).success).toBe(false);
  });

  it('rejects an unknown key, a missing agent id, and a negative or fractional duration', () => {
    expect(RunTelemetrySchema.safeParse({ ...telemetry, prompt: 'hi' }).success).toBe(false);
    const withoutAgent = Object.fromEntries(
      Object.entries(telemetry).filter(([key]) => key !== 'agentId'),
    );
    expect(RunTelemetrySchema.safeParse(withoutAgent).success).toBe(false);
    expect(RunTelemetrySchema.safeParse({ ...telemetry, durationMs: -1 }).success).toBe(false);
    expect(RunTelemetrySchema.safeParse({ ...telemetry, durationMs: 1.5 }).success).toBe(false);
  });

  it('restates the run lifecycle rather than a vocabulary of its own', () => {
    for (const status of RUN_STATUSES) {
      expect(RunTelemetrySchema.safeParse({ ...telemetry, status }).success).toBe(true);
    }
  });
});

describe('AuditEventSchema', () => {
  it('accepts a human-attributed row and a system row with no subject', () => {
    expect(AuditEventSchema.safeParse(event).success).toBe(true);
    expect(
      AuditEventSchema.safeParse({
        ...event,
        actorUserId: null,
        actorPrincipalId: null,
        actorLabel: 'system',
        action: 'public-sharing-policy-changed',
        subjectId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an action outside the recorded set, an unknown key, and a missing label', () => {
    expect(AuditEventSchema.safeParse({ ...event, action: 'secret-read' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, metadata: {} }).success).toBe(false);
    const withoutLabel = Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== 'subjectLabel'),
    );
    expect(AuditEventSchema.safeParse(withoutLabel).success).toBe(false);
  });

  it('rejects a blank label, a Date object, and an epoch-number timestamp', () => {
    expect(AuditEventSchema.safeParse({ ...event, actorLabel: '' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, createdAt: new Date() }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, createdAt: 1_700_000_000 }).success).toBe(false);
  });

  it('lists every action once, in the order the column restates them', () => {
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
    expect(AUDIT_ACTIONS[0]).toBe('user-created');
    expect(AUDIT_ACTIONS.at(-1)).toBe('user-token-exchanged');
  });

  it('records a new agent as agent-created, and AuditEventSchema reads it', () => {
    expect(AUDIT_ACTIONS).toContain('agent-created');
    expect(AuditEventSchema.safeParse({ ...event, action: 'agent-created' }).success).toBe(true);
  });

  it('reads the Builder run as an optional, non-empty string', () => {
    expect(AuditEventSchema.safeParse({ ...event, builderRunId: 'run-1' }).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...event, builderRunId: '' }).success).toBe(false);
    expect(AuditEventSchema.safeParse({ ...event, createdByAgentId: 'agent-1' }).success).toBe(
      false,
    );
  });
});

describe('AgentCreatedAuditDetailsSchema', () => {
  const details = {
    agentId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    via: 'builder',
  };

  it('reads the minimal and the full shape', () => {
    expect(AgentCreatedAuditDetailsSchema.parse(details)).toEqual(details);
    const full = {
      ...details,
      builderRunId: '33333333-3333-4333-8333-333333333333',
      createdByAgentId: '22222222-2222-4222-8222-222222222222',
    };
    expect(AgentCreatedAuditDetailsSchema.parse(full)).toEqual(full);
  });

  it('refuses an unknown key, an unknown via and a version below 1', () => {
    expect(AgentCreatedAuditDetailsSchema.safeParse({ ...details, extra: 1 }).success).toBe(false);
    expect(AgentCreatedAuditDetailsSchema.safeParse({ ...details, via: 'other' }).success).toBe(
      false,
    );
    expect(AgentCreatedAuditDetailsSchema.safeParse({ ...details, version: 0 }).success).toBe(
      false,
    );
  });
});

describe('AgentChangedAuditDetailsSchema', () => {
  it('reads the archived marker and nothing else', () => {
    expect(AgentChangedAuditDetailsSchema.parse({ archived: true })).toEqual({ archived: true });
    expect(AgentChangedAuditDetailsSchema.parse({ archived: false })).toEqual({ archived: false });
    expect(AgentChangedAuditDetailsSchema.safeParse({ archived: 'no' }).success).toBe(false);
    expect(AgentChangedAuditDetailsSchema.safeParse({}).success).toBe(false);
    expect(AgentChangedAuditDetailsSchema.safeParse({ archived: true, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('response envelopes', () => {
  it('reads the metrics projection and the audit page', () => {
    expect(RunTelemetryListResponseSchema.safeParse({ runs: [telemetry] }).success).toBe(true);
    expect(RunTelemetryListResponseSchema.safeParse({ runs: [] }).success).toBe(true);
    expect(
      AuditEventListResponseSchema.safeParse({ events: [event], nextCursor: null }).success,
    ).toBe(true);
    expect(
      AuditEventListResponseSchema.safeParse({ events: [event], nextCursor: 'eyJ2IjoxfQ' }).success,
    ).toBe(true);
  });

  it('refuses an aggregate the route does not send, and a page without its cursor', () => {
    expect(
      RunTelemetryListResponseSchema.safeParse({ runs: [telemetry], summary: { count: 1 } })
        .success,
    ).toBe(false);
    expect(AuditEventListResponseSchema.safeParse({ events: [event] }).success).toBe(false);
    expect(
      AuditEventListResponseSchema.safeParse({ events: [event], nextCursor: '' }).success,
    ).toBe(false);
    expect(
      AuditEventListResponseSchema.safeParse({ items: [event], nextCursor: null }).success,
    ).toBe(false);
  });

  it('exposes the route bounds for a caller that pages', () => {
    expect(AUDIT_LIST_DEFAULT_LIMIT).toBe(100);
    expect(AUDIT_LIST_MAX_LIMIT).toBe(500);
  });
});
