/**
 * The event-read path's upgrade to the neutral vocabulary (ENG-03, #302).
 *
 * The two things this seam has to get right are both tested against what a *fresh* run produces
 * rather than against a hand-written expectation, because that equivalence is the whole claim: a run
 * recorded before ENG-03 and a run of the same engine messages today must yield the same frames.
 */
import { AgentFrameSchema } from '@indx-workspace/contracts/run-events';
import { classifySdkEvent, toAgentFrames } from '@agent-workspace/run-protocol';
import { describe, expect, it } from 'vitest';

import {
  MAX_FRAMES_PER_ROW,
  upgradeEventStream,
  upgradeStoredEvent,
  wireEventId,
} from './agent-frames';
import { sseFrame, type SseEvent, type SseWireEvent } from './sse';

/** A pre-ENG-03 row: the runner's classification envelope, as `relay.ts` stored it. */
function legacyRow(id: bigint, type: string, message: unknown): SseEvent {
  return { id, type, data: { ...classifySdkEvent(message), event: message } };
}

async function collect(
  source: AsyncIterable<SseEvent>,
  resumedWithin: { readonly sequence: bigint; readonly subIndex: number } | null = null,
): Promise<readonly SseWireEvent[]> {
  const out: SseWireEvent[] = [];
  for await (const event of upgradeEventStream(source, resumedWithin)) out.push(event);
  return out;
}

function stream(...events: readonly SseEvent[]): AsyncIterable<SseEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        // A real store's stream awaits the database; awaiting here keeps the shape the upgrade
        // generator is driven with in a test the same as the one it meets in production.
        yield await Promise.resolve(event);
      }
    },
  };
}

const ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'msg_1',
    content: [
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: '/a' } },
      { type: 'tool_use', id: 'tool_2', name: 'Bash', input: { command: 'ls' } },
    ],
  },
};

const INIT = { type: 'system', subtype: 'init', session_id: 'sess_1', model: 'claude-opus-5' };

describe('upgradeStoredEvent', () => {
  it('serves a frame a run recorded after ENG-03 wrote, unchanged and under its bare sequence', () => {
    const frame = toAgentFrames(classifySdkEvent(INIT))[0];
    const row: SseEvent = { id: 4n, type: 'agent.session', data: frame };
    expect(upgradeStoredEvent(row)).toEqual([{ id: 4n, type: 'agent.session', data: frame }]);
  });

  it('serves the platform’s own event unchanged, under its bare sequence', () => {
    const row: SseEvent = { id: 1n, type: 'run.status', data: { status: 'running', error: null } };
    expect(upgradeStoredEvent(row)).toEqual([row]);
  });

  it('upgrades a legacy row into exactly the frames a fresh run of the same message produces', () => {
    for (const [name, message] of [
      ['system', INIT],
      ['sdk-event', ASSISTANT],
      ['result', { type: 'result', subtype: 'success', total_cost_usd: 0.5 }],
      ['system-unknown', { type: 'system', subtype: 'from_the_future' }],
      ['unknown', { type: 'telepathy' }],
      ['malformed', 'not an object'],
    ] as const) {
      const upgraded = upgradeStoredEvent(legacyRow(9n, name, message));
      const fresh = toAgentFrames(classifySdkEvent(message));
      expect(
        upgraded.map((event) => event.data),
        name,
      ).toEqual([...fresh]);
      // Every upgraded frame carries a sub-index, so an id says which kind of row it came from.
      expect(upgraded.map((event) => event.id)).toEqual(fresh.map((_, i) => `9.${String(i)}`));
      expect(upgraded.map((event) => event.type)).toEqual(fresh.map((frame) => frame.frame));
    }
  });

  it('spreads a one-to-many upgrade across sub-indices of the one row sequence', () => {
    const upgraded = upgradeStoredEvent(legacyRow(12n, 'sdk-event', ASSISTANT));
    expect(upgraded.map((event) => `${String(event.id)} ${event.type}`)).toEqual([
      '12.0 agent.message',
      '12.1 agent.tool.call',
      '12.2 agent.tool.call',
    ]);
  });

  it('reports an envelope it cannot read as agent.malformed, keeping the row in raw', () => {
    for (const data of [null, 'a string', [], { kind: 42, event: {} }, { kind: 'event' }]) {
      const upgraded = upgradeStoredEvent({ id: 3n, type: 'sdk-event', data });
      expect(upgraded).toHaveLength(1);
      const frame = upgraded[0];
      expect(frame?.type).toBe('agent.malformed');
      const parsed = AgentFrameSchema.parse(frame?.data);
      // Not an invented mapping and not a dropped row: the frame says the envelope could not be
      // read, and the envelope itself is carried so a reader can see what was stored.
      expect(parsed.frame === 'agent.malformed' && parsed.reason).toMatch(/pre-ENG-03/);
      expect(parsed.raw).toEqual(data === undefined ? null : data);
    }
  });

  it('produces only frames the published contract accepts', () => {
    for (const message of [INIT, ASSISTANT, 'not an object', { type: 'telepathy' }]) {
      for (const event of upgradeStoredEvent(legacyRow(1n, 'sdk-event', message))) {
        const parsed = AgentFrameSchema.safeParse(event.data);
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      }
    }
  });
});

