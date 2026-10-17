import { describe, expect, it } from 'vitest';

import {
  DISCOVERED_MODEL_CAPABILITY_KEYS,
  DeleteModelConnectionResponseSchema,
  DiscoveredModelSchema,
  DiscoveredModelsResponseSchema,
  MODEL_CONNECTION_CONFIG_FIELDS,
  MODEL_PROVIDER_CONFIG_RULES,
  ModelConnectionListResponseSchema,
  ModelConnectionResourceSchema,
  ModelConnectionTestOutcomeSchema,
  SCRIPTED_MODEL_NAME_PATTERN,
  ScriptedModelScriptSchema,
} from './models.js';
import { MODEL_PROVIDERS } from './runs.js';

const CONNECTION = '22222222-2222-4222-8222-222222222222';
const AGENT = '11111111-1111-4111-8111-111111111111';

const connection = {
  id: CONNECTION,
  name: 'Anthropic',
  provider: 'anthropic',
  config: {},
  hasCredential: true,
  ready: true,
  createdAt: '2026-09-21T10:00:00.000Z',
  updatedAt: '2026-09-21T10:00:00.000Z',
};

const capabilities = {
  streaming: true,
  toolUse: true,
  thinking: true,
  promptCaching: true,
  structuredOutput: false,
  contextManagement: false,
  webSearch: false,
  tokenCounting: true,
};

const discovered = {
  connectionId: CONNECTION,
  providerModelId: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  capabilities,
};

describe('ModelConnectionResourceSchema', () => {
  it('accepts a bare-config connection and a fully configured Azure one', () => {
    expect(ModelConnectionResourceSchema.safeParse(connection).success).toBe(true);
    expect(
      ModelConnectionResourceSchema.safeParse({
        ...connection,
        provider: 'azure-openai',
        config: {
          baseUrl: 'https://example.openai.azure.com',
          apiVersion: '2024-10-21',
          deployment: 'gpt-4o',
        },
        hasCredential: false,
        ready: false,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown provider, a wrong-typed flag, and a missing readiness field', () => {
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, provider: 'gemini' }).success,
    ).toBe(false);
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, hasCredential: 'yes' }).success,
    ).toBe(false);
    const withoutReady = Object.fromEntries(
      Object.entries(connection).filter(([key]) => key !== 'ready'),
    );
    expect(ModelConnectionResourceSchema.safeParse(withoutReady).success).toBe(false);
  });

  it('has no field for the credential: an apiKey in a response is drift, not data', () => {
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, apiKey: 'sk-live' }).success,
    ).toBe(false);
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, config: { apiKey: 'sk-live' } })
        .success,
    ).toBe(false);
  });

  it('requires an absolute base URL, a non-empty deployment, and an ISO timestamp', () => {
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, config: { baseUrl: 'api.example' } })
        .success,
    ).toBe(false);
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, config: { deployment: '' } })
        .success,
    ).toBe(false);
    expect(
      ModelConnectionResourceSchema.safeParse({ ...connection, createdAt: 1_700_000_000 }).success,
    ).toBe(false);
  });
});

describe('MODEL_PROVIDER_CONFIG_RULES', () => {
  it('states a rule for every provider and nothing else', () => {
    expect(Object.keys(MODEL_PROVIDER_CONFIG_RULES).sort()).toEqual([...MODEL_PROVIDERS].sort());
  });

  it('only requires what it allows, and only names known config fields', () => {
    for (const provider of MODEL_PROVIDERS) {
      const rule = MODEL_PROVIDER_CONFIG_RULES[provider];
      for (const field of rule.required) expect(rule.allowed).toContain(field);
      for (const field of rule.allowed) expect(MODEL_CONNECTION_CONFIG_FIELDS).toContain(field);
    }
  });

  it('spells out the specification: optional baseUrl, required baseUrl, and the Azure triple', () => {
    expect(MODEL_PROVIDER_CONFIG_RULES.anthropic).toEqual({ allowed: ['baseUrl'], required: [] });
    expect(MODEL_PROVIDER_CONFIG_RULES['anthropic-compatible']).toEqual(
      MODEL_PROVIDER_CONFIG_RULES.anthropic,
    );
    expect(MODEL_PROVIDER_CONFIG_RULES.openai).toEqual({ allowed: ['baseUrl'], required: [] });
    expect(MODEL_PROVIDER_CONFIG_RULES['openai-compatible'].required).toEqual(['baseUrl']);
    expect([...MODEL_PROVIDER_CONFIG_RULES['azure-openai'].required].sort()).toEqual([
      'apiVersion',
      'baseUrl',
      'deployment',
    ]);
  });
});

