/**
 * The Claude Agent SDK's event stream and its mapping onto the neutral frames. Lives in the run
 * protocol rather than the Claude adapter because the control plane runs the same mapping over
 * pre-ENG-03 rows (#958); ADR-0070 Deviation 2 records the move out of core.
 */
import { capFrameRaw, engineFrameBuilder, type EngineFrameBuilder } from '@agent-workspace/engine';
import { DEFAULT_ENGINE_ID } from '@indx-workspace/contracts/engines';

import { describe } from './describe.js';
import {
  sdkResultSubtypes,
  sdkSystemSubtypes,
  sdkEventTypes,
  type AgentFrame,
  type AgentMessageBlock,
  type AgentStopReason,
  type AgentToolKind,
  type AgentUsageFrame,
  type ClassifiedSdkEvent,
  type RunCostVerdict,
  type SdkEventEnvelope,
  type SdkEventType,
  type SdkModelUsage,
  type SdkResultSubtype,
  type SdkSystemSubtype,
} from './types.js';

/** The prefix of every MCP tool name; `claudeToolKind` classifies on it. */
const MCP_PREFIX = 'mcp__';

// ── The event stream (R-01 §4) ──────────────────────────────────────────────────────────

const SYSTEM_SUBTYPES: ReadonlySet<string> = new Set(sdkSystemSubtypes);
const RESULT_SUBTYPES: ReadonlySet<string> = new Set(sdkResultSubtypes);
const EVENT_TYPES: ReadonlySet<string> = new Set(sdkEventTypes);

/**
 * Classify one raw event off the SDK's iterator. **Never throws.**
 *
 * R-01 §4's implementer rule, implemented: discriminate on `type`, then on `subtype` for
 * `system` and `result`, and keep a default branch that forwards an unrecognised discriminant
 * opaquely — *"the subtype set grows in patch releases"*, and probe 2 already received a
 * `system/thinking_tokens` message from a run that set no thinking options.
 *
 * The ADR-0015 distinction this function exists to make: **"unknown" and "malformed" are not
 * the same answer.** An unrecognised `type` or `subtype` on a well-formed envelope is expected
 * and is forwarded. An event that is not an object, or whose discriminant is not a string, is
 * *rejected by name* — it never reaches the opaque-forward path, because falling through to a
 * forward on malformed input is a gate deciding on the absence of a negative.
 */
export function classifySdkEvent(raw: unknown): ClassifiedSdkEvent {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      kind: 'malformed',
      reason: `an SDK event must be an object; got ${describe(raw)}`,
      event: raw,
    };
  }
  const record = raw as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string') {
    return {
      kind: 'malformed',
      reason: `an SDK event must carry a string 'type'; got ${describe(type)}`,
      event: raw,
    };
  }
  if (type === '') {
    // An empty `type` names nothing. Forwarded opaquely it would become an `agent.native` frame
    // whose `type` the contract refuses (`min(1)`), which is a dropped message by another route —
    // so it is refused here, by name, like any other discriminant that is not one.
    return {
      kind: 'malformed',
      reason: `an SDK event must carry a non-empty 'type'; got ${describe(type)}`,
      event: raw,
    };
  }
  const event = record as SdkEventEnvelope;

  if (type === 'system' || type === 'result') {
    const subtype = record['subtype'];
    if (typeof subtype !== 'string') {
      return {
        kind: 'malformed',
        reason: `a '${type}' event must carry a string 'subtype'; got ${describe(subtype)}`,
        event: raw,
      };
    }
    if (type === 'system') {
      return SYSTEM_SUBTYPES.has(subtype)
        ? { kind: 'system', subtype: subtype as SdkSystemSubtype, event }
        : { kind: 'system-unknown', subtype, event };
    }
    return RESULT_SUBTYPES.has(subtype)
      ? { kind: 'result', subtype: subtype as SdkResultSubtype, carriesUsage: true, event }
      : { kind: 'result-unknown', subtype, carriesUsage: true, event };
  }

  if (EVENT_TYPES.has(type)) {
    return { kind: 'event', type: type as Exclude<SdkEventType, 'system' | 'result'>, event };
  }
  return { kind: 'unknown', type, event };
}

