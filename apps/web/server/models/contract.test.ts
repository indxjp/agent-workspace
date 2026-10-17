import { describe, expect, it } from 'vitest';

import {
  isModelConnectionConfigComplete,
  parseCreateModelConnection,
  parseUpdateModelConnection,
  toModelConnectionResource,
  type CheckBaseUrlEgress,
} from './contract';

const ALLOW: CheckBaseUrlEgress = () => Promise.resolve({ ok: true });
const REFUSE =
  (reason: string): CheckBaseUrlEgress =>
  () =>
    Promise.resolve({ ok: false, reason });

describe('parseCreateModelConnection — issue #126 provider-discriminated config', () => {
  it('accepts anthropic and openai with no config at all', async () => {
    for (const provider of ['anthropic', 'anthropic-compatible', 'openai'] as const) {
      const result = await parseCreateModelConnection(
        { name: 'x', provider, apiKey: 'k', config: {} },
        ALLOW,
      );
      expect(result.ok).toBe(true);
    }
  });

  it('rejects apiVersion/deployment for a provider that does not use them', async () => {
    const result = await parseCreateModelConnection(
      { name: 'x', provider: 'anthropic', apiKey: 'k', config: { apiVersion: '2024-01-01' } },
      ALLOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toMatch(
        /config\.apiVersion is not supported for the "anthropic" provider/,
      );
    }
  });

  it('requires baseUrl for openai-compatible', async () => {
    const result = await parseCreateModelConnection(
      { name: 'x', provider: 'openai-compatible', apiKey: 'k', config: {} },
      ALLOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain(
        'config.baseUrl is required for the "openai-compatible" provider.',
      );
  });

  it('names every missing required field for azure-openai in one 400, and rejects nothing else', async () => {
    const result = await parseCreateModelConnection(
      { name: 'x', provider: 'azure-openai', apiKey: 'k', config: {} },
      ALLOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'config.baseUrl is required for the "azure-openai" provider.',
          'config.apiVersion is required for the "azure-openai" provider.',
          'config.deployment is required for the "azure-openai" provider.',
        ]),
      );
    }
  });

  it('accepts a complete azure-openai config', async () => {
    const result = await parseCreateModelConnection(
      {
        name: 'x',
        provider: 'azure-openai',
        apiKey: 'k',
        config: { baseUrl: 'https://example.invalid', apiVersion: '2024-01-01', deployment: 'gpt' },
      },
      ALLOW,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown config key regardless of provider', async () => {
    const result = await parseCreateModelConnection(
      { name: 'x', provider: 'openai', apiKey: 'k', config: { region: 'us-east-1' } },
      ALLOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('config.region is not supported.');
  });

  it('runs a stored baseUrl through the egress policy at save time and reports a refusal field-level', async () => {
    const result = await parseCreateModelConnection(
      {
        name: 'x',
        provider: 'openai-compatible',
        apiKey: 'k',
        config: { baseUrl: 'https://blocked.invalid' },
      },
      REFUSE('Target resolves to a link-local address, refused by policy.'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/^config\.baseUrl is not reachable: /);
      expect(result.errors[0]).toContain('link-local');
    }
  });

  it('never reaches the egress check for a provider with no baseUrl configured', async () => {
    let called = false;
    const spy: CheckBaseUrlEgress = () => {
      called = true;
      return Promise.resolve({ ok: true });
    };
    const result = await parseCreateModelConnection(
      { name: 'x', provider: 'anthropic', apiKey: 'k', config: {} },
      spy,
    );
    expect(result.ok).toBe(true);
    expect(called).toBe(false);
  });
});

describe('parseUpdateModelConnection — provider is read, never accepted, from the caller', () => {
  it("validates config.deployment against the connection's own (immutable) provider", async () => {
    const result = await parseUpdateModelConnection(
      { config: { deployment: 'x' } },
      'anthropic',
      ALLOW,
    );
    expect(result.ok).toBe(false);
  });

  it('accepts a name-only update with no config at all, for any provider', async () => {
    const result = await parseUpdateModelConnection({ name: 'renamed' }, 'azure-openai', ALLOW);
    expect(result.ok).toBe(true);
  });

  it('rejects a provider field outright — the provider is set once, at creation', async () => {
    const result = await parseUpdateModelConnection({ provider: 'anthropic' }, 'openai', ALLOW);
    expect(result.ok).toBe(false);
  });
});

describe("readiness — derived from hasCredential plus the provider's required fields", () => {
  it('is false with a credential but a missing required field', () => {
    expect(isModelConnectionConfigComplete('azure-openai', { baseUrl: 'https://x.invalid' })).toBe(
      false,
    );
  });

  it('is true once every required field for the provider is present', () => {
    expect(
      isModelConnectionConfigComplete('azure-openai', {
        baseUrl: 'https://x.invalid',
        apiVersion: '2024-01-01',
        deployment: 'gpt',
      }),
    ).toBe(true);
  });

  it('toModelConnectionResource computes ready = hasCredential && config-complete', () => {
    const connection = {
      id: 'c1',
      workspaceId: 'w1',
      name: 'n',
      provider: 'openai-compatible' as const,
      config: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    expect(toModelConnectionResource(connection, true).ready).toBe(false);
    expect(
      toModelConnectionResource({ ...connection, config: { baseUrl: 'https://x.invalid' } }, false)
        .ready,
    ).toBe(false);
    expect(
      toModelConnectionResource({ ...connection, config: { baseUrl: 'https://x.invalid' } }, true)
        .ready,
    ).toBe(true);
  });
});
