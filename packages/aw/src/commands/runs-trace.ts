import type { RunResource } from '@indx-workspace/contracts/runs';
import type { AgentEvent } from '@indx-workspace/sdk/events';

/** A neutral event with the time the control plane recorded it; `null` from an older server. */
export interface TimedEvent {
  readonly event: AgentEvent;
  readonly at: string | null;
}

interface TraceToolCall {
  readonly toolCallId: string;
  /** `null` for a result whose call the stream never announced. */
  readonly name: string | null;
  readonly kind: string | null;
  readonly input: unknown;
  /** `null` until a result arrives. */
  readonly status: 'completed' | 'failed' | null;
  readonly output: string | null;
  readonly isError: boolean | null;
  /** `null` when the call was not announced or the server stamped no time. */
  readonly calledAt: string | null;
  /** `null` until a result arrives, or when the server stamped no time. */
  readonly answeredAt: string | null;
}

interface TraceStep {
  /** The first frame of the step. */
  readonly at: string | null;
  readonly messageId: string | null;
  readonly text: string;
  readonly toolCalls: readonly TraceToolCall[];
}

export interface Trace {
  /** The run record: its `usage` and `cost` are the metered figures. */
  readonly run: RunResource;
  readonly steps: readonly TraceStep[];
  /**
   * The engine's own counters, summed over the `agent.usage` frames; informational. Engines report
   * them once per turn, right before `agent.result`, so they belong to the run, not to a step.
   */
  readonly engineUsage: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly result: {
    readonly stopReason: string;
    readonly turns: number | null;
    readonly engineCostUsd: number | null;
    readonly at: string | null;
  } | null;
}

const MAX_LINE = 200;

/**
 * Fold a run's neutral events into steps. The stream has no step or parent id, so a step is an
 * assistant message and a tool call belongs to the latest one (or to an unnamed first step when it
 * arrives before any message); a result pairs with its call by `toolCallId`.
 *
 * A total switch with a `never` default, like `stream.ts`: a frame added to the vocabulary stops
 * this compiling instead of silently dropping out of the trace.
 */
export function buildTrace(run: RunResource, timed: readonly TimedEvent[]): Trace {
  const steps: TraceStep[] = [];
  let result: Trace['result'] = null;

  const current = (at: string | null): TraceStep => {
    const last = steps.at(-1);
    if (last !== undefined) return last;
    const first: TraceStep = { at, messageId: null, text: '', toolCalls: [] };
    steps.push(first);
    return first;
  };
  const replace = (before: TraceStep, after: TraceStep): void => {
    steps[steps.indexOf(before)] = after;
  };

  for (const { event, at } of timed) {
    switch (event.frame) {
      case 'agent.message': {
        if (event.role !== 'assistant') break;
        const text = event.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []));
        const existing =
          event.messageId === null
            ? undefined
            : steps.find((step) => step.messageId === event.messageId);
        if (existing === undefined) {
          steps.push({ at, messageId: event.messageId, text: text.join('\n'), toolCalls: [] });
        } else replace(existing, { ...existing, text: text.join('\n') });
        break;
      }
      case 'agent.tool.call': {
        const step = current(at);
        replace(step, {
          ...step,
          toolCalls: [
            ...step.toolCalls,
            {
              toolCallId: event.toolCallId,
              name: event.name,
              kind: event.kind,
              input: event.input,
              status: null,
              output: null,
              isError: null,
              calledAt: at,
              answeredAt: null,
            },
          ],
        });
        break;
      }
      case 'agent.tool.result': {
        const answered = {
          status: event.status,
          output: event.output,
          isError: event.isError,
          answeredAt: at,
        };
        const owner = steps.find((step) =>
          step.toolCalls.some((call) => call.toolCallId === event.toolCallId),
        );
        if (owner === undefined) {
          const step = current(at);
          replace(step, {
            ...step,
            toolCalls: [
              ...step.toolCalls,
              {
                toolCallId: event.toolCallId,
                name: null,
                kind: null,
                input: undefined,
                calledAt: null,
                ...answered,
              },
            ],
          });
        } else {
          replace(owner, {
            ...owner,
            toolCalls: owner.toolCalls.map((call) =>
              call.toolCallId === event.toolCallId ? { ...call, ...answered } : call,
            ),
          });
        }
        break;
      }
      case 'agent.result':
        result = {
          stopReason: event.stopReason,
          turns: event.turns,
          engineCostUsd: event.engineCostUsd,
          at,
        };
        break;
      // Summed into the trace's `engineUsage` below.
      case 'agent.usage':
      case 'agent.session':
      case 'agent.message.delta':
      case 'agent.native':
      case 'agent.malformed':
      case 'agent.approval.requested':
      case 'agent.handoff':
        break;
      default:
        return unreachable(event);
    }
  }
  const usages = timed.flatMap(({ event }) => (event.frame === 'agent.usage' ? [event] : []));
  const engineUsage =
    usages.length === 0
      ? null
      : {
          inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
          outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
        };
  return { run, steps, engineUsage, result };
}