describe('upgradeEventStream', () => {
  it('is deterministic: the same rows upgrade to the same frames every time', async () => {
    const rows = (): readonly SseEvent[] => [
      legacyRow(1n, 'system', INIT),
      legacyRow(2n, 'sdk-event', ASSISTANT),
    ];
    const first = await collect(stream(...rows()));
    const second = await collect(stream(...rows()));
    expect(second).toEqual(first);
  });

  it('gives every frame a row serves the time the row was recorded', async () => {
    const at = new Date('2026-10-13T10:00:12.400Z');
    const served = await collect(stream({ ...legacyRow(2n, 'sdk-event', ASSISTANT), at }));
    expect(served.length).toBeGreaterThan(1);
    expect(served.map((event) => event.at)).toEqual(served.map(() => at));
  });

  it('serves strictly increasing ids across a mixed log, so a cursor can name any frame', async () => {
    const served = await collect(
      stream(
        { id: 1n, type: 'run.status', data: { status: 'running', error: null } },
        legacyRow(2n, 'sdk-event', ASSISTANT),
        {
          id: 3n,
          type: 'agent.result',
          data: toAgentFrames(classifySdkEvent({ type: 'result', subtype: 'success' }))[0],
        },
      ),
    );
    expect(served.map((event) => String(event.id))).toEqual(['1', '2.0', '2.1', '2.2', '3']);
    // Strictly increasing under `(sequence, sub-index)`, which is what `Last-Event-ID` orders by.
    const keys = served.map((event) => {
      const [sequence, sub] = String(event.id).split('.');
      return [BigInt(sequence ?? '0'), sub === undefined ? -1 : Number(sub)] as const;
    });
    for (let i = 1; i < keys.length; i += 1) {
      const previous = keys[i - 1];
      const current = keys[i];
      if (previous === undefined || current === undefined) throw new Error('missing key');
      expect(
        current[0] > previous[0] || (current[0] === previous[0] && current[1] > previous[1]),
      ).toBe(true);
    }
  });

  it('resumes inside a row without losing or repeating a frame', async () => {
    const rows: readonly SseEvent[] = [legacyRow(2n, 'sdk-event', ASSISTANT)];
    const whole = await collect(stream(...rows));
    // A client that last saw `2.0` is re-served the row and given only what follows; concatenating
    // what it had with what it gets back reconstructs the stream exactly once.
    for (let subIndex = 0; subIndex < whole.length; subIndex += 1) {
      const resumed = await collect(stream(...rows), { sequence: 2n, subIndex });
      expect([...whole.slice(0, subIndex + 1), ...resumed]).toEqual(whole);
    }
    // Resuming after the row's last frame yields nothing from it, rather than repeating it.
    const exhausted = await collect(stream(...rows), { sequence: 2n, subIndex: whole.length - 1 });
    expect(exhausted).toEqual([]);
  });

  it('serves a retained row whole when the resumed row itself is gone', async () => {
    // A cursor into an evicted row has already produced a `stream-reset`, so the first row the
    // store can deliver is new to the client in its entirety.
    const served = await collect(stream(legacyRow(7n, 'sdk-event', ASSISTANT)), {
      sequence: 2n,
      subIndex: 1,
    });
    expect(served.map((event) => String(event.id))).toEqual(['7.0', '7.1', '7.2']);
  });

  it('serves a one-to-one row whole to a sub-indexed cursor that names it, instead of dropping it', async () => {
    // `7.0` names a row a post-ENG-03 run wrote, which the server only ever serves as `7`: the id
    // is stale or forged, and the row is delivered rather than dropped.
    const [result] = toAgentFrames(classifySdkEvent({ type: 'result', subtype: 'success' }));
    const served = await collect(stream({ id: 7n, type: 'agent.result', data: result }), {
      sequence: 7n,
      subIndex: 0,
    });
    expect(served.map((event) => String(event.id))).toEqual(['7']);
    expect(served[0]?.data).toEqual(result);
  });

  it('still skips a legacy row that served a single frame when the cursor names that frame', async () => {
    const served = await collect(stream(legacyRow(7n, 'system', INIT)), {
      sequence: 7n,
      subIndex: 0,
    });
    expect(served).toEqual([]);
  });

  it('writes an SSE frame the wire grammar accepts for every id it produces', async () => {
    for (const event of await collect(stream(legacyRow(2n, 'sdk-event', ASSISTANT)))) {
      expect(sseFrame(event)).toMatch(/^event: agent\.[a-z.]+\nid: 2\.\d\ndata: \{/u);
    }
  });
});

describe('the per-row frame bound', () => {
  const manyCalls = (count: number): unknown => ({
    type: 'assistant',
    message: {
      id: 'msg_many',
      content: Array.from({ length: count }, (_value, index) => ({
        type: 'tool_use',
        id: `t${String(index)}`,
        name: 'Read',
        input: null,
      })),
    },
  });

  it('serves a row of exactly the bound in full', () => {
    const served = upgradeStoredEvent(legacyRow(4n, 'sdk-event', manyCalls(MAX_FRAMES_PER_ROW)));
    expect(served).toHaveLength(MAX_FRAMES_PER_ROW);
    expect(served.every((event) => event.type === 'agent.tool.call')).toBe(true);
    expect(String(served.at(-1)?.id)).toBe('4.999');
  });

  it('reports the frames past the bound as agent.malformed under the largest three-digit id', () => {
    const served = upgradeStoredEvent(
      legacyRow(4n, 'sdk-event', manyCalls(MAX_FRAMES_PER_ROW + 5)),
    );
    expect(served).toHaveLength(MAX_FRAMES_PER_ROW);
    const last = served.at(-1);
    expect(String(last?.id)).toBe('4.999');
    expect(last?.data).toMatchObject({
      frame: 'agent.malformed',
      reason: expect.stringContaining('the last 6 are reported here') as unknown,
    });
    // Every id is one the documented grammar — and so `sseFrame` — accepts.
    for (const event of served) expect(() => sseFrame(event)).not.toThrow();
    expect(AgentFrameSchema.safeParse(last?.data).success).toBe(true);
  });
});

describe('wireEventId', () => {
  it('is the bare sequence for a one-to-one row and `<sequence>.<sub-index>` otherwise', () => {
    expect(wireEventId(41n, null)).toBe('41');
    expect(wireEventId(41n, 0)).toBe('41.0');
    expect(wireEventId(41n, 7)).toBe('41.7');
  });
});
