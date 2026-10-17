/**
 * Typed builders for the neutral `agent.*` frames (ENG-03 #302, ENG-04 #303).
 *
 * ENG-03 established the vocabulary and built the frames inside the Claude mapping. That works
 * for one engine; for the second it means every adapter re-derives two things it must not get
 * wrong — putting its own id on every frame, and capping the engine-native payload — and a
 * mistake in either is invisible until a consumer receives a frame with an empty `engine` or an
 * SSE writer tries to serialise a 40 MB tool result.
 *
 * So the port ships the builders. A **new** adapter names its engine **once**, at
 * {@link engineFrameBuilder}, and every frame after that carries the id and a capped `raw`
 * without the adapter spelling either out. The Claude adapter reaches them through
 * `packages/core`'s `toAgentFrames`, which is built on this builder and has to stay in `core` while
 * the control plane upgrades pre-ENG-03 rows with it; `core`'s `capAgentFrameRaw` is a re-export of
 * {@link capFrameRaw}. ADR-0070 D4 (amended by #958) records this.
 *
 * Unlike `packages/core`'s copy, this module imports the contract's own
 * {@link AGENT_FRAME_RAW_MAX_BYTES} and {@link AgentFrame} rather than restating them:
 * `packages/engine` is allowed to depend on `@indx-workspace/contracts`, which is the reason the
 * dependency is on the allow-list at all.
 */
import { AGENT_FRAME_RAW_MAX_BYTES, type AgentFrame } from '@indx-workspace/contracts/run-events';

/**
 * One neutral frame as the **port** carries it: the contract's frame with `engine` widened to a
 * string.
 *
 * The contract types `engine` as {@link import('@indx-workspace/contracts/engines').EngineId} —
 * the closed catalogue — which is right for a frame that has reached the wire and wrong for one
 * an adapter is building. Two reasons, and the second is the load-bearing one:
 *
 *   * the conformance kit's scripted double has an id the catalogue deliberately does not list,
 *     because a test engine is not a product decision;
 *   * an adapter under development, or one a deployment carries and this build of the contracts
 *     has not heard of, still has to produce frames. Refusing at the *type* would mean the only
 *     way to write an adapter is to edit `packages/contracts` first, which is the coupling the
 *     port exists to remove.
 *
 * The narrowing still happens, where it belongs: `AgentFrameSchema` parses what arrives at the
 * control plane, so an unregistered engine's frame is refused at ingestion by a validator rather
 * than by a compiler that cannot see the deployment.
 *
 * The conditional is written to distribute over the union (`T extends unknown ? … : never`) so
 * the result stays a discriminated union on `frame`; a plain `Omit<AgentFrame, 'engine'>` would
 * collapse it into one object type and every `frame === 'agent.session'` narrowing downstream
 * would stop working.
 */
type WidenFrameEngine<T> = T extends unknown
  ? Omit<T, 'engine'> & { readonly engine: string }
  : never;
export type EngineFrame = WidenFrameEngine<AgentFrame>;

/**
 * Cap one engine-native payload for carriage in a frame's `raw`. **Never throws.**
 *
 * Returns the value unchanged when it serialises to at most {@link AGENT_FRAME_RAW_MAX_BYTES}
 * bytes, and the contract's truncation marker otherwise. A payload over the cap is **truncated,
 * never rejected**: `raw` exists so nothing is lost, but the neutral fields beside it are the
 * part a consumer renders, and dropping the whole frame to protect the log would lose those too.
 *
 * `JSON.stringify` is the measure because it is what the SSE writer will run on the value. It
 * throws on a BigInt and a cycle, and returns `undefined` for `undefined`, a function and a
 * symbol — a payload that cannot be serialised cannot be carried at all, and the marker says so
 * with `encodedBytes: null` rather than letting the frame fail to render later.
 */
export function capFrameRaw(raw: unknown): unknown {
  const marker = (encodedBytes: number | null): unknown => ({
    truncated: true,
    encodedBytes,
    limitBytes: AGENT_FRAME_RAW_MAX_BYTES,
  });
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return marker(null);
  }
  if (typeof json !== 'string') return marker(null);
  // `TextEncoder`, not `Buffer`: this package has no `@types/node` and an adapter may be bundled
  // for a runtime that has no Buffer either.
  const bytes = new TextEncoder().encode(json).byteLength;
  return bytes <= AGENT_FRAME_RAW_MAX_BYTES ? raw : marker(bytes);
}

/** One frame, as an adapter writes it: everything but the two fields the builder fills in. */
type FrameBody<TName extends EngineFrame['frame']> = Omit<
  Extract<EngineFrame, { frame: TName }>,
  'engine' | 'raw'
>;

/**
 * The builder an adapter holds. One method per frame the neutral vocabulary has.
 *
 * Every method takes the engine-native message as its last argument rather than reading it off
 * the frame body, because `raw` and the neutral fields answer different questions and an adapter
 * that could pass the same object for both would eventually pass a *derived* value as `raw` — at
 * which point the escape hatch no longer contains what arrived.
 */
export type EngineFrameBuilder = {
  readonly engine: string;
  session(body: FrameBody<'agent.session'>, raw: unknown): EngineFrame;
  message(body: FrameBody<'agent.message'>, raw: unknown): EngineFrame;
  messageDelta(body: FrameBody<'agent.message.delta'>, raw: unknown): EngineFrame;
  toolCall(body: FrameBody<'agent.tool.call'>, raw: unknown): EngineFrame;
  toolResult(body: FrameBody<'agent.tool.result'>, raw: unknown): EngineFrame;
  usage(body: FrameBody<'agent.usage'>, raw: unknown): EngineFrame;
  result(body: FrameBody<'agent.result'>, raw: unknown): EngineFrame;
  /** `payload` is `raw`: `agent.native` *is* the engine-native message, uninterpreted. */
  native(type: string, raw: unknown): EngineFrame;
  malformed(reason: string, raw: unknown): EngineFrame;
};

/**
 * Build the frame builder for one engine.
 *
 * The id is captured once. That is the whole point: an adapter cannot forget to set `engine` on
 * the fourth frame of an eight-frame fan-out, because it never sets it at all.
 */
export function engineFrameBuilder(engine: string): EngineFrameBuilder {
  const base = (raw: unknown): { engine: string; raw: unknown } => ({
    engine,
    raw: capFrameRaw(raw),
  });
  return {
    engine,
    session: (body, raw) => ({ ...body, ...base(raw) }),
    message: (body, raw) => ({ ...body, ...base(raw) }),
    messageDelta: (body, raw) => ({ ...body, ...base(raw) }),
    toolCall: (body, raw) => ({ ...body, ...base(raw) }),
    toolResult: (body, raw) => ({ ...body, ...base(raw) }),
    usage: (body, raw) => ({ ...body, ...base(raw) }),
    result: (body, raw) => ({ ...body, ...base(raw) }),
    native: (type, raw) => {
      const capped = base(raw);
      return { frame: 'agent.native', ...capped, type, payload: capped.raw };
    },
    malformed: (reason, raw) => ({ frame: 'agent.malformed', ...base(raw), reason }),
  };
}