describe('response envelopes', () => {
  it('reads the list under its historical key and refuses the key the spec would prefer', () => {
    expect(ModelConnectionListResponseSchema.safeParse({ models: [connection] }).success).toBe(
      true,
    );
    expect(ModelConnectionListResponseSchema.safeParse({ connections: [connection] }).success).toBe(
      false,
    );
  });

  it('reads the delete outcome with the agents that lost their reference', () => {
    expect(
      DeleteModelConnectionResponseSchema.safeParse({ deleted: true, referencedBy: [] }).success,
    ).toBe(true);
    expect(
      DeleteModelConnectionResponseSchema.safeParse({
        deleted: true,
        referencedBy: [{ agentId: AGENT, agentName: 'Support' }],
      }).success,
    ).toBe(true);
    expect(
      DeleteModelConnectionResponseSchema.safeParse({ deleted: false, referencedBy: [] }).success,
    ).toBe(false);
    expect(DeleteModelConnectionResponseSchema.safeParse({ deleted: true }).success).toBe(false);
    expect(
      DeleteModelConnectionResponseSchema.safeParse({
        deleted: true,
        referencedBy: [{ agentId: AGENT }],
      }).success,
    ).toBe(false);
  });
});

describe('ModelConnectionTestOutcomeSchema', () => {
  it('accepts a success with a status and a failure with or without one', () => {
    expect(
      ModelConnectionTestOutcomeSchema.safeParse({
        ok: true,
        status: 200,
        latencyMs: 120,
        message: 'Connection succeeded.',
      }).success,
    ).toBe(true);
    expect(
      ModelConnectionTestOutcomeSchema.safeParse({
        ok: false,
        status: 401,
        latencyMs: 80,
        message: 'Provider returned HTTP 401.',
      }).success,
    ).toBe(true);
    expect(
      ModelConnectionTestOutcomeSchema.safeParse({
        ok: false,
        status: null,
        latencyMs: 0,
        message: 'The provider connection could not be reached.',
      }).success,
    ).toBe(true);
  });

  it('refuses a success without a status, a negative latency, and an unknown key', () => {
    const failure = { ok: false, status: null, latencyMs: 1, message: 'x' };
    expect(ModelConnectionTestOutcomeSchema.safeParse({ ...failure, ok: true }).success).toBe(
      false,
    );
    expect(ModelConnectionTestOutcomeSchema.safeParse({ ...failure, latencyMs: -1 }).success).toBe(
      false,
    );
    expect(
      ModelConnectionTestOutcomeSchema.safeParse({ ...failure, credential: 'k' }).success,
    ).toBe(false);
  });
});

describe('DiscoveredModelsResponseSchema', () => {
  it('reads a catalog with and without the unavailable list', () => {
    expect(DiscoveredModelsResponseSchema.safeParse({ models: [discovered] }).success).toBe(true);
    expect(
      DiscoveredModelsResponseSchema.safeParse({
        models: [],
        unavailable: [
          {
            connectionId: CONNECTION,
            connectionName: 'Anthropic',
            reason: 'The provider model catalog could not be loaded.',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('names every capability the specification lists, and rejects a missing or extra one', () => {
    expect(Object.keys(capabilities).sort()).toEqual([...DISCOVERED_MODEL_CAPABILITY_KEYS].sort());
    const withoutThinking = Object.fromEntries(
      Object.entries(capabilities).filter(([key]) => key !== 'thinking'),
    );
    expect(
      DiscoveredModelSchema.safeParse({ ...discovered, capabilities: withoutThinking }).success,
    ).toBe(false);
    expect(
      DiscoveredModelSchema.safeParse({
        ...discovered,
        capabilities: { ...capabilities, vision: true },
      }).success,
    ).toBe(false);
  });

  it('rejects a row without a provider model id and a malformed unavailable entry', () => {
    expect(DiscoveredModelSchema.safeParse({ ...discovered, providerModelId: '' }).success).toBe(
      false,
    );
    expect(
      DiscoveredModelsResponseSchema.safeParse({
        models: [],
        unavailable: [{ connectionId: CONNECTION, reason: 'x' }],
      }).success,
    ).toBe(false);
    expect(DiscoveredModelsResponseSchema.safeParse({ models: [], stale: true }).success).toBe(
      false,
    );
  });
});

describe('ScriptedModelScriptSchema', () => {
  const accepts = (value: unknown): boolean => ScriptedModelScriptSchema.safeParse(value).success;

  it('accepts text, tool-use and mixed turns', () => {
    expect(
      accepts({
        turns: [
          { toolUses: [{ name: 'lookup', input: { id: 1 } }] },
          { text: 'checking', toolUses: [{ name: 'lookup', input: {} }] },
          { text: 'done' },
        ],
      }),
    ).toBe(true);
  });

  it.each([
    ['unknown keys', { turns: [{ text: 'a' }], extra: 1 }],
    ['unknown turn keys', { turns: [{ text: 'a', extra: 1 }] }],
    ['no turns', { turns: [] }],
    ['an empty turn', { turns: [{}] }],
    ['empty text', { turns: [{ text: '' }] }],
    ['an empty tool-use list', { turns: [{ toolUses: [] }] }],
    ['a tool call without input', { turns: [{ toolUses: [{ name: 'x' }] }] }],
  ])('refuses %s', (_label, value) => {
    expect(accepts(value)).toBe(false);
  });

  it('only accepts file-safe names', () => {
    expect(SCRIPTED_MODEL_NAME_PATTERN.test('support-happy-path')).toBe(true);
    for (const bad of ['', '../x', 'a/b', 'A', '-a', 'a.json', 'a'.repeat(65)]) {
      expect(SCRIPTED_MODEL_NAME_PATTERN.test(bad)).toBe(false);
    }
  });
});
