import {
  RUN_STATUS_EVENT,
  RUN_WARNING_EVENT,
  RunFailedFrameDataSchema,
  RunStatusEventDataSchema,
  RunWarningEventDataSchema,
  StreamResetFrameDataSchema,
  type RunFailedFrameData,
  type RunStatusEventData,
  type RunWarningEventData,
  type StreamResetFrameData,
} from '@indx-workspace/contracts/run-events';

import { IsoDateTimeSchema } from '@indx-workspace/contracts';

import { ContractViolationError } from '../errors.js';
import type { SseFrame } from './sse.js';

/**
 * One frame of a run's event stream, classified.
 *
 *   * `run-status`   — the platform's durable lifecycle event; `id` is a resume cursor.
 *   * `run-warning`  — a durable platform notice about the run (ADR-0146), such as
 *                      `attachments_removed_shell`; `id` is a resume cursor. Not an agent frame,
 *                      and not an outcome: show it and keep reading.
 *   * `runtime`      — a durable event the runtime produced; `id` is a resume cursor. Since ENG-03
 *                      (#302) `name` is one of `@indx-workspace/contracts`' `AGENT_FRAME_NAMES` and
 *                      `data` is that frame — one engine-neutral vocabulary, normalised by the
 *                      engine's adapter in the runner. `toAgentEvent` (`./agent-event.ts`) is the
 *                      parser that validates it; nothing else should read `data`.
 *   * `run-failed`   — this connection could not deliver a successful run (see the contract).
 *   * `stream-reset` — what follows is not contiguous with what the client already has.
 *   * `done`         — the stream is over. It says nothing about whether the run succeeded.
 *
 * `at` on the durable variants is when the control plane recorded the event, not when the
 * engine produced it. It is absent when the server sent none (a server before the `at:` field).
 *
 * `data` is left `unknown` here and validated by the parser rather than by this classifier, so that
 * the frame's *kind* and the frame's *payload* fail separately: a payload that does not satisfy its
 * schema must not make the stream unreadable for a consumer that only wanted the resume cursor.
 */
export type RunEventFrame =
  | {
      readonly kind: 'run-status';
      readonly id: string | null;
      readonly at?: string;
      readonly data: RunStatusEventData;
    }
  | {
      readonly kind: 'run-warning';
      readonly id: string | null;
      readonly at?: string;
      readonly data: RunWarningEventData;
    }
  | {
      readonly kind: 'runtime';
      readonly id: string | null;
      readonly at?: string;
      readonly name: string;
      readonly data: unknown;
    }
  | { readonly kind: 'run-failed'; readonly data: RunFailedFrameData }
  | { readonly kind: 'stream-reset'; readonly data: StreamResetFrameData }
  | { readonly kind: 'done' };

function refused(frame: SseFrame, issues: readonly { readonly message: string }[]): never {
  throw new ContractViolationError({
    operation: `runs.events(${frame.event})`,
    status: 200,
    issues: issues.map((issue) => issue.message),
  });
}

function stampOf(frame: SseFrame): { readonly at?: string } {
  if (frame.at === undefined) return {};
  const parsed = IsoDateTimeSchema.safeParse(frame.at);
  return parsed.success ? { at: parsed.data } : refused(frame, parsed.error.issues);
}

/**
 * Classify one parsed frame. Platform-owned frames are validated against their contract and a
 * malformed one is a {@link ContractViolationError} — the platform wrote it, so a mismatch is
 * drift, not user data. Relayed runtime events are passed through.
 */
export function classifyRunEventFrame(frame: SseFrame): RunEventFrame {
  switch (frame.event) {
    case 'done':
      return { kind: 'done' };
    case 'run-failed': {
      const parsed = RunFailedFrameDataSchema.safeParse(frame.data);
      return parsed.success
        ? { kind: 'run-failed', data: parsed.data }
        : refused(frame, parsed.error.issues);
    }
    case 'stream-reset': {
      const parsed = StreamResetFrameDataSchema.safeParse(frame.data);
      return parsed.success
        ? { kind: 'stream-reset', data: parsed.data }
        : refused(frame, parsed.error.issues);
    }
    case RUN_STATUS_EVENT: {
      const parsed = RunStatusEventDataSchema.safeParse(frame.data);
      return parsed.success
        ? { kind: 'run-status', id: frame.id, ...stampOf(frame), data: parsed.data }
        : refused(frame, parsed.error.issues);
    }
    case RUN_WARNING_EVENT: {
      const parsed = RunWarningEventDataSchema.safeParse(frame.data);
      return parsed.success
        ? { kind: 'run-warning', id: frame.id, ...stampOf(frame), data: parsed.data }
        : refused(frame, parsed.error.issues);
    }
    default:
      return {
        kind: 'runtime',
        id: frame.id,
        ...stampOf(frame),
        name: frame.event,
        data: frame.data,
      };
  }
}
