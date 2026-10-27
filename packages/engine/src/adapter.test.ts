/**
 * `createEngineAdapter` (#951), driven by a fake plan: the skeleton's behaviour apart from any
 * engine.
 */
import { ENGINE_CATALOGUE } from '@indx-workspace/contracts/engines';
import { describe, expect, it } from 'vitest';

import {
  createEngineAdapter,
  type EngineAdapterSpec,
  type EngineRunIdentity,
  type EngineRunPlan,
} from './adapter.js';
import { engineFrameBuilder, type EngineFrame } from './frames.js';
import type { EngineRunRequest, SessionDurabilityVerdict } from './port.js';

type Event = { readonly kind: 'text' | 'session' | 'done' | 'cancelled'; readonly value?: string };

const builder = engineFrameBuilder('demo');

function request(overrides: Partial<EngineRunRequest> = {}): EngineRunRequest {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    projectKey: 'tenant',
    cwd: '/workspace/tenant',
    prompt: 'go',
    engine: 'demo',
    portable: {
      name: 'Writer',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: false,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: {},
    session: { mode: 'fresh' },
    gateway: null,
    resources: {
      files: [],
      skills: [{ name: 'writer', files: [{ path: 'SKILL.md', contentBase64: 'eA==' }] }],
    },
    env: {},
    ...overrides,
  };
}

function mapEvent(event: Event): readonly EngineFrame[] {
  if (event.kind === 'session') {
    return [
      builder.session(
        { frame: 'agent.session', engineSessionId: event.value ?? '', model: null },
        event,
      ),
    ];
  }
  return [builder.native(event.kind, event)];
}

type Harness = {
  readonly adapter: ReturnType<typeof createEngineAdapter<null, Event>>;
  readonly seen: { signal: AbortSignal | null; eventsCalled: number; completedAsked: boolean[] };
};

function harness(
  options: {
    readonly events?: readonly Event[];
    readonly failWith?: unknown;
    readonly identity?: EngineRunIdentity;
    readonly cancelled?: Event | null;
    readonly capabilities?: EngineAdapterSpec<null, Event>['capabilities'];
    readonly refuse?: boolean;
    readonly structuredOutput?: boolean;
    readonly placeSkills?: EngineAdapterSpec<null, Event>['placeSkills'];
  } = {},
): Harness {
  const seen: Harness['seen'] = { signal: null, eventsCalled: 0, completedAsked: [] };
  const spec: EngineAdapterSpec<null, Event> = {
    id: 'demo',
    version: '0.0.0',
    capabilities: options.capabilities ?? ENGINE_CATALOGUE.pi.capabilities,
    protectedConfigDirectory: '.demo',
    ...(options.structuredOutput === undefined
      ? {}
      : { structuredOutput: options.structuredOutput }),
    ...(options.placeSkills === undefined ? {} : { placeSkills: options.placeSkills }),
    compile: () =>
      options.refuse === true
        ? { ok: false, code: 'engine_policy_invalid', reason: 'the arm is wrong.' }
        : { ok: true, compiled: null },
    plan: (_compiled, _request, context): EngineRunPlan<Event> => {
      seen.signal = context.abortController.signal;
      return {
        identity: options.identity ?? {
          kind: 'declared',
          engineSessionId: 'engine-1',
          model: 'm',
          raw: { type: 'demo.session' },
        },
        events: async function* () {
          seen.eventsCalled += 1;
          for (const event of options.events ?? []) {
            await Promise.resolve();
            yield event;
          }
          // A dependency may reject with anything, not just an Error — a bare thenable is how a
          // foreign library would hand one over.
          const reason = options.failWith;
          if (reason !== undefined) {
            await Promise.resolve({
              then: (_resolve: unknown, reject: (rejection: unknown) => void) => {
                reject(reason);
              },
            });
          }
        },
        map: mapEvent,
        isTerminal: (event) => event.kind === 'done',
        cancelled: options.cancelled === undefined ? { kind: 'cancelled' } : options.cancelled,
        durability: (completed): SessionDurabilityVerdict => {
          seen.completedAsked.push(completed);
          return completed
            ? { durable: true, mirroredBatches: 1 }
            : { durable: false, reason: 'not completed' };
        },
      };
    },
  };
  return { adapter: createEngineAdapter(spec), seen };
}