/**
 * Decide whether one `ModelUsage` row may be presented to a user as money (spec §12).
 *
 * R-01 §4: `costBasis: 'unknown'` means no pricing row matched the model id and `costUSD` is a
 * guess at the default model's rate; an absent `costBasis` is to be read as `'list'`. Anything
 * else — including a `costUSD` that is not a finite number — is unpriced with a reason. Note
 * that `NaN` is parsed for before it is compared: `NaN >= 0` is `false`, so a guard written the
 * other way round would have let it through.
 */
export function classifyRunCost(usage: unknown): RunCostVerdict {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    return { priced: false, reason: `usage must be an object; got ${describe(usage)}` };
  }
  const record = usage as Partial<SdkModelUsage>;
  const basis = record.costBasis ?? 'list';
  if (basis === 'unknown') {
    return {
      priced: false,
      reason:
        "costBasis is 'unknown': no pricing row matched this model id, so costUSD is a guess at the default model's rate (R-01 §4). Show the run as unpriced, never as a number.",
    };
  }
  if (basis !== 'list' && basis !== 'managed') {
    return {
      priced: false,
      reason: `unrecognised costBasis ${describe(basis)}; treat the run as unpriced.`,
    };
  }
  const cost = record.costUSD;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
    return {
      priced: false,
      reason: `costUSD must be a finite non-negative number; got ${describe(cost)}`,
    };
  }
  return { priced: true, costUsd: cost, basis };
}

// ── The Claude Agent SDK → neutral frames mapping (ENG-03, #302) ─────────────────────────

/** The Claude engine's id, as the frames this module produces name it. */
export const CLAUDE_AGENT_SDK_ENGINE = DEFAULT_ENGINE_ID;

/**
 * Which ACP tool kind each Claude Agent SDK built-in tool has.
 *
 * Only tools whose effect is *known* appear. Everything else — including a tool this build has not
 * heard of — is `other`, which is the honest answer rather than a default that would present an
 * unmapped `Bash`-like tool as harmless. `mcp__…` is decided by its prefix, not by this table,
 * because a connector's tool names are the tenant's.
 *
 * `delete` and `move` are in the neutral vocabulary (ACP has them) and no Claude built-in maps onto
 * them: the SDK deletes and moves through `Bash`, which is an `execute`. Naming them here anyway
 * would claim a fidelity the SDK does not offer.
 */
const CLAUDE_TOOL_KINDS: Readonly<Record<string, AgentToolKind>> = {
  Read: 'read',
  NotebookRead: 'read',
  Write: 'edit',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Glob: 'search',
  Grep: 'search',
  WebSearch: 'search',
  WebFetch: 'fetch',
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  KillBash: 'execute',
};

/** The ACP kind of one Claude tool name. Never throws, and never guesses anything but `other`. */
export function claudeToolKind(name: string): AgentToolKind {
  if (name.startsWith(MCP_PREFIX)) return 'mcp';
  return CLAUDE_TOOL_KINDS[name] ?? 'other';
}

/**
 * The neutral stop reason for one `result` subtype.
 *
 * `error_max_structured_output_retries` is an `error`, not its own reason: it is the SDK failing to
 * get a parseable answer, which is a failure of the turn and not a limit the platform set. An
 * unrecognised subtype is also an `error` — R-01 §4 records that the set grows in patch releases,
 * and a subtype this build cannot name is a turn whose outcome it cannot claim went well.
 *
 * `refusal` and `cancelled` are in the neutral set and are not produced here: the SDK reports a
 * refusal as a `system` message rather than a result (so it reaches `agent.native`), and a
 * cancellation is the control plane's own transition, recorded as `run.status`.
 */
function claudeStopReason(subtype: string): AgentStopReason {
  switch (subtype) {
    case 'success':
      return 'end_turn';
    case 'error_max_turns':
      return 'max_turns';
    case 'error_max_budget_usd':
      return 'max_budget';
    default:
      return 'error';
  }
}

