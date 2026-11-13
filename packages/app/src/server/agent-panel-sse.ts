/**
 * The agent panel's event stream (issue #1509): the frames `client.runs.follow` yields, written
 * back out as the platform's own `text/event-stream`, so the panel reads them with the SDK's
 * `readSseFrames` and `classifyRunEventFrame` exactly as it would read the platform.
 *
 * It is written through the app kit's one SSE writer (`./sse.ts`), which restates the platform's
 * four rules. Rule 4 is this stream's own: `done` is written only when the platform's stream ended
 * with `done`, and the platform has already written any `run-failed` before it. When following
 * failed, the outcome is unknown to this connection: `run-failed` with status `unknown` is written
 * and `done` is not, so the panel reconnects with `Last-Event-ID`.
 *
 * Durable frames keep their `id:` and `at:`, so the panel's resume cursor is the platform's.
 */
import { RUN_STATUS_EVENT, RUN_WARNING_EVENT } from '@indx-workspace/contracts/run-events';
import type { RunEventFrame } from '@indx-workspace/sdk/events';

import { SSE_HEADERS, sseControlFrame, sseEventFrame, sseResponse } from './sse.js';

/** The three response headers of the stream, and only these: the app kit's SSE headers. */
export const PANEL_SSE_HEADERS = SSE_HEADERS;

const STREAM_FAILED = 'The event stream ended unexpectedly.';

/** One classified frame as wire text, or `null` for one that is not written. */
function panelFrame(frame: RunEventFrame): string | null {
  switch (frame.kind) {
    case 'done':
      return sseControlFrame('done', {});
    case 'run-failed':
      return sseControlFrame('run-failed', frame.data);
    case 'stream-reset':
      return sseControlFrame('stream-reset', frame.data);
    case 'run-status':
      return sseEventFrame(RUN_STATUS_EVENT, frame.id, frame.at, frame.data);
    case 'run-warning':
      return sseEventFrame(RUN_WARNING_EVENT, frame.id, frame.at, frame.data);
    case 'runtime':
      return sseEventFrame(frame.name, frame.id, frame.at, frame.data);
    default: {
      const unhandled: never = frame;
      void unhandled;
      return null;
    }
  }
}

/**
 * The streaming answer of `frames`: `retry:`, then each frame as it arrives, with a keep-alive
 * comment every 15 s. Aborting `abort` (the request's disconnect) stops following.
 */
export function panelSseResponse(
  frames: AsyncIterable<RunEventFrame>,
  abort: AbortController,
): Response {
  return sseResponse(
    async (writer) => {
      for await (const frame of frames) {
        if (writer.closed) return;
        if (frame.kind === 'done') break;
        const text = panelFrame(frame);
        if (text !== null) writer.write(text);
      }
      writer.write(sseControlFrame('done', {}));
    },
    {
      // Rule 2 and rule 4: in-band, with no `done`, and never the failure's own words.
      onFailure: (writer) =>
        writer.write(sseControlFrame('run-failed', { status: 'unknown', message: STREAM_FAILED })),
      onCancel: () => abort.abort(),
    },
  );
}
