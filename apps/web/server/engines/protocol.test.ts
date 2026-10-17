/**
 * The compose-time protocol check (ENG-04, #303).
 *
 * `protocol.ts` restates which providers the gateway forwards an OpenAI dialect to, because
 * `apps/web` may not import `packages/gateway`'s provider registry. **That restatement is
 * checked against the gateway itself in `tests/engine-wire-protocols.test.ts`**, not here: a
 * cross-package comparison belongs in `tests/` (`docs/architecture.md`), and a copy nobody
 * compares is a copy that drifts silently in the dangerous direction — a run composed on
 * `openai-responses` for a provider the gateway will not forward it to.
 *
 * What is asserted in this file is the decision itself: which protocol a given pair resolves to,
 * and that a pair with no overlap is a refusal rather than a guess.
 */
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import { WIRE_PROTOCOLS } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import { gatewayProtocolsFor, providersReachableBy, resolveWireProtocol } from './protocol';

describe('gatewayProtocolsFor', () => {
  it('always serves the gateway-native dialect, for every published provider', () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(gatewayProtocolsFor(provider), provider).toContain('anthropic-messages');
    }
  });

  it('never claims a protocol the contract does not publish', () => {
    for (const provider of MODEL_PROVIDERS) {
      for (const protocol of gatewayProtocolsFor(provider)) {
        expect(WIRE_PROTOCOLS).toContain(protocol);
      }
    }
  });
});

describe('resolveWireProtocol', () => {
  it('resolves the Claude engine against every provider, because every one serves Messages', () => {
    for (const provider of MODEL_PROVIDERS) {
      const resolution = resolveWireProtocol('claude-agent-sdk', ['anthropic-messages'], provider);
      expect(resolution.ok, provider).toBe(true);
      expect(resolution.ok ? resolution.protocol : '').toBe('anthropic-messages');
    }
  });

  it("reads the engine's own order, not the gateway's", () => {
    // An engine that lists a dialect first is saying it would rather speak it, and an OpenAI
    // connection serves both. Reading the engine's preference is what makes the capability
    // field an ordered list rather than a set.
    const resolution = resolveWireProtocol(
      'some-openai-engine',
      ['openai-responses', 'anthropic-messages'],
      'openai',
    );
    expect(resolution.ok && resolution.protocol).toBe('openai-responses');
  });

  it('refuses when the engine speaks nothing the gateway serves for this provider', () => {
    // The case the whole check exists for: a Responses-only engine pointed at an Anthropic
    // connection. Today the gateway will not forward an OpenAI body to `anthropic`, so this run
    // would fail at its first model call.
    const resolution = resolveWireProtocol('some-openai-engine', ['openai-responses'], 'anthropic');
    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? '' : resolution.reason).toContain('openai-responses');
    expect(resolution.ok ? '' : resolution.reason).toContain('anthropic-messages');
  });

  it('refuses an engine that declares no protocol at all rather than guessing one', () => {
    const resolution = resolveWireProtocol('broken-engine', [], 'openai' satisfies ModelProvider);
    expect(resolution.ok).toBe(false);
  });
});

describe('providersReachableBy (issue #393)', () => {
  it('reaches every provider over anthropic-messages, and only the OpenAI family otherwise', () => {
    expect(providersReachableBy(['anthropic-messages'])).toEqual([...MODEL_PROVIDERS]);
    expect(providersReachableBy(['openai-responses'])).toEqual([
      'openai',
      'azure-openai',
      'openai-compatible',
    ]);
    expect(providersReachableBy([])).toEqual([]);
  });
});