/**
 * The answer a successful result carries (ADR-0143): its text, and the SDK's `structured_output`
 * when the request asked for a schema (`null` otherwise). A result that is not a success has no
 * answer, so it gets no `output`.
 */
function claudeResultOutput(
  subtype: string,
  result: Readonly<Record<string, unknown>>,
): { readonly output?: { readonly text: string; readonly structured: unknown } } {
  const text = result['result'];
  if (subtype !== 'success' || typeof text !== 'string') return {};
  return { output: { text, structured: result['structured_output'] ?? null } };
}

/** The largest engine-native payload one frame's `raw` may carry, in UTF-8 bytes. */
export { AGENT_FRAME_RAW_MAX_BYTES } from '@indx-workspace/contracts/run-events';

/**
 * Cap one engine-native payload for carriage in a frame's `raw` (never throws; an oversized or
 * unserialisable payload becomes the contract's truncation marker). The port's `capFrameRaw` is
 * the one implementation (ADR-0070 D4, amended by #958); this name stays for
 * `apps/web/server/runs/` and the contract's documentation.
 */
export { capFrameRaw as capAgentFrameRaw } from '@agent-workspace/engine';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * The Claude CLI appends its own notes to the model (`<system-reminder>…</system-reminder>`) to
 * some tool results. They are not the tool's output, so a trace never shows them (BH061-062).
 */
const SYSTEM_REMINDER = /\n*<system-reminder>[\s\S]*?<\/system-reminder>\n*/gu;

/**
 * A tool result's `content` as one string: a string as itself, blocks by their text parts, with
 * the CLI's system reminders left out.
 */
function flattenToolOutput(content: unknown): string {
  if (typeof content === 'string') return content.replace(SYSTEM_REMINDER, '');
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part): string[] => {
      const block = asRecord(part);
      const text = block?.['text'];
      return block?.['type'] === 'text' && typeof text === 'string' ? [text] : [];
    })
    .join('\n')
    .replace(SYSTEM_REMINDER, '');
}

/** The prose blocks of one Messages-API `content`, in the order the model returned them. */
function proseBlocks(content: unknown): readonly AgentMessageBlock[] {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): AgentMessageBlock[] => {
    const block = asRecord(value);
    const type = block === null ? null : block['type'];
    const text = block?.['text'];
    if (type === 'text' && typeof text === 'string') return [{ type: 'text', text }];
    // `thinking` is the Messages API's name for the model's reasoning; the neutral vocabulary
    // calls it `reasoning` because that is what every engine's version of it is.
    if (type === 'thinking') {
      const thinking = block?.['thinking'];
      if (typeof thinking === 'string') return [{ type: 'reasoning', text: thinking }];
    }
    return [];
  });
}

/**
 * Sum the `modelUsage` records of one `result` message.
 *
 * R-01 §4's three traps are respected: `thinkingTokens` is *already inside* `outputTokens`, so it
 * is reported as `reasoningTokens` and never added again; the record key is unstable, so every
 * entry is summed rather than one being picked; and results are cumulative within a `query()` call,
 * so this reads the latest message rather than accumulating across them.
 *
 * `null` when no entry is readable — an engine that reported nothing is not an engine that
 * reported zero.
 */
function claudeUsage(
  envelope: SdkEventEnvelope,
): Omit<AgentUsageFrame, 'frame' | 'engine' | 'raw'> | null {
  const modelUsage = asRecord(envelope['modelUsage']);
  if (modelUsage === null) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead: number | null = null;
  let cacheCreation: number | null = null;
  let reasoning: number | null = null;
  let entries = 0;
  for (const value of Object.values(modelUsage)) {
    const usage = asRecord(value);
    if (usage === null) continue;
    const input = asCount(usage['inputTokens']);
    const output = asCount(usage['outputTokens']);
    if (input === null || output === null) continue;
    entries += 1;
    inputTokens += input;
    outputTokens += output;
    const read = asCount(usage['cacheReadInputTokens']);
    if (read !== null) cacheRead = (cacheRead ?? 0) + read;
    const creation = asCount(usage['cacheCreationInputTokens']);
    if (creation !== null) cacheCreation = (cacheCreation ?? 0) + creation;
    const thinking = asCount(usage['thinkingTokens']);
    if (thinking !== null) reasoning = (reasoning ?? 0) + thinking;
  }
  if (entries === 0) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    reasoningTokens: reasoning,
  };
}

