/**
 * The control plane's copy of "which wire protocols the gateway serves" is held to the gateway
 * itself (ENG-04, #303).
 *
 * `apps/web/server/engines/protocol.ts` decides, before a run starts, whether the agent's engine
 * speaks a dialect the gateway can serve for its model connection's provider. To do that it has
 * to know what the gateway forwards — and it may not import `packages/gateway`, which is a
 * server-side package the control plane reaches over HTTP and never in-process. So it carries a
 * restatement, and this file is the replay that keeps the restatement true, the same way
 * `apps/web/server/engines/registry.test.ts` holds the restated SDK version to the adapter's own
 * manifest (`docs/adr/W2-CP-07-a-restatement-across-a-package-boundary-is-watched-by-a-replay-not-a-comment.md`).
 *
 * It lives in `tests/` rather than beside either side because it is a comparison *between* two
 * packages, which is what `docs/architecture.md` says this directory is for.
 *
 * The drift this catches is silent and points the wrong way: a provider that stops forwarding an
 * OpenAI dialect would leave compose happily composing runs on it, and every one of them would
 * fail at its first model call with `protocol_not_supported_for_connection`.
 */
import { WIRE_PROTOCOLS } from '@indx-workspace/contracts/engines';
import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';
import { describe, expect, it } from 'vitest';

import { gatewayProtocolsFor } from '../apps/web/server/engines/protocol.js';

/**
 * The dialects one registry row relays as-is, or `[]` for a row that translates instead.
 *
 * `forwards` is a `Set` on the row, not an array — read defensively rather than cast, because
 * this file's whole job is to notice when the gateway's shape changed.
 */
function forwardedBy(row: unknown): readonly string[] {
  if (typeof row !== 'object' || row === null || !('forwards' in row)) return [];
  const forwards: unknown = row.forwards;
  const values: unknown[] = forwards instanceof Set ? [...forwards] : [];
  return values.filter((value): value is string => typeof value === 'string');
}

describe("the control plane's protocol table matches the gateway's own registry", () => {
  const registry = createProviderRegistry();

  it('agrees provider by provider, for every published provider', () => {
    for (const provider of MODEL_PROVIDERS) {
      const row = registry.find((candidate) => candidate.id === provider);
      // Every row answers `createMessage`, which is the Anthropic Messages shape — so that
      // dialect is served for every provider, translated where the provider's own API differs.
      // Only a row that declares `forwards` relays an OpenAI body as-is (ADR-0068 D3).
      const expected = ['anthropic-messages', ...forwardedBy(row)].sort();
      expect([...gatewayProtocolsFor(provider)].sort(), provider).toEqual(expected);
    }
  });

  it('forwards an OpenAI dialect for exactly the OpenAI-family rows', () => {
    // Stated as an equality rather than "openai forwards": the set can only grow silently in the
    // direction that matters — a provider that *starts* forwarding and is not in the control
    // plane's copy makes compose refuse a run the gateway would have served.
    const forwarding = registry
      .filter((row) => forwardedBy(row).length > 0)
      .map((row) => row.id)
      .sort();
    expect(forwarding).toEqual(['azure-openai', 'openai', 'openai-compatible']);
  });

  it('names the published providers the gateway registry has no row for', () => {
    // `anthropic-compatible` is published by the contracts and has no row of its own: a
    // deployment reaches it through the Anthropic Messages shape like any other Anthropic-family
    // connection. That is recorded here as an assertion rather than left to a reader to notice,
    // because the comparison above would otherwise be vacuous for it — a provider with no row
    // has no `forwards` and would agree with an empty expectation for the wrong reason.
    const unrouted = MODEL_PROVIDERS.filter(
      (provider) => !registry.some((row) => row.id === provider),
    );
    expect([...unrouted]).toEqual(['anthropic-compatible']);
  });

  it('never names a protocol the contract does not publish', () => {
    for (const provider of MODEL_PROVIDERS) {
      for (const protocol of gatewayProtocolsFor(provider)) {
        expect(WIRE_PROTOCOLS, protocol).toContain(protocol);
      }
    }
  });
});
