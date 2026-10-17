import { describe, expect, it } from 'vitest';

import {
  A2A_ERROR_CODES,
  A2A_PROTOCOL_VERSION,
  A2aAgentCardSchema,
  A2aArtifactUpdateEventSchema,
  A2aJsonRpcRequestSchema,
  A2aJsonRpcResponseSchema,
  A2aMessageSendParamsSchema,
  A2aStatusUpdateEventSchema,
  A2aTaskSchema,
  buildA2aAgentCard,
} from './a2a.js';
import cardFixture from './__fixtures__/a2a-agent-card.v0_3.json' with { type: 'json' };
import spec from './__fixtures__/a2a-spec.v0_3_0.agent-card.json' with { type: 'json' };

const message = {
  kind: 'message',
  messageId: 'm-1',
  role: 'user',
  parts: [{ kind: 'text', text: 'hello' }],
};

describe('buildA2aAgentCard', () => {
  it('matches the v0.3 card fixture', () => {
    const card = buildA2aAgentCard({
      name: 'support-bot',
      description: 'Answers support questions',
      url: 'https://aw.example.com/api/a2a/agents/support-bot',
      version: '3',
      examples: ['How do I reset my password?'],
    });
    expect(card).toEqual(cardFixture);
    expect(A2aAgentCardSchema.parse(cardFixture)).toEqual(card);
    expect(card.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
  });

  it('defaults the description and omits examples', () => {
    const card = buildA2aAgentCard({
      name: 'x',
      description: null,
      url: 'http://localhost:3000/api/a2a/agents/x',
      version: '1',
    });
    expect(card.description).toBe('x — an Agent Workspace agent');
    expect(card.skills[0]).not.toHaveProperty('examples');
    expect(A2aAgentCardSchema.safeParse(card).success).toBe(true);
  });

  it('labels the card with the display name but keeps the agent name as skill id and in the description', () => {
    const card = buildA2aAgentCard({
      name: 'support-triage',
      displayName: 'Support Triage',
      description: null,
      url: 'http://localhost:3000/api/a2a/agents/support-triage',
      version: '1',
    });
    expect(card.name).toBe('Support Triage');
    expect(card.skills[0]).toMatchObject({
      id: 'support-triage',
      name: 'Support Triage',
      description: 'support-triage — an Agent Workspace agent',
    });
    expect(card.description).toBe('support-triage — an Agent Workspace agent');
  });

  it('refuses a card that claims push notifications', () => {
    const claimed = { ...cardFixture, capabilities: { streaming: true, pushNotifications: true } };
    expect(A2aAgentCardSchema.safeParse(claimed).success).toBe(false);
  });
});

describe('the card against the A2A v0.3.0 specification', () => {
  const card = buildA2aAgentCard({
    name: 'support-bot',
    description: null,
    url: 'https://aw.example.com/api/a2a/agents/support-bot',
    version: '3',
  });

  it('carries every required AgentCard key', () => {
    for (const key of spec.AgentCard.required) expect(card, key).toHaveProperty(key);
  });

  it("states the spec's default protocolVersion", () => {
    expect(spec.AgentCard.properties.protocolVersion.type).toBe('string');
    expect(typeof card.protocolVersion).toBe('string');
    expect(card.protocolVersion).toBe(spec.AgentCard.properties.protocolVersion.default);
  });

  it('declares an HTTP bearer scheme the spec accepts', () => {
    const scheme: Record<string, unknown> = card.securitySchemes.awBearer;
    const { properties, required } = spec.HTTPAuthSecurityScheme;
    for (const key of Object.keys(scheme)) expect(properties, key).toHaveProperty(key);
    for (const key of required) expect(scheme, key).toHaveProperty(key);
    expect(scheme['type']).toBe(properties.type.const);
    expect(String(scheme['scheme']).toLowerCase()).toBe('bearer');
  });

  it('requires only declared schemes, with a list of scope strings each', () => {
    const declared = Object.keys(card.securitySchemes);
    for (const requirement of card.security) {
      for (const [name, scopes] of Object.entries(requirement)) {
        expect(declared).toContain(name);
        expect(scopes.every((scope) => typeof scope === 'string')).toBe(true);
      }
    }
  });
});

describe('what a client sends is tolerated, what the server reads is checked', () => {
  it('accepts unknown fields on message/send params', () => {
    const parsed = A2aMessageSendParamsSchema.safeParse({
      message: { ...message, extensions: ['x'] },
      configuration: { blocking: true, somethingNew: 1 },
      vendor: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('parses file and data parts only so they can be refused', () => {
    const parsed = A2aMessageSendParamsSchema.parse({
      message: { ...message, parts: [{ kind: 'file', file: { uri: 'x' } }] },
    });
    expect(parsed.message.parts[0]?.kind).toBe('file');
  });

  it('rejects a message with no parts, an empty id or a bad role', () => {
    for (const bad of [
      { ...message, parts: [] },
      { ...message, messageId: '' },
      { ...message, role: 'system' },
    ]) {
      expect(A2aMessageSendParamsSchema.safeParse({ message: bad }).success).toBe(false);
    }
  });

  it('keeps the JSON-RPC envelope strict', () => {
    const ok = A2aJsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1, method: 'a' });
    expect(ok.success).toBe(true);
    const fractional = A2aJsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 1.5, method: 'a' });
    expect(fractional.success).toBe(false);
    const extra = A2aJsonRpcRequestSchema.safeParse({
      jsonrpc: '2.0',
      id: 1,
      method: 'a',
      extra: 1,
    });
    expect(extra.success).toBe(false);
  });
});

describe('what the server emits is strict', () => {
  const status = { state: 'working', timestamp: '2026-10-11T10:00:00.000Z' };

  it('parses a task, a status update and an artifact update', () => {
    const task = { kind: 'task', id: 'r', contextId: 's', status };
    expect(A2aTaskSchema.safeParse(task).success).toBe(true);
    const statusUpdate = {
      kind: 'status-update',
      taskId: 'r',
      contextId: 's',
      status,
      final: false,
    };
    expect(A2aStatusUpdateEventSchema.safeParse(statusUpdate).success).toBe(true);
    const artifactUpdate = {
      kind: 'artifact-update',
      taskId: 'r',
      contextId: 's',
      artifact: { artifactId: 'response', parts: [{ kind: 'text', text: 'hi' }] },
      append: true,
    };
    expect(A2aArtifactUpdateEventSchema.safeParse(artifactUpdate).success).toBe(true);
  });

  it('refuses an unknown task state or a stray field', () => {
    const unknownState = { kind: 'task', id: 'r', contextId: 's', status: { state: 'done' } };
    expect(A2aTaskSchema.safeParse(unknownState).success).toBe(false);
    const stray = { kind: 'task', id: 'r', contextId: 's', status, secret: 1 };
    expect(A2aTaskSchema.safeParse(stray).success).toBe(false);
  });

  it('describes a result and an error answer', () => {
    const result = A2aJsonRpcResponseSchema.safeParse({ jsonrpc: '2.0', id: 1, result: {} });
    expect(result.success).toBe(true);
    const error = A2aJsonRpcResponseSchema.safeParse({
      jsonrpc: '2.0',
      id: null,
      error: { code: A2A_ERROR_CODES.parse_error, message: 'Parse error' },
    });
    expect(error.success).toBe(true);
  });
});
