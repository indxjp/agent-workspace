/** Pure SSE framing helpers for the `sse` transport probe: no I/O, no state. */

export interface ParsedSseFrame {
  readonly eventType: string;
  readonly data: string;
}

/**
 * Split the SSE frames out of `buffer`. Per the SSE spec a line ends with CRLF, LF or a lone CR
 * (sse-starlette sends CRLF), and a blank line ends a frame. A trailing CR is held back because
 * its LF may arrive in the next chunk. Returns the complete frames (LF-normalised) and the
 * unconsumed remainder to prepend to the next chunk.
 */
export function splitSseFrames(buffer: string): { frames: string[]; rest: string } {
  const heldBack = buffer.endsWith('\r') ? '\r' : '';
  const normalised = (heldBack === '' ? buffer : buffer.slice(0, -1)).replace(/\r\n?/g, '\n');
  const parts = normalised.split('\n\n');
  const rest = parts.pop() ?? '';
  return { frames: parts, rest: rest + heldBack };
}

/** The event type (default `message`) and joined `data:` lines of one frame; null when it has no data. */
export function parseSseFrame(frame: string): ParsedSseFrame | null {
  let eventType = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) eventType = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;
  return { eventType, data: dataLines.join('\n') };
}