/** The tool-use and tool-result frames one message's `content` carries, in the model's order. */
function toolFrames(
  role: 'assistant' | 'user',
  content: unknown,
  b: EngineFrameBuilder,
  raw: unknown,
): AgentFrame[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((value): AgentFrame[] => {
    const block = asRecord(value);
    if (block === null) return [];
    if (role === 'assistant' && block['type'] === 'tool_use') {
      const toolCallId = asNonEmptyString(block['id']);
      const name = asNonEmptyString(block['name']);
      if (toolCallId === null || name === null) return [];
      return [
        b.toolCall(
          {
            frame: 'agent.tool.call',
            toolCallId,
            name,
            kind: claudeToolKind(name),
            // The contract's `input` key is always present on the wire, and JSON has no spelling
            // for `undefined`: a `tool_use` block without an input is sent as `null`.
            input: block['input'] ?? null,
          },
          raw,
        ),
      ];
    }
    if (role === 'user' && block['type'] === 'tool_result') {
      const toolCallId = asNonEmptyString(block['tool_use_id']);
      if (toolCallId === null) return [];
      // `status` is whether the call ran, `isError` the engine's verdict on its answer. The Claude
      // SDK delivers a result block for both, so a delivered block always ran to completion.
      return [
        b.toolResult(
          {
            frame: 'agent.tool.result',
            toolCallId,
            status: 'completed',
            output: flattenToolOutput(block['content']),
            isError: block['is_error'] === true,
          },
          raw,
        ),
      ];
    }
    return [];
  });
}

/**
 * The name `agent.native` gives one classified event, so the engine's own word for the message
 * survives in a field a consumer can branch on.
 */
function nativeName(event: ClassifiedSdkEvent): string {
  switch (event.kind) {
    case 'system':
    case 'system-unknown':
      return `system/${event.subtype}`;
    case 'result':
    case 'result-unknown':
      return `result/${event.subtype}`;
    case 'event':
    case 'unknown':
      return event.type;
    case 'malformed':
      return 'malformed';
    default: {
      const unhandled: never = event;
      return `unclassified/${String(unhandled)}`;
    }
  }
}

/**
 * Map one classified Claude Agent SDK message onto the neutral `agent.*` frames (ADR-0065 D5,
 * `docs/sdk/04-api-specification.md` §6.3). **Pure, and never throws.**
 *
 * This is the one place the Claude vocabulary is read. It is the function the runner calls on a
 * live event and the function `apps/web/server/runs/` calls to upgrade a `run_events` row recorded
 * before ENG-03, which is why it lives beside {@link classifySdkEvent} rather than in either
 * application — and it is what ENG-04 (#303) moves into `packages/engine-claude-agent-sdk`.
 *
 * Two guarantees, both tested and both proved in `formal/AgentWorkspace/Events/AgentFrames.lean`:
 *
 *   1. **Nothing is dropped.** The returned list is never empty. A message with no neutral meaning
 *      becomes `agent.native`, and one that could not be parsed becomes `agent.malformed`; there is
 *      no path that returns `[]` for an event that arrived.
 *   2. **Tool results are paired.** A `tool_result` block only ever rides on a `user` message and a
 *      `tool_use` block only on an `assistant` one, so within a run the `agent.tool.call` naming a
 *      `toolCallId` always precedes the `agent.tool.result` that answers it.
 *
 * Every frame is built through the port's `engineFrameBuilder` (ADR-0070 D4, amended by #958), so
 * `engine` and the capped `raw` are set by the one implementation every adapter shares. `raw`
 * carries the engine-native message, capped by {@link capAgentFrameRaw}: a tenant's agent chooses
 * how large a tool result is, and `raw` is the one field it can make arbitrarily big.
 */