function unreachable(value: never): never {
  throw new Error(`unhandled event ${JSON.stringify(value)}`);
}

/** One line of at most {@link MAX_LINE} characters, for a human. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= MAX_LINE ? flat : `${flat.slice(0, MAX_LINE - 1)}…`;
}

interface Node {
  readonly line: string;
  readonly details: readonly string[];
  readonly children: readonly Node[];
}

function drawn(nodes: readonly Node[], prefix: string): string[] {
  return nodes.flatMap((node, index) => {
    const last = index === nodes.length - 1;
    const below = `${prefix}${last ? '   ' : '│  '}`;
    return [
      `${prefix}${last ? '└─ ' : '├─ '}${node.line}`,
      ...node.details.map((detail) => `${below}   ${detail}`),
      ...drawn(node.children, below),
    ];
  });
}

const epochMs = (at: string | null): number | null => {
  const ms = at === null ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
};

/** ` +12.4s` from `origin`, or nothing when either end carries no time. */
function offset(origin: number | null, at: string | null): string {
  const ms = epochMs(at);
  if (origin === null || ms === null) return '';
  const delta = ms - origin;
  return ` ${delta < 0 ? '-' : '+'}${(Math.abs(delta) / 1000).toFixed(1)}s`;
}

/** ` 812ms` between a tool's call and its result, or nothing when either carries no time. */
function toolDuration(call: TraceToolCall): string {
  const from = epochMs(call.calledAt);
  const to = epochMs(call.answeredAt);
  return from === null || to === null ? '' : ` ${String(Math.max(0, to - from))}ms`;
}

function toolNode(call: TraceToolCall, origin: number | null): Node {
  const status = call.status === null ? 'no result' : call.status;
  const head =
    call.name === null
      ? `(no call) ${call.toolCallId}`
      : `${call.name}${call.kind === null ? '' : ` (${call.kind})`}`;
  return {
    line: `${head} ${status}${call.isError === true ? ' (error)' : ''}${offset(origin, call.calledAt ?? call.answeredAt)}${toolDuration(call)}`,
    details: [
      ...(call.name === null ? [] : [`input: ${oneLine(JSON.stringify(call.input) ?? 'null')}`]),
      ...(call.output === null ? [] : [`output: ${oneLine(call.output)}`]),
    ],
    children: [],
  };
}

/**
 * A run's accounted cost for a person. Settled usage with no price table version is captured usage
 * the price table has no price for, not a real zero (BH061-074), so it is not shown as `0.000000`.
 */
export function costText(run: RunResource): string {
  if (run.cost.priceTableVersion === null && run.accountingState !== 'pending') {
    return 'unpriced (no price for this model)';
  }
  return `${run.cost.amount} ${run.cost.currency}`;
}

function runLine(run: RunResource): string {
  const parts = [`run ${run.id}`, run.status];
  if (run.durationMs !== null) parts.push(`${String(run.durationMs)}ms`);
  parts.push(`tokens=${String(run.usage.totalTokens)}`);
  parts.push(`cost=${costText(run)}`);
  if (run.accountingState !== 'complete') parts.push(`(accounting ${run.accountingState})`);
  return parts.join(' ');
}

/** The tree as lines: the run, then its steps with their tool calls, then the engine's result. */
export function renderTrace(trace: Trace): string[] {
  // Offsets count from the run's start, else from the first stamped event.
  const origin =
    epochMs(trace.run.startedAt) ??
    epochMs(
      trace.steps
        .flatMap((step) => [step.at, ...step.toolCalls.flatMap((c) => [c.calledAt, c.answeredAt])])
        .concat(trace.result?.at ?? null)
        .find((at) => epochMs(at) !== null) ?? null,
    );
  const steps: Node[] = trace.steps.map((step, index) => {
    const text = oneLine(step.text);
    return {
      line: `step ${String(index + 1)}${offset(origin, step.at)}${text === '' ? '' : `: ${text}`}`,
      details: [],
      children: step.toolCalls.map((call) => toolNode(call, origin)),
    };
  });
  const { engineUsage, result } = trace;
  const end: Node[] =
    result === null
      ? []
      : [
          {
            line: [
              `result stop=${result.stopReason}${offset(origin, result.at)}`,
              ...(result.turns === null ? [] : [`turns=${String(result.turns)}`]),
              ...(engineUsage === null
                ? []
                : [
                    `engine-tokens=${String(engineUsage.inputTokens)}/${String(engineUsage.outputTokens)}`,
                  ]),
              ...(result.engineCostUsd === null
                ? []
                : [`engine-cost=$${result.engineCostUsd.toFixed(4)} (estimate)`]),
            ].join(' '),
            details: [],
            children: [],
          },
        ];
  return [runLine(trace.run), ...drawn([...steps, ...end], '')];
}