async function drain(frames: AsyncIterable<EngineFrame>): Promise<EngineFrame[]> {
  const out: EngineFrame[] = [];
  for await (const frame of frames) out.push(frame);
  return out;
}

const kinds = (frames: readonly EngineFrame[]): string[] =>
  frames.map((frame) => (frame.frame === 'agent.native' ? frame.type : frame.frame));

describe('createEngineAdapter: a declared identity', () => {
  it('yields agent.session first, maps the events, and resolves the declared id', async () => {
    const { adapter, seen } = harness({ events: [{ kind: 'text' }, { kind: 'done' }] });
    const run = adapter.start(request());
    expect(await drain(run.frames).then(kinds)).toEqual(['agent.session', 'text', 'done']);
    expect(await run.engineSessionId).toBe('engine-1');
    expect(run.sessionDurability()).toEqual({ durable: true, mirroredBatches: 1 });
    expect(seen.completedAsked).toEqual([true]);
  });

  it('is not completed until a terminal event has been seen', async () => {
    const { adapter, seen } = harness({ events: [{ kind: 'text' }] });
    const run = adapter.start(request());
    await drain(run.frames);
    run.sessionDurability();
    expect(seen.completedAsked).toEqual([false]);
  });

  it('yields only the mapped cancelled frames after the session frame when aborted before start', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('early'));
    const { adapter, seen } = harness({ events: [{ kind: 'text' }] });
    const run = adapter.start(request(), { abortController });
    expect(await drain(run.frames).then(kinds)).toEqual(['agent.session', 'cancelled']);
    expect(seen.eventsCalled).toBe(0);
    run.sessionDurability();
    expect(seen.completedAsked).toEqual([true]);
  });

  it('skips the cancelled branch when the plan has none', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('early'));
    const { adapter, seen } = harness({ events: [{ kind: 'text' }], cancelled: null });
    const run = adapter.start(request(), { abortController });
    expect(await drain(run.frames).then(kinds)).toEqual(['agent.session', 'text']);
    expect(seen.eventsCalled).toBe(1);
    run.sessionDurability();
    expect(seen.completedAsked).toEqual([false]);
  });

  it('interrupt() aborts the signal the plan was given with the run id', async () => {
    const { adapter, seen } = harness();
    const run = adapter.start(request());
    await run.interrupt();
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.signal?.reason).toEqual(new Error('run run-1 was interrupted'));
  });
});

