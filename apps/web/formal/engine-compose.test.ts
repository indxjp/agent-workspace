/**
 * The `engine-compose` protocol vectors, replayed against compose (ENG-04, #303).
 *
 * Decision D-012: a suite that imports application code lives with the application. This one
 * drives `apps/web/server/engines/protocol.ts` — the check that decides, before a run row
 * exists, whether the agent's engine speaks a dialect the gateway serves for its model
 * connection's provider — and compares it to what `formal/Vectors/EngineCompose.lean` says it
 * must answer. A disagreement is a failing test, and the fix is never to edit a vector
 * (`docs/formal/00-orchestrator-prompt.md` §10).
 *
 * The vectors cover both directions of the T1 theorem, because only one of them is interesting
 * on today's catalogue: every provider serves `anthropic-messages`, so the one engine this
 * release ships resolves against all five. The refusal arm is reached by the hypothetical
 * Responses-only engine, which is what makes `engine_model_protocol_unsupported` a refusal that
 * is proved rather than one that is merely written down.
 */
import { describe, expect, it } from 'vitest';

import { loadVectors } from '../../../tests/formal/vectors.js';
import { gatewayProtocolsFor, resolveWireProtocol } from '../server/engines/protocol.js';
import type { ModelProvider } from '@indx-workspace/contracts/runs';
import type { WireProtocol } from '@indx-workspace/contracts/engines';

const FAMILY = 'engine-compose';

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new Error(`${label}: expected an array of strings, got ${JSON.stringify(value)}`);
  }
  return value;
}

describe('engine-compose: the protocol check compose really runs', () => {
  const vectors = loadVectors(FAMILY, 'protocol.json');

  it.each(vectors)('$id', ({ id, input, expected }) => {
    const request = record(input, id);
    const answer = record(expected, id);
    const engineProtocols = strings(request['engineProtocols'], id) as readonly WireProtocol[];
    const provider = String(request['provider']) as ModelProvider;

    // The gateway's own answer for this provider, compared as an ordered list: the order is what
    // makes the resolution deterministic, so comparing sets would leave it unchecked.
    expect([...gatewayProtocolsFor(provider)]).toEqual([...strings(answer['served'], id)]);

    const resolution = resolveWireProtocol('vector-engine', engineProtocols, provider);
    const expectedProtocol = answer['protocol'];
    if (expectedProtocol === null) {
      expect(resolution.ok, `${id}: the model refuses this pair`).toBe(false);
      // The refusal names both sides, because the operator's fix is either a different engine or
      // a different model connection and they have to be able to tell which.
      if (!resolution.ok) {
        expect(resolution.reason).toContain(provider);
      }
      return;
    }
    expect(resolution.ok, `${id}: the model resolves this pair`).toBe(true);
    if (resolution.ok) expect(resolution.protocol).toBe(expectedProtocol);
  });

  it('replayed every vector the family carries', () => {
    // ADR-0015: a suite that replayed nothing is not a pass. `loadVectors` throws on an empty
    // file; this is the assertion that the file it read is the one this suite is about.
    expect(vectors.length).toBeGreaterThan(0);
    expect(vectors.map((vector) => vector.id)).toContain('responses-only-anthropic');
  });
});