export function toAgentFrames(
  event: ClassifiedSdkEvent,
  engine: string = CLAUDE_AGENT_SDK_ENGINE,
): readonly AgentFrame[] {
  // The engine-native message, whatever it turned out to be — `unknown` on the `malformed` arm,
  // which is exactly the case where a consumer most wants to see what arrived.
  //
  // Every frame of the message carries it, not only the first. That multiplies storage for a
  // message that fans out (each frame is a `run_events` row, bounded by the cap per copy), and it
  // is deliberate: a frame is read on its own — by a consumer that resumed inside a message, by one
  // that only reads `agent.result`, by the upgraded legacy path — and a frame whose engine-native
  // source lived on a sibling it may never see would make `raw` an escape hatch that only works
  // sometimes. `docs/sdk/04-api-specification.md` §6.3 states the cost.
  const b = engineFrameBuilder(engine);
  // Capped once per event: the builder caps again per frame, which is then cheap (≤ 64 KiB, or
  // the marker) instead of re-serialising an arbitrarily large message once per fan-out frame.
  const raw = capFrameRaw(event.event);

  if (event.kind === 'malformed') return [b.malformed(event.reason, raw)];

  // `payload` is `raw` on this frame (the builder sets both): `agent.native` *is* "the
  // engine-native message, uninterpreted", so its own field and the uniform escape hatch name the
  // same value. A consumer branching on `frame === 'agent.native'` reads `payload`; one walking
  // every frame uniformly reads `raw`; neither has to know about the other.
  const native = (): readonly AgentFrame[] => [b.native(nativeName(event), raw)];

  if (event.kind === 'system') {
    if (event.subtype !== 'init') return native();
    const engineSessionId = asNonEmptyString(event.event['session_id']);
    // A `system/init` without a session id is not a session: it is an init message this build
    // cannot read, and claiming a session from it would put an empty id into `sessions`.
    if (engineSessionId === null) return native();
    return [
      b.session(
        {
          frame: 'agent.session',
          engineSessionId,
          model: asNonEmptyString(event.event['model']),
        },
        raw,
      ),
    ];
  }

  if (event.kind === 'result' || event.kind === 'result-unknown') {
    const usage = claudeUsage(event.event);
    const cost = event.event['total_cost_usd'];
    const turns = asCount(event.event['num_turns']);
    const frames: AgentFrame[] = [];
    if (usage !== null) frames.push(b.usage({ frame: 'agent.usage', ...usage }, raw));
    frames.push(
      b.result(
        {
          frame: 'agent.result',
          stopReason: claudeStopReason(event.subtype),
          turns,
          engineCostUsd:
            typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
          ...claudeResultOutput(event.subtype, event.event),
        },
        raw,
      ),
    );
    return frames;
  }

  if (event.kind === 'event' && (event.type === 'assistant' || event.type === 'user')) {
    const role = event.type;
    const message = asRecord(event.event['message']);
    if (message === null) return native();
    const content = message['content'];
    const blocks = proseBlocks(content);
    const frames: AgentFrame[] = [];
    if (blocks.length > 0) {
      frames.push(
        b.message(
          {
            frame: 'agent.message',
            // An assistant turn is identified by the model's message id, which repeats when the
            // SDK re-sends a grown snapshot; a user turn has no message id of its own, so the
            // SDK's per-message `uuid` is the only stable handle on it.
            messageId: asNonEmptyString(role === 'assistant' ? message['id'] : event.event['uuid']),
            role,
            blocks,
          },
          raw,
        ),
      );
    }
    frames.push(...toolFrames(role, content, b, raw));
    // A message that carried neither prose nor a tool block — an image-only turn, say — still
    // happened. `agent.native` is what keeps it in the log instead of returning nothing.
    return frames.length > 0 ? frames : native();
  }

  return native();
}