describe('createEngineAdapter: a reported identity', () => {
  const reported: EngineRunIdentity = { kind: 'reported' };

  it('resolves from the first agent.session frame and yields no frame of its own', async () => {
    const { adapter } = harness({
      identity: reported,
      events: [{ kind: 'text' }, { kind: 'session', value: 'from-stream' }, { kind: 'done' }],
    });
    const run = adapter.start(request());
    expect(await drain(run.frames).then(kinds)).toEqual(['text', 'agent.session', 'done']);
    expect(await run.engineSessionId).toBe('from-stream');
  });

  it('rejects when the stream ends without a session frame', async () => {
    const { adapter } = harness({ identity: reported, events: [{ kind: 'text' }] });
    const run = adapter.start(request());
    await drain(run.frames);
    await expect(run.engineSessionId).rejects.toThrow(
      'the run ended without any frame carrying an engine session id, so this run has no session identity and cannot be resumed (spec §14.9).',
    );
  });

  it('rejects when the run is cancelled before any frame carried one', async () => {
    const abortController = new AbortController();
    abortController.abort(new Error('early'));
    const { adapter } = harness({ identity: reported });
    const run = adapter.start(request(), { abortController });
    await drain(run.frames);
    await expect(run.engineSessionId).rejects.toThrow('the run ended without any frame');
  });

  it('rejects with the stream failure and re-throws it', async () => {
    const { adapter } = harness({
      identity: reported,
      events: [{ kind: 'text' }],
      failWith: new Error('socket closed'),
    });
    const run = adapter.start(request());
    await expect(drain(run.frames)).rejects.toThrow('socket closed');
    await expect(run.engineSessionId).rejects.toThrow(
      'the run stream failed before any frame carried an engine session id: socket closed',
    );
  });

  it('renders a non-Error stream failure the way the claude adapter does', async () => {
    const { adapter } = harness({ identity: reported, failWith: 'socket closed' });
    const run = adapter.start(request());
    await expect(drain(run.frames)).rejects.toBe('socket closed');
    await expect(run.engineSessionId).rejects.toThrow(
      'the run stream failed before any frame carried an engine session id: non-Error thrown: socket closed',
    );
  });

  it('rejects when the consumer abandons the stream before any frame carried one', async () => {
    const { adapter } = harness({
      identity: reported,
      events: [{ kind: 'text' }, { kind: 'done' }],
    });
    const run = adapter.start(request());
    for await (const frame of run.frames) {
      expect(frame.frame).toBe('agent.native');
      break;
    }
    await expect(run.engineSessionId).rejects.toThrow('the run ended without any frame');
  });

  it('keeps the id it resolved when the stream fails later', async () => {
    const { adapter } = harness({
      identity: reported,
      events: [{ kind: 'session', value: 'early-id' }],
      failWith: new Error('late failure'),
    });
    const run = adapter.start(request());
    await expect(drain(run.frames)).rejects.toThrow('late failure');
    expect(await run.engineSessionId).toBe('early-id');
  });
});

describe('createEngineAdapter: compile and skills', () => {
  it('throws the startRun sentence for a request compile refuses', () => {
    const { adapter } = harness({ refuse: true });
    expect(() => adapter.start(request())).toThrow(
      'startRun: the arm is wrong. Call compile() first and act on its refusal.',
    );
  });

  it('refuses an outputSchema before compile unless the spec declares structuredOutput', () => {
    const outputSchema = { type: 'object' };
    const { adapter } = harness();
    const refused = adapter.compile(request({ outputSchema }));
    expect(refused).toMatchObject({ ok: false, code: 'engine_capability_unsupported' });
    expect(refused.ok ? '' : refused.reason).toContain('outputSchema');
    expect(adapter.compile(request())).toEqual({ ok: true, compiled: null });
    expect(harness({ structuredOutput: true }).adapter.compile(request({ outputSchema }))).toEqual({
      ok: true,
      compiled: null,
    });
  });

  it('start throws the compile-first sentence for an outputSchema it refuses', () => {
    const { adapter, seen } = harness();
    expect(() => adapter.start(request({ outputSchema: { type: 'object' } }))).toThrow(
      /^startRun: demo declares structuredOutput: false.* Call compile\(\) first and act on its refusal\.$/u,
    );
    expect(seen.eventsCalled).toBe(0);
  });

  it('passes the compile result through', () => {
    expect(harness().adapter.compile(request())).toEqual({ ok: true, compiled: null });
  });

  it('places skills under the config directory when the engine declares skills', () => {
    const { adapter } = harness();
    expect(adapter.placeSkills(request()).map((file) => file.path)).toEqual([
      '.demo/skills/writer/SKILL.md',
    ]);
  });

  it('places no skill when the engine declares skills: false', () => {
    const { adapter } = harness({
      capabilities: { ...ENGINE_CATALOGUE.pi.capabilities, skills: false },
    });
    expect(adapter.placeSkills(request())).toEqual([]);
  });

  it("uses the adapter's own placeSkills when it has one", () => {
    const { adapter } = harness({ placeSkills: () => [] });
    expect(adapter.placeSkills(request())).toEqual([]);
  });
});
